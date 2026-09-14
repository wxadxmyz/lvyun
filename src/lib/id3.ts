import { open, SeekMode, mkdir, remove } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import { convertFileSrc } from '@tauri-apps/api/core';

/**
 * v2.3.11 #6b：轻量 ID3 标签解析（自研，零依赖）
 *
 * 为什么自己写而不是引第三方库：
 *   常见的 music-metadata / jsmediatags 体积都在百 KB 量级，而律云需要的只是
 *   歌名 / 歌手 / 专辑 / 年份 / 时长这几项，为它多背一个重依赖不划算。
 *   这里只解析 ID3v2 的文本帧（TIT2/TPE1/TALB/TDRC/TYER）+ ID3v1 兜底，
 *   纯字符串操作，几十行搞定。
 *
 * v2.4.0 #D1：新增 APIC（封面）帧解析。
 *   封面是二进制大块（常 100KB~1MB），不塞进 localStorage（会撑爆 5~10MB 配额），
 *   而是落盘到 App 数据目录 `$APPDATA/covers/<coverId>.<ext>`，曲库存「文件路径」。
 *   渲染时经 convertFileSrc 转成 WebView 可直接加载的本地 asset URL。
 *   落盘失败（权限不足 / 目录不存在 / 非音频）不会崩溃，降级为「不显示封面」
 *   （console.warn 兜底），保证扫描流程永远不卡死。
 *
 * 内存策略：封面往往占据帧区绝大部分体积，因此这里只读文件头 64KB；
 * 若 APIC 帧数据超出已读缓冲，再针对该帧单独 seek + 读取，避免整首音频入内存。
 */

const HEAD_BYTES = 64 * 1024; // 覆盖绝大多数含封面的标签区
const MAX_FRAME_SPAN = 60 * 1024; // 单帧合理上限，防脏数据撑爆内存
const MAX_COVER_BYTES = 4 * 1024 * 1024; // 单张封面落盘上限，防极端大帧写爆磁盘

export interface AudioTags {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  /** 秒；来自 ID3v2 TLEN 或 MP3 码率估算，拿不到则为 undefined */
  duration?: number;
}

/** 单文件解析结果：文本标签 + 命中封面的本地 asset URL（无封面为 undefined） */
export interface TagResult {
  tags: AudioTags;
  cover?: string;
}

/** 解析出的封面帧位置信息（偏移均为文件偏移，落盘时据此读取二进制） */
interface CoverHint {
  picStart: number;
  picLen: number;
  ext: string;
  /** APIC picture type：0x03 = 前置封面，优先采用 */
  picType?: number;
}

/** UTF-16 解码时清掉 BOM 与散落的空字符 */
function tidy(s: string): string {
  return s.replace(/\u0000/g, '').replace(/^\uFEFF/, '').trim();
}

/** 从 ID3 帧体的编码字节开始解出文本 */
function decodeFrame(bytes: Uint8Array, start: number, end: number): string {
  if (start >= end) return '';
  const enc = bytes[start];
  const p = start + 1; // 跳过编码字节
  const body = bytes.subarray(p, end);
  try {
    switch (enc) {
      case 0: // ISO-8859-1（实际多为 ASCII，用 latin1 保底）
        return tidy(new TextDecoder('latin1').decode(body));
      case 1: // UTF-16 带 BOM
        return tidy(new TextDecoder('utf-16').decode(body));
      case 2: // UTF-16BE 无 BOM
        return tidy(new TextDecoder('utf-16be').decode(body));
      case 3: // UTF-8
        return tidy(new TextDecoder('utf-8').decode(body));
      default:
        return '';
    }
  } catch {
    return '';
  }
}

/** 同步安全整数（ID3 用 4 个 7-bit 字节表示长度） */
function syncSafe(b: Uint8Array, o: number): number {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

/** 普通大端 32 位（ID3v2.2 的帧长不是 syncsafe） */
function be32(b: Uint8Array, o: number): number {
  return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
}

/** MIME 类型 → 文件扩展名（不带点），未知统一兜底 jpg（APIC 绝大多数为 jpeg） */
function mimeToExt(mime: string): string {
  const m = mime.toLowerCase().trim();
  if (!m) return 'jpg';
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/bmp': 'bmp', 'image/x-bmp': 'bmp', 'image/x-ms-bmp': 'bmp',
    'image/webp': 'webp',
    'image/tiff': 'tif', 'image/x-tiff': 'tif',
    'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
    'image/avif': 'avif',
    'image/heic': 'heic', 'image/heif': 'heif',
    'image/x-pcx': 'pcx', 'image/x-targa': 'tga', 'image/tga': 'tga',
  };
  return map[m] || 'jpg';
}

