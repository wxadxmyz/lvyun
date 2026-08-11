import { usePlayer } from '../lib/playerStore';

// 桌面歌词浮窗（音乐）：受设置「桌面歌词浮窗」开关控制。
// 网页原型中以固定浮层模拟，桌面端(Tauri)可改为独立透明窗口。
function activeText(lines: { time: number; text: string }[], progress: number): string {
  let txt = '';
  for (const l of lines) {
    if (l.time <= progress + 0.2) txt = l.text;
    else break;
  }
  return txt;
}

export function DesktopLyric() {
  const state = usePlayer();
  if (!state.current) return null;
  const it = state.current;
  const lines: { time: number; text: string }[] = Array.isArray(it.lyric)
    ? it.lyric.map((l) => ({ time: l.time, text: l.text }))
    : Array.isArray(it.raw?.lyric)
    ? (it.raw.lyric as string[]).map((t: string) => ({ time: 0, text: t }))
    : [];
  const text = lines.length ? activeText(lines, state.progress) || it.title : it.title;

  return (
    <div className="desktop-lyric">
      <div className="dl-song">{it.title} - {it.artist ?? it.sourceName}</div>
      <div className="dl-text">{text}</div>
    </div>
  );
}
