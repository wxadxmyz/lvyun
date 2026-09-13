// 引擎请求调试日志缓冲：供「开发者调试面板」展示每次请求/响应/耗时
export interface DebugEntry {
  id: number;
  ts: number;
  method: string;
  url: string;
  status?: number;
  ok: boolean;
  durationMs: number;
  error?: string;
  preview?: string; // 响应预览（截断）
}

let entries: DebugEntry[] = [];
let seq = 0;
const listeners = new Set<() => void>();

/**
 * v2.3.10 关键修复：getSnapshot 必须返回稳定引用。
 * 原先 get() 每次都 entries.slice().reverse() 造一个新数组，而 DebugPanel 用的是
 * useSyncExternalStore(subscribe, get) —— React 每次渲染都拿到「不同的快照」，
 * 判定数据变化后再次渲染，于是无限循环，最终抛
 * "The result of getSnapshot should be cached to avoid an infinite loop"
 * 把整棵组件树打崩，表现就是「点调试按钮 → 白屏」。
 * 改成：只在数据真的变了（record / clear）时才重算一份快照，get 原样返回它。
 */
let snapshot: DebugEntry[] = [];

function emit() {
  snapshot = entries.slice().reverse();
  for (const l of listeners) l();
}

export const debugLog = {
  get(): DebugEntry[] {
    return snapshot;
  },
  record(e: Omit<DebugEntry, 'id' | 'ts'>): DebugEntry {
    const full: DebugEntry = { ...e, id: ++seq, ts: Date.now() };
    entries = [...entries, full].slice(-200);
    emit();
    return full;
  },
  clear() {
    entries = [];
    emit();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
