// 音频处理图（单例）：一个 <audio> 元素一生只能创建一个 MediaElementSource，
// 因此把整条 EQ + Analyser 链缓存起来，全屏播放页反复开关不会报错。
// 信号链：MediaElementSource -> EQ(8段 BiquadFilter 串联) -> Analyser -> destination

export const EQ_BANDS = [60, 150, 400, 1000, 2400, 6000, 12000, 15000]; // Hz

export interface EqPreset {
  name: string;
  gains: number[]; // dB，每段
}

export const EQ_PRESETS: EqPreset[] = [
  { name: '关闭', gains: [0, 0, 0, 0, 0, 0, 0, 0] },
  { name: '流行', gains: [-2, 1, 3, 4, 3, 1, -1, -2] },
  { name: '摇滚', gains: [4, 3, -1, -2, 1, 2, 4, 3] },
  { name: '古典', gains: [3, 2, 0, 2, 0, -1, 1, 2] },
  { name: '人声', gains: [-2, -1, 2, 4, 3, 2, -1, -2] },
  { name: '重低音', gains: [7, 5, 2, 0, 0, 0, 0, 0] },
];

let audioEl: HTMLAudioElement | null = null;
let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let filters: BiquadFilterNode[] = [];
let eqGains: number[] = [...EQ_PRESETS[0].gains];
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function ensureGraph(audio: HTMLAudioElement): AnalyserNode | null {
  const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctx) return null;
  if (analyser && audioEl === audio) return analyser;
  try {
    const c: AudioContext = new Ctx();
    const src = c.createMediaElementSource(audio);
    const eq: BiquadFilterNode[] = EQ_BANDS.map((freq, i) => {
      const bq = c.createBiquadFilter();
      bq.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
      bq.frequency.value = freq;
      bq.Q.value = 1;
      bq.gain.value = eqGains[i] ?? 0;
      return bq;
    });
    const an = c.createAnalyser();
    an.fftSize = 64;
    src.connect(eq[0]);
    for (let i = 0; i < eq.length - 1; i++) eq[i].connect(eq[i + 1]);
    eq[eq.length - 1].connect(an);
    an.connect(c.destination);
    audioEl = audio;
    ctx = c;
    filters = eq;
    analyser = an;
    return an;
  } catch {
    return null;
  }
}

export function getAnalyser(audio: HTMLAudioElement): AnalyserNode | null {
  return ensureGraph(audio) ?? analyser;
}

export function getAudioContext(): AudioContext | null {
  return ctx;
}

export function getEqGains(): number[] {
  return [...eqGains];
}

export function subscribeEq(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// 设置 EQ 增益（dB 数组，长度需与 EQ_BANDS 一致），实时作用于滤波器
export function setEqGains(gains: number[]) {
  eqGains = gains.slice();
  filters.forEach((f, i) => {
    if (f) f.gain.value = eqGains[i] ?? 0;
  });
  emit();
}
