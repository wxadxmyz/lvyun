import { open } from '@tauri-apps/plugin-dialog';
import { readDir } from '@tauri-apps/plugin-fs';
import { convertFileSrc } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';
import { MediaItem } from '../engine/types';

// 本地音乐：让用户手动选择文件夹（权限少、可控），递归扫描常见音频格式，
// 通过 Tauri 的 convertFileSrc 转为 WebView 可直接播放的 asset 地址。
// 仅触发用户主动选择，不后台扫描整机，符合隐私与权限最小化原则。
//
// #7 修复：安卓端 @tauri-apps/plugin-dialog 不支持目录选择器，
// open({directory:true}) 会抛 "Folder picker not implemented on mobile"。
// 这里改为：支持目录就扫目录；不支持时降级为「多选音频文件」，避免直接报错。

export const AUDIO_EXT = ['.mp3', '.flac', '.m4a', '.wav', '.ogg', '.aac', '.opus', '.ape', '.wma'];

export type LocalPickMode = 'dir' | 'file' | 'auto';

async function listAudio(dir: string, depth = 0): Promise<{ path: string; name: string }[]> {
  if (depth > 4) return [];
  let entries;
  try {
    entries = await readDir(dir);
  } catch {
    return [];
  }
  const out: { path: string; name: string }[] = [];
  for (const e of entries) {
    const full = dir.endsWith('/') ? dir + e.name : dir + '/' + e.name;
    if (e.isDirectory) {
      out.push(...(await listAudio(full, depth + 1)));
    } else if (AUDIO_EXT.some((ext) => e.name.toLowerCase().endsWith(ext))) {
      out.push({ path: full, name: e.name });
    }
  }
  return out;
}

function isDirPickerUnsupported(e: any): boolean {
  const msg = String(e?.message ?? e ?? '');
  return /folder picker|not implemented|directory.*not.*support|不支持.*目录/i.test(msg);
}

/**
 * 挑选本地音频。
 * - 'dir'：只走目录选择器（平台不支持时抛出带 noDirPicker 标记的错误，交给 UI 提示并降级）
 * - 'file'：只走多选文件
 * - 'auto'：优先目录，失败自动降级为选文件（不报错）
 */
export async function pickAudioFiles(mode: LocalPickMode = 'auto'): Promise<{ path: string; name: string }[]> {
  if (mode !== 'file') {
    try {
      const dir = await open({ directory: true, multiple: false, title: '选择音乐文件夹' });
      if (typeof dir === 'string' && dir) return await listAudio(dir);
    } catch (e: any) {
      if (!isDirPickerUnsupported(e)) throw e;
      if (mode === 'dir') {
        const err: any = new Error(e?.message || '当前设备不支持选择文件夹');
        err.noDirPicker = true;
        throw err;
      }
      // auto：静默降级到下面「选文件」
    }
  }

  const picked = await open({ multiple: true, title: '选择音乐文件' });
  if (!picked) return [];
  const files = Array.isArray(picked) ? picked : [picked];
  return files
    .map((p) => ({ path: p, name: p.split('/').pop() || p }))
    .filter((f) => AUDIO_EXT.some((ext) => f.name.toLowerCase().endsWith(ext)));
}

/** 把挑选到的文件转成可播放的 MediaItem */
export function toMediaItems(files: { path: string; name: string }[], startIndex = 0): MediaItem[] {
  return files.map((f, i) => ({
    id: 'local-' + (startIndex + i) + '-' + f.path,
    sourceId: 'local',
    sourceName: '本地音乐',
    title: f.name.replace(/\.[^.]+$/, ''),
    artist: '本地音乐',
    mediaType: 'music' as const,
    playUrl: convertFileSrc(f.path),
  }));
}

/* ---------------------------------------------------------------------------
 * 全盘搜索
 * -------------------------------------------------------------------------
 * 设计取舍：真正的「任意目录全盘扫描」需要 MANAGE_EXTERNAL_STORAGE（所有文件访问权），
 * 但 ①Google Play 对普通应用拒审；②国产 ROM 会弹一个很吓人的「允许访问所有文件」
 * 系统弹窗，对音乐播放器来说性价比极低。
 * 因此这里不申请该权限，改为扫描「公共媒体目录 + 主流音乐 App 的下载目录」，
 * 配合已声明的 READ_MEDIA_AUDIO（Android 13+）/ READ_EXTERNAL_STORAGE（≤32）即可覆盖
 * 绝大多数真实场景。确实放在特殊目录的用户，可用下方「选择文件夹 / 选择文件」兜底。
 * ------------------------------------------------------------------------- */

