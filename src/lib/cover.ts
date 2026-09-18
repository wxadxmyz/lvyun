export function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function gradientFor(s: string): string {
  const h = hashHue(s || 'x');
  return `linear-gradient(135deg, hsl(${h} 55% 42%), hsl(${(h + 50) % 360} 60% 30%))`;
}

// v2.6.0：返回封面取色的两路主色 [c1, c2]，供播放页光晕背景（.pv-bg）与封面环境光投影使用，
// 与 gradientFor 共用同一 hashHue，保证封面/光晕同色系。
export function coverColors(s: string): [string, string] {
  const h = hashHue(s || 'x');
  return [`hsl(${h} 55% 42%)`, `hsl(${(h + 50) % 360} 60% 30%)`];
}

export function initial(s: string): string {
  const t = (s || '?').trim();
  return t ? t.charAt(0) : '?';
}
