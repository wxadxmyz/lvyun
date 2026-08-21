import { open } from '@tauri-apps/plugin-dialog';
import { readDir } from '@tauri-apps/plugin-fs';
import { convertFileSrc } from '@tauri-apps/api/core';
import { MediaItem } from '../engine/types';

// 本地音乐：让用户手动选择文件夹（权限少、可控），递归扫描常见音频格式，
// 通过 Tauri 的 convertFileSrc 转为 WebView 可直接播放的 asset 地址。
// 仅触发用户主动选择，不后台扫描整机，符合隐私与权限最小化原则。
const AUDIO_EXT = ['.mp3', '.flac', '.m4a', '.wav', '.ogg', '.aac', '.opus', '.ape', '.wma'];

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

export async function scanLocalMusic(onPlay: (items: MediaItem[]) => void, push: (t: string) => void) {
  try {
    const picked = await open({ directory: true, multiple: false, title: '选择音乐文件夹' });
    if (!picked || typeof picked !== 'string') return;
    push('正在扫描本地音乐…');
    const files = await listAudio(picked);
    if (files.length === 0) {
      push('该文件夹没有找到音乐文件');
      return;
    }
    const items: MediaItem[] = files.map((f, i) => ({
      id: 'local-' + i + '-' + f.path,
      sourceId: 'local',
      sourceName: '本地音乐',
      title: f.name.replace(/\.[^.]+$/, ''),
      artist: '本地音乐',
      mediaType: 'music',
      playUrl: convertFileSrc(f.path),
    }));
    onPlay(items);
    push(`已导入 ${items.length} 首本地音乐`);
  } catch (e: any) {
    push('扫描失败：' + (e?.message || String(e)));
  }
}