const SCAN_MAX_FILES = 3000; // 上限，避免极端情况扫太久
const SCAN_MAX_DEPTH = 3;

/** 安卓：外置存储根 + 常见音乐存放子目录 */
const ANDROID_ROOTS = ['/storage/emulated/0', '/sdcard'];
const ANDROID_SUBS = [
  'Music', 'Download', 'Downloads', 'Documents', 'DCIM', 'Movies', 'Audio',
  'Podcasts', 'Recordings', 'Audiobooks', 'Ringtones', 'Notifications',
  // 主流音乐 App 的自建下载目录（只列目录名，不复制任何产品的 UI 设计）
  'netease/cloudmusic/Music', 'netease/cloudmusic/Download',
  'qqmusic/song', 'qqmusic/cache', 'kgmusic/download', 'Kugou', 'KugouMusic',
  'KuwoMusic/music', 'xiami/audio', 'MIUI/Music', 'Huawei/Music',
];
/** 桌面端：用户目录下的常见音乐位置 */
const DESKTOP_SUBS = ['Music', 'Downloads', 'Documents/Music', 'Movies', 'Videos', 'Audiobooks', 'Podcasts'];

export interface ScanProgress {
  found: number;
  dir: string;
  done: boolean;
}

async function candidateRoots(): Promise<string[]> {
  const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
  if (isAndroid) {
    // /storage/emulated/0 与 /sdcard 通常互为软链，只取第一个能读到的，避免整盘扫两遍
    for (const root of ANDROID_ROOTS) {
      try {
        await readDir(root);
        return ANDROID_SUBS.map((s) => `${root}/${s}`);
      } catch {
        /* 换下一个根 */
      }
    }
    return [];
  }
  try {
    const home = (await homeDir()).replace(/[\\/]+$/, '');
    return DESKTOP_SUBS.map((s) => `${home}/${s}`);
  } catch {
    return [];
  }
}

/**
 * 扫描设备上的常见音乐目录，带进度回调。
 * 会周期性让出主线程，保证扫描动画不卡住。
 */
export async function scanPublicDirs(onProgress?: (p: ScanProgress) => void): Promise<{ path: string; name: string }[]> {
  const roots = await candidateRoots();
  const out: { path: string; name: string }[] = [];
  const seen = new Set<string>();
  let lastYield = Date.now();

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > SCAN_MAX_DEPTH || out.length >= SCAN_MAX_FILES) return;
    let entries: any[];
    try {
      entries = await readDir(dir);
    } catch {
      return; // 无权限 / 不存在，静默跳过
    }
    for (const e of entries) {
      if (out.length >= SCAN_MAX_FILES) return;
      const full = dir.endsWith('/') ? dir + e.name : dir + '/' + e.name;
      if (e.isDirectory) {
        await walk(full, depth + 1);
      } else if (AUDIO_EXT.some((ext) => e.name.toLowerCase().endsWith(ext))) {
        if (!seen.has(full)) {
          seen.add(full);
          out.push({ path: full, name: e.name });
        }
      }
    }
    if (Date.now() - lastYield > 120) {
      lastYield = Date.now();
      onProgress?.({ found: out.length, dir, done: false });
      await new Promise((r) => setTimeout(r, 0)); // 让出主线程
    }
  };

  for (const r of roots) {
    onProgress?.({ found: out.length, dir: r, done: false });
    await walk(r, 0);
    if (out.length >= SCAN_MAX_FILES) break;
  }
  onProgress?.({ found: out.length, dir: '', done: true });
  return out;
}

/** 保留原调用方式（直接选中后播放），内部已支持安卓降级 */
export async function scanLocalMusic(onPlay: (items: MediaItem[]) => void, push: (t: string) => void) {
  try {
    push('正在选择音乐…');
    const files = await pickAudioFiles('auto');
    if (files.length === 0) {
      push('未选择或没有找到音乐文件');
      return;
    }
    const items = toMediaItems(files);
    onPlay(items);
    push(`已导入 ${items.length} 首本地音乐`);
  } catch (e: any) {
    push('扫描失败：' + (e?.message || String(e)));
  }
}
