// v2.4.8 #1：LRC 歌词解析。
// 源侧（如酷狗）返回的是 base64 编码的 LRC 原文，在 js.ts 适配器里已解码成
// 带 [mm:ss.xx] 时间轴的纯文本；这里负责把它切成 LyricLine[] 供播放页滚动高亮。
import type { LyricLine } from '../engine/types';

/**
 * 解析 LRC 文本 → 按时间升序的 LyricLine[]。
 *
 * 支持：
 *   [mm:ss.xx] / [mm:ss.xxx] / [mm:ss]   —— 标准时间轴（一行多标签会展开成多行）
 *   [ti:] [ar:] [al:] [by:] [offset:]     —— 元信息标签（忽略；offset 用于整体校正）
 * 无法解析出行时返回空数组（播放页回退「暂无歌词」）。
 */
export function parseLrc(text: string): LyricLine[] {
  if (!text || typeof text !== 'string') return [];

  // offset 标签：整体时间偏移（毫秒），部分源会用它做校正
  let offset = 0;
  const om = text.match(/\[offset:\s*([+-]?\d+)\s*\]/i);
  if (om) offset = parseInt(om[1], 10) / 1000;

  const timeTag = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const metaTag = /^\[(ti|ar|al|by|offset|re|ve):.*\]$/i;

  const out: LyricLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || metaTag.test(line)) continue;

    // 收集本行所有时间标签（一行可能挂多个时间：同一句重复出现）
    const times: number[] = [];
    let m: RegExpExecArray | null;
    timeTag.lastIndex = 0;
    while ((m = timeTag.exec(line)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      // 毫秒补位：[.5] → 500ms，[.05] → 50ms，[.005] → 5ms
      const fracStr = m[3] ?? '0';
      const frac = parseInt(fracStr.padEnd(3, '0'), 10) / 1000;
      times.push(min * 60 + sec + frac + offset);
    }
    if (!times.length) continue;

    // 去掉所有时间标签后的正文
    const content = line.replace(timeTag, '').trim();
    if (!content) continue;

    for (const t of times) out.push({ time: Math.max(0, t), text: content });
  }

  out.sort((a, b) => a.time - b.time);
  return out;
}

/** 给定进度（秒）与已排序歌词，返回当前应高亮的行下标（无匹配返回 -1） */
export function activeLyricIndex(lines: LyricLine[], progress: number): number {
  if (!lines.length) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= progress) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