/** UTF-8 安全的 base64url（无填充），用作文件名，文件系安全 */
function utf8ToBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 由曲目稳定 id 推导封面文件名（不含扩展名）。
 * 用 id 而非路径，是因为曲库项只持有 id；移除时也能凭 id 精确反查。
 */
export function getCoverId(seed: string): string {
  return utf8ToBase64Url(seed);
}

/** 跳过 APIC/PIC 的描述字段（null 结尾，编码相关：UTF-16 为双字节 0x0000） */
function skipDescription(bytes: Uint8Array, start: number, end: number, enc: number): number {
  if (enc === 1 || enc === 2) {
    let i = start;
    while (i + 1 < end && !(bytes[i] === 0 && bytes[i + 1] === 0)) i += 2;
    return i + 2;
  }
  let i = start;
  while (i < end && bytes[i] !== 0) i++;
  return i + 1;
}

/**
 * 解析单个 APIC（v2.3/4）或 PIC（v2.2）帧体，返回封面数据的文件偏移与长度。
 * 只在帧头里算偏移，不把图片二进制读进内存 —— 真正读图在 readPicture 里按需进行。
 */
function parseApic(bytes: Uint8Array, start: number, end: number, v2_2: boolean): CoverHint | null {
  if (v2_2) {
    // PIC：encoding(1) + format(3) + pictureType(1) + description + data
    const enc = bytes[start];
    const fmt = new TextDecoder('latin1')
      .decode(bytes.subarray(start + 1, Math.min(start + 4, end)))
      .trim()
      .toLowerCase();
    const picType = bytes[start + 4];
    const descEnd = skipDescription(bytes, start + 5, end, enc);
    const picStart = descEnd;
    const picLen = end - picStart;
    if (picLen <= 0) return null;
    const ext = /^[a-z0-9]{2,4}$/.test(fmt) ? fmt : 'jpg';
    return { picStart, picLen, ext, picType };
  }
  // APIC：encoding(1) + mime(null-term) + pictureType(1) + description(null-term) + data
  const enc = bytes[start];
  let mimeEnd = start + 1;
  while (mimeEnd < end && bytes[mimeEnd] !== 0) mimeEnd++;
  const mime = new TextDecoder('latin1').decode(bytes.subarray(start + 1, mimeEnd));
  const picType = bytes[mimeEnd + 1];
  const descEnd = skipDescription(bytes, mimeEnd + 2, end, enc);
  const picStart = descEnd;
  const picLen = end - picStart;
  if (picLen <= 0) return null;
  return { picStart, picLen, ext: mimeToExt(mime), picType };
}

/** 解析 ID3v2 头（若存在），同时收集文本标签与首个封面帧位置 */
function parseId3v2(bytes: Uint8Array): { tags: AudioTags; cover: CoverHint | null } | null {
  if (bytes.length < 10) return null;
  // "ID3"
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;

  const ver = bytes[3];
  const size = syncSafe(bytes, 6); // 标签体长度（不含 10 字节头）
  const bodyStart = 10;
  const bodyEnd = Math.min(bodyStart + size, bytes.length);

  const tags: AudioTags = {};
  let cover: CoverHint | null = null;
  let p = bodyStart;

  const considerCover = (c: CoverHint | null) => {
    if (c && (!cover || (cover.picType !== 0x03 && c.picType === 0x03))) cover = c;
  };

  if (ver === 2) {
    // ID3v2.2：帧头 6 字节（3 字符 ID + 3 字节长度）
    while (p + 6 <= bodyEnd) {
      const id = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2]);
      if (!/^[A-Z0-9]{3}$/.test(id)) break;
      const len = (bytes[p + 3] << 16) | (bytes[p + 4] << 8) | bytes[p + 5];
      if (len <= 0) break;
      const fEnd = p + 6 + len;
      if (fEnd > bodyEnd) break;
      const isCover = id === 'PIC';
      if (len > MAX_FRAME_SPAN && !isCover) {
        p = fEnd;
        continue;
      }
      if (id === 'TT2') tags.title = decodeFrame(bytes, p + 6, fEnd);
      else if (id === 'TP1') tags.artist = decodeFrame(bytes, p + 6, fEnd);
      else if (id === 'TAL') tags.album = decodeFrame(bytes, p + 6, fEnd);
      else if (id === 'TYE') tags.year = decodeFrame(bytes, p + 6, fEnd);
      else if (isCover) considerCover(parseApic(bytes, p + 6, fEnd, true));
      p = fEnd;
    }
  } else {
    // ID3v2.3 / v2.4：帧头 10 字节（4 字符 ID + 4 字节长度 + 2 字节 flags）
    while (p + 10 <= bodyEnd) {
      const id = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const len = ver === 4 ? syncSafe(bytes, p + 4) : be32(bytes, p + 4);
      if (len <= 0) break;
      const fEnd = p + 10 + len;
      if (fEnd > bodyEnd) break;
      const isCover = id === 'APIC';
      // 超大非封面帧直接跳过（避免脏数据撑爆内存、也别挡住后面的封面帧）
      if (len > MAX_FRAME_SPAN && !isCover) {
        p = fEnd;
        continue;
      }
      let vStart = p + 10;
      // v2.4 起，帧可能带「数据长度指示器」或压缩/加密/分组标志，跳过其附加字节
      if (ver === 4) {
        const flags = bytes[p + 9];
        let extra = 0;
        if (flags & 0x40) extra += 4; // 数据长度指示器
        if (flags & 0x01) extra += 4; // 数据长度指示器（压缩时也有）
        vStart += extra;
      }

      if (isCover) {
        considerCover(parseApic(bytes, vStart, fEnd, false));
        p = fEnd;
        continue;
      }

      switch (id) {
        case 'TIT2': tags.title = decodeFrame(bytes, vStart, fEnd); break;
        case 'TPE1': tags.artist = decodeFrame(bytes, vStart, fEnd); break;
        case 'TALB': tags.album = decodeFrame(bytes, vStart, fEnd); break;
        case 'TDRC': // v2.4 用 TDRC 存年份
        case 'TYER': tags.year = decodeFrame(bytes, vStart, fEnd); break;
        case 'TLEN': {
          // 毫秒
          const ms = Number(decodeFrame(bytes, vStart, fEnd));
          if (Number.isFinite(ms) && ms > 0) tags.duration = Math.round(ms / 1000);
          break;
        }
        default:
          break;
      }
      p = fEnd;
    }
  }

  return { tags, cover };
}

