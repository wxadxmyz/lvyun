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
  source?: string; // v2.3.11 #2：来源标注（源名 / "spider"）
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

/* -------------------------------------------------------------------------
 * v2.3.11 #2：订阅 Rust 侧的 spider 调试事件
 * -----------------------------------------------------------------------
 * 背景：JS 脚本源的网络请求全部发生在 Rust 沙箱里，走的是 reqwest 而非前端
 * fetchJson，所以此前调试面板对 JS 源一条记录都没有 —— 用 JS 源排障等于睁眼瞎。
 * 现在 js_engine.rs 会把每次请求与每处报错 emit 成 "debug://spider" 事件，
 * 这里转成标准 DebugEntry 落进同一个缓冲区，面板无需改动即能看到。
 * ------------------------------------------------------------------------- */

interface SpiderLogPayload {
  ts: number;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
  url?: string;
  method?: string;
  status?: number;
  durationMs?: number;
  size?: number;
  preview?: string;
}

let unlistenSpider: (() => void) | null = null;

export async function initSpiderDebug(): Promise<void> {
  if (unlistenSpider) return; // 幂等：重复挂载不重复计数
  try {
    const { listen } = await import('@tauri-apps/api/event');
    unlistenSpider = await listen<SpiderLogPayload>('debug://spider', (ev) => {
      const p = ev.payload;
      if (!p) return;
      if (p.url) {
        // 网络请求类：结构化明细
        debugLog.record({
          method: p.method ?? 'GET',
          url: p.url,
          status: p.status,
          ok: typeof p.status === 'number' && p.status < 400,
          durationMs: p.durationMs ?? 0,
          preview: p.preview,
          source: p.source,
        });
      } else {
        // 脚本自身的输出 / eval 报错
        debugLog.record({
          method: 'SPIDER',
          url: `spider · ${p.source}`,
          ok: p.level !== 'error',
          durationMs: 0,
          error: p.level === 'error' ? p.message : undefined,
          preview: p.level === 'error' ? undefined : p.message,
          source: p.source,
        });
      }
    });
  } catch {
    // 浏览器预览等非 Tauri 环境没有事件通道，静默降级即可
  }
}
