import { open, SeekMode } from '@tauri-apps/plugin-fs';

/**
 * v2.3.11 #6b：轻量 ID3 标签解析（自研，零依赖）
 *
 * 为什么自己写而不是引第三方库：
 *   常见的 music-metadata / jsmediatags 体积都在百 KB 量级，而律云需要的只是
 *   歌名 / 歌手 / 专辑 / 年份 / 时长这几项，为它多背一个重依赖不划算。
 *   这里只解析 ID3v2 的文本帧（TIT2/TPE1/TALB/TDRC/TYER）+ ID3v1 兜底，
 *   纯字符串操作，几十行搞定。
 *
 * 为什么不解析封面（APIC）：
 *   封面是二进制大块（常 100KB~1MB）。本地音乐是整批入库、且要写进 localStorage，
 *   带封面会瞬间撑爆 5~10MB 的配额，反过来导致整个曲库保存失败。
 *   所以本地音乐沿用「歌名渐变 + 首字」的兜底封面，这是刻意的取舍，不是漏做。
 *
 * 内存策略：封面往往占据帧区绝大部分体积，因此这里只读文件头 64KB；
 * 万一标签区比 64KB 还大（封面超大），退化为「只拿到文件名」而不是让扫描崩掉。
 */

const HEAD_BYTES = 64 * 1024; // 覆盖绝大多数含封面的标签区
const MAX_FRAME_SPAN = 60 * 1024; // 单个文本帧的合理上限，防脏数据撑爆内存

export interface AudioTags {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  /** 秒；来自 ID3v2 TLEN 或 MP3 码率估算，拿不到则为 undefined */
  duration?: number;
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

/** 解析 ID3v2 头（若存在） */
function parseId3v2(bytes: Uint8Array): AudioTags | null {
  if (bytes.length < 10) return null;
  // "ID3"
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;

  const ver = bytes[3];
  const size = syncSafe(bytes, 6); // 标签体长度（不含 10 字节头）
  const bodyStart = 10;
  const bodyEnd = Math.min(bodyStart + size, bytes.length);

  const tags: AudioTags = {};
  let p = bodyStart;

  if (ver === 2) {
    // ID3v2.2：帧头 6 字节（3 字符 ID + 3 字节长度）
    while (p + 6 <= bodyEnd) {
      const id = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2]);
      if (!/^[A-Z0-9]{3}$/.test(id)) break;
      const len = (bytes[p + 3] << 16) | (bytes[p + 4] << 8) | bytes[p + 5];
      const fEnd = p + 6 + len;
      if (len <= 0 || fEnd > bodyEnd) break;
      if (id === 'TT2') tags.title = decodeFrame(bytes, p + 6, fEnd);
      else if (id === 'TP1') tags.artist = decodeFrame(bytes, p + 6, fEnd);
      else if (id === 'TAL') tags.album = decodeFrame(bytes, p + 6, fEnd);
      else if (id === 'TYE') tags.year = decodeFrame(bytes, p + 6, fEnd);
      p = fEnd;
    }
  } else {
    // ID3v2.3 / v2.4：帧头 10 字节（4 字符 ID + 4 字节长度 + 2 字节 flags）
    while (p + 10 <= bodyEnd) {
      const id = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const len = ver === 4 ? syncSafe(bytes, p + 4) : be32(bytes, p + 4);
      if (len <= 0 || len > MAX_FRAME_SPAN) break;
      const fEnd = p + 10 + len;
      if (fEnd > bodyEnd) break;

      let vStart = p + 10;
      // v2.4 起，帧可能带「数据长度指示器」或压缩/加密/分组标志，跳过其附加字节
      if (ver === 4) {
        const flags = bytes[p + 9];
        let extra = 0;
        if (flags & 0x40) extra += 4; // 数据长度指示器
        if (flags & 0x01) extra += 4; // 数据长度指示器（压缩时也有）
        vStart += extra;
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

  return tags;
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

/**
 * 读取单个音频文件的标签。
 * 只读文件头，并且用 seek 精确落到文件尾部只取 128 字节做 ID3v1 兜底，
 * 全程不把整首音频载入内存 —— 扫描上千首时这点很关键。
 */
export async function readTags(path: string, fileName: string): Promise<AudioTags> {
  const fallback = parseFromFilename(fileName);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, { read: true });

    // ---- 1) 文件头：ID3v2 ----
    const head = new Uint8Array(HEAD_BYTES);
    let headLen = 0;
    try {
      const n = await handle.read(head);
      headLen = n ?? 0;
    } catch {
      headLen = 0;
    }

    let tags: AudioTags | null = null;
    if (headLen > 0) tags = parseId3v2(head.subarray(0, headLen));

    // ---- 2) 文件尾：ID3v1 兜底 ----
    if (!tags || (!tags.title && !tags.artist && !tags.album)) {
      try {
        const info = await handle.stat();
        const size = Number(info.size ?? 0);        if (size > 128) {
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
    return merged;
  } catch {
    // 打不开（权限 / 已删除 / 非音频）时不阻断扫描，退回文件名
    return fallback;
  } finally {
    try {
      await handle?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 批量并发读取标签。8 路并发是权衡：再高会争抢 IO 让进度回调变卡，
 * 再低在千首规模下等待感明显。
 */
export async function readTagsBatch(
  files: { path: string; name: string }[],
  onTick?: (done: number, total: number) => void,
): Promise<AudioTags[]> {
  const out: AudioTags[] = new Array(files.length);
  const CONCURRENCY = 8;
  let cursor = 0;
  let done = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= files.length) return;
      out[i] = await readTags(files[i].path, files[i].name);
      done++;
      onTick?.(done, files.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  return out;
}