/** ID3v1 兜底：固定在文件末尾 128 字节（"TAG" 开头），字段定长、latin1 编码 */
function readId3v1(tail: Uint8Array): AudioTags | null {
  if (tail.length < 128) return null;
  const o = tail.length - 128;
  if (tail[o] !== 0x54 || tail[o + 1] !== 0x41 || tail[o + 2] !== 0x47) return null; // "TAG"
  const dec = (s: number, e: number) => tidy(new TextDecoder('latin1').decode(tail.subarray(s, e)));
  const tags: AudioTags = {
    title: dec(o + 3, o + 33),
    artist: dec(o + 33, o + 63),
    album: dec(o + 63, o + 93),
    year: dec(o + 93, o + 97),
  };
  if (!tags.title && !tags.artist && !tags.album) return null;
  return tags;
}

/**
 * 从文件名尽力还原信息。
 * 常见整理格式：「01 - 周杰伦 - 稻香.mp3」「周杰伦 - 稻香.flac」「01.稻香.m4a」
 * 只在标签缺失时使用，属于兜底而不是主路径。
 */
export function parseFromFilename(name: string): AudioTags {
  const base = name.replace(/\.[^.]+$/, '').trim();
  // 去掉开头的音轨号（01 / 01. / 01 -）
  const stripped = base.replace(/^\s*\d{1,3}\s*[-_.、]\s*/, '');
  const parts = stripped.split(/\s+[-–—]\s+/).filter(Boolean);
  if (parts.length >= 2) {
    // 「歌手 - 歌名」是最普遍的约定；三段的取后两段，避免把前缀当歌手
    const artist = parts[parts.length - 2];
    const title = parts[parts.length - 1];
    return { title, artist };
  }
  return { title: stripped || base };
}

/** 封面目录（App 数据目录下的 covers/），带缓存避免重复求 appDataDir */
let coverDirCache: string | null = null;
async function ensureCoverDir(): Promise<string> {
  if (coverDirCache) return coverDirCache;
  const app = await appDataDir();
  const dir = await join(app, 'covers');
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    // 目录已存在属正常；权限不足则 warn，后续落盘会再降级
    console.warn('[id3] 创建封面目录失败（可能权限不足），封面将降级为不显示', e);
  }
  coverDirCache = dir;
  return dir;
}

/**
 * 按需读取封面二进制：优先用已在 64KB 头缓冲里的部分，超出部分再单独 seek 读取。
 * 返回完整图片字节；读取不完整（文件截断）返回 null，交上层降级。
 */
async function readPicture(
  handle: Awaited<ReturnType<typeof open>>,
  cover: CoverHint,
  head: Uint8Array,
  headLen: number,
): Promise<Uint8Array | null> {
  const { picStart, picLen } = cover;
  if (picLen <= 0 || picLen > MAX_COVER_BYTES) return null;

  const out = new Uint8Array(picLen);
  // 缓冲里已含的部分直接拷贝
  const fromHead = Math.max(0, Math.min(picLen, headLen - picStart));
  if (fromHead > 0) out.set(head.subarray(picStart, picStart + fromHead), 0);

  if (fromHead < picLen) {
    try {
      await handle.seek(picStart + fromHead, SeekMode.Start);
    } catch {
      return null;
    }
    let filled = fromHead;
    const buf = new Uint8Array(32 * 1024);
    while (filled < picLen) {
      const n = await handle.read(buf);
      if (!n) break;
      const take = Math.min(n, picLen - filled);
      out.set(buf.subarray(0, take), filled);
      filled += take;
    }
    if (filled < picLen) return null; // 截断，图片不完整
  }
  return out;
}

/** 把封面字节落盘，返回可用于 <img> 的本地 asset URL；失败返回 undefined（降级） */
async function saveCoverFile(coverId: string, ext: string, data: Uint8Array): Promise<string | undefined> {
  try {
    const dir = await ensureCoverDir();
    const file = await join(dir, `${coverId}.${ext}`);
    const fh = await open(file, { write: true, create: true, truncate: true });
    try {
      await fh.write(data);
    } finally {
      await fh.close();
    }
    return convertFileSrc(file);
  } catch (e) {
    console.warn('[id3] 封面落盘失败，降级为不显示封面', e);
    return undefined;
  }
}

/**
 * 删除某曲目对应的封面文件（移除曲库时调用）。扩展名未知，遍历常见格式逐个试删。
 */
export async function removeCover(coverId: string): Promise<void> {
  try {
    const dir = await ensureCoverDir();
    const exts = ['jpg', 'png', 'gif', 'bmp', 'webp', 'tif', 'ico', 'avif', 'heic', 'heif', 'tga', 'pcx'];
    await Promise.all(
      exts.map((ext) => remove(`${dir}/${coverId}.${ext}`).catch(() => {})),
    );
  } catch {
    /* 封面本就未必存在，忽略 */
  }
}

/**
 * 读取单个音频文件的标签 + 封面。
 * 只读文件头，并用 seek 精确落到文件尾部只取 128 字节做 ID3v1 兜底，
 * 全程不把整首音频载入内存 —— 扫描上千首时这点很关键。
 * 传入 coverId 时，会尝试解析并落盘 APIC 封面（无封面 / 落盘失败则 cover 为 undefined）。
 */
export async function readTags(path: string, fileName: string, coverId?: string): Promise<TagResult> {
  const fallback = parseFromFilename(fileName);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, { read: true });

    // ---- 1) 文件头：ID3v2（文本 + 封面帧位置）----
    const head = new Uint8Array(HEAD_BYTES);
    let headLen = 0;
    try {
      const n = await handle.read(head);
      headLen = n ?? 0;
    } catch {
      headLen = 0;
    }

    let tags: AudioTags | null = null;
    let coverHint: CoverHint | null = null;
    if (headLen > 0) {
      const r = parseId3v2(head.subarray(0, headLen));
      if (r) {
        tags = r.tags;
        coverHint = r.cover;
      }
    }

    // ---- 1.5) 封面落盘（D1）----
    let cover: string | undefined;
    if (coverId && coverHint) {
      const data = await readPicture(handle, coverHint, head, headLen);
      if (data) cover = await saveCoverFile(coverId, coverHint.ext, data);
    }

    // ---- 2) 文件尾：ID3v1 兜底 ----
    if (!tags || (!tags.title && !tags.artist && !tags.album)) {
      try {
        const info = await handle.stat();
        const size = Number(info.size ?? 0);
        if (size > 128) {
          await handle.seek(-128, SeekMode.End);
          const tail = new Uint8Array(128);
          const n = await handle.read(tail);
          if (n) {
            const v1 = readId3v1(tail.subarray(0, n));
            if (v1) tags = { ...v1, ...(tags ?? {}) };
          }
        }
      } catch {
        /* 某些容器（如流式存储）不支持 seek，忽略即可 */
      }
    }

    const merged: AudioTags = {
      title: tags?.title || fallback.title,
      artist: tags?.artist || fallback.artist,
      album: tags?.album || undefined,
      year: tags?.year || undefined,
      duration: tags?.duration,
    };
    return { tags: merged, cover };
  } catch {
    // 打不开（权限 / 已删除 / 非音频）时不阻断扫描，退回文件名；封面保持无
    return { tags: fallback };
  } finally {
    try {
      await handle?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 批量并发读取标签 + 封面。8 路并发是权衡：再高会争抢 IO 让进度回调变卡，
 * 再低在千首规模下等待感明显。coverIds 与 files 等长（可缺），对应曲目封面文件名。
 */
export async function readTagsBatch(
  files: { path: string; name: string }[],
  onTick?: (done: number, total: number) => void,
  coverIds?: string[],
): Promise<TagResult[]> {
  const out: TagResult[] = new Array(files.length);
  const CONCURRENCY = 8;
  let cursor = 0;
  let done = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= files.length) return;
      out[i] = await readTags(files[i].path, files[i].name, coverIds?.[i]);
      done++;
      onTick?.(done, files.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  return out;
}
