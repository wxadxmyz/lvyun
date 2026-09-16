import { useSyncExternalStore } from 'react';
import { MediaItem } from '../engine/types';

export type PlayMode = 'list' | 'one' | 'shuffle';

interface PlayerState {
  current: MediaItem | null;
  queue: MediaItem[];
  index: number;
  isPlaying: boolean;
  progress: number; // 秒
  duration: number; // 秒
  volume: number; // 0~1
  muted: boolean;
  mode: PlayMode;
}

// 媒体元素引用（模块级，便于跨组件控制进度）
let audioElRef: HTMLAudioElement | null = null;
let videoElRef: HTMLVideoElement | null = null;

/* ==========================================================================
   v2.4.8 #8：播放状态持久化。
   --------------------------------------------------------------------------
   此前 state 是纯内存变量，进程被杀（清后台）后队列 / 当前曲 / 播放状态全丢，
   重进 App 播放列表空白、播放器显示「未在播放」。

   现在把「队列 + 当前曲 + 索引 + 模式 + 音量」持久化到 localStorage，冷启动还原。
   —— 刻意不持久化 isPlaying：App 已退出，恢复时不应自动出声（浏览器也要求用户手势
      后才能播放）。还原为暂停态，用户点一下继续即可；播放位置由 AudioHost 的
      watchProgress 续听机制负责。
   —— 不持久化 progress/duration：它们由 <audio> 的 loadedmetadata/timeupdate 重建。
   ========================================================================== */
const LS_KEY = 'lvyun.player.v1';

/** 只持久化必要的可序列化字段 */
interface PersistedState {
  queue: MediaItem[];
  current: MediaItem | null;
  index: number;
  volume: number;
  muted: boolean;
  mode: PlayMode;
}

function loadPersisted(): Partial<PlayerState> | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PersistedState;
    if (!p || !Array.isArray(p.queue)) return null;
    return {
      queue: p.queue,
      current: p.current ?? p.queue[p.index] ?? null,
      index: typeof p.index === 'number' ? p.index : -1,
      volume: typeof p.volume === 'number' ? p.volume : 0.9,
      muted: !!p.muted,
      mode: p.mode ?? 'list',
      isPlaying: false, // 冷启动不自动播放，等用户手势
      progress: 0,
      duration: 0,
    };
  } catch {
    return null;
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** 防抖写入：进度回写（onTimeUpdate）很频繁，不必每次都落盘 */
function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const p: PersistedState = {
        queue: state.queue,
        current: state.current,
        index: state.index,
        volume: state.volume,
        muted: state.muted,
        mode: state.mode,
      };
      localStorage.setItem(LS_KEY, JSON.stringify(p));
    } catch {
      /* 配额超限等写入失败静默忽略：持久化是增强项，不该影响播放 */
    }
  }, 400);
}

let state: PlayerState = {
  current: null,
  queue: [],
  index: -1,
  isPlaying: false,
  progress: 0,
  duration: 0,
  volume: 0.9,
  muted: false,
  mode: 'list',
  ...(loadPersisted() ?? {}),
};

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}

function setState(patch: Partial<PlayerState>, skipPersist = false) {
  state = { ...state, ...patch };
  if (!skipPersist) persistSoon();
  emit();
}

function pickNext(): number {
  const n = state.queue.length;
  if (n === 0) return -1;
  if (state.mode === 'shuffle') return Math.floor(Math.random() * n);
  let i = state.index + 1;
  if (i >= n) i = 0;
  return i;
}

function pickPrev(): number {
  const n = state.queue.length;
  if (n === 0) return -1;
  if (state.mode === 'shuffle') return Math.floor(Math.random() * n);
  let i = state.index - 1;
  if (i < 0) i = n - 1;
  return i;
}

/* ==========================================================================
   v2.4.10 #16：切歌前先停旧音频。
   --------------------------------------------------------------------------
   现象：正在播放 → 暂停 → 搜索另一首 → 点播放，**旧歌会先响 1~2 秒**才切过去。

   根因是两处 effect 抢跑，谁都没先停：
     · AudioHost 的「播放/暂停」effect 只依赖 isPlaying，切歌时 isPlaying 由
       false→true，这个 effect 同步就跑，直接 a.play() —— 而此刻 <audio>.src
       还是**旧歌**，浏览器接着上次的 currentTime 往下放 → 旧歌出声。
     · 同一时刻「切歌」effect 也在跑，但它第一件事是 await resolvePlay()，
       新歌没有缓存直链时要发网络请求（getPlayUrl），往返就是你听到的 1~2 秒。

   这里在 store 侧把「切歌 = 先停旧的」写进语义：所有主动切歌入口先同步 pause()，
   物理上掐断旧声；AudioHost 侧再用 loadedKeyRef 兜底校验（见 AudioHost.tsx）。

   ⚠️ 刻意不放在 toggle() / pause() 里 —— 那两条路径本身就是「停」，会自己停死。
   ========================================================================== */
function stopAudio() {
  if (audioElRef && !audioElRef.paused) audioElRef.pause();
}

/**
 * v2.4.10 #4：把当前音频从头重播（单曲循环 / 单曲队列播完时用）。
 *
 * 与 stopAudio() 的区别：这不是「切歌」，src 不变，所以不能走 AudioHost 的换源流程
 * —— 那条路会因为「URL 没变」而跳过 reload。这里直接操作元素：
 * currentTime 归零 → play()。
 */
function restartElement() {
  if (!audioElRef) return;
  try {
    audioElRef.currentTime = 0;
    audioElRef.play().catch(() => { /* 自动播放被拦：由 isPlaying 状态与用户手势兜底 */ });
  } catch {
    /* 元素尚未 ready 等异常：静默，AudioHost 的 isPlaying effect 会再试一次 */
  }
}

export const player = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  getState() {
    return state;
  },

  /**
   * v2.4.8 #6/#7：单曲播放不再清空队列。
   *
   * 旧实现 `setState({ ... queue: [] })` 每次点歌都把队列清空 ——
   * 搜索结果点一首歌后，播放列表页显示「单曲播放，没有队列」，
   * 返回搜索再点同一首也不会累积，与主流音乐 App 的「点歌即入队」行为不一致。
   *
   * 新语义（对齐主流 App）：
   *   · 同一首歌已在队列里 → 跳到它，保留整个队列；
   *   · 不在队列里         → 追加到队尾并播放它（队列只增不减）。
   * 这样「搜歌 → 播放 → 返回搜索 → 再点」就能看到前面播过的歌仍在队列中。
   */
  playItem(item: MediaItem) {
    stopAudio(); // v2.4.10 #16：先停旧音频，否则旧歌会先响 1~2 秒
    const key = (x: MediaItem) => `${x.sourceId}:${x.id}`;
    const k = key(item);
    const exist = state.queue.findIndex((q) => key(q) === k);
    if (exist >= 0) {
      const queue = state.queue.map((q, i) => (i === exist ? { ...q, ...item } : q));
      setState({ queue, index: exist, current: queue[exist], isPlaying: true, progress: 0, duration: 0 });
      return;
    }
    const queue = [...state.queue, item];
    setState({ queue, index: queue.length - 1, current: item, isPlaying: true, progress: 0, duration: 0 });
  },

  playQueue(items: MediaItem[], startIndex = 0) {
    if (items.length === 0) return; // 空列表不该打断正在播的歌
    stopAudio(); // v2.4.10 #16：先停旧音频（必须放在上面的 return 之后）
    const idx = Math.max(0, Math.min(startIndex, items.length - 1));
    setState({ queue: items, index: idx, current: items[idx], isPlaying: true, progress: 0, duration: 0 });
  },

  enqueue(items: MediaItem[]) {
    const queue = [...state.queue, ...items];
    const patch: Partial<PlayerState> = { queue };
    if (!state.current) {
      patch.current = queue[0];
      patch.index = 0;
      patch.isPlaying = true;
    }
    setState(patch);
  },

  toggle() {
    if (!state.current) return;
    setState({ isPlaying: !state.isPlaying });
  },

  next() {
    // v2.4.10 #4：单曲队列（或只有一个可播项）时不切歌。
    //
    // 旧实现在 queue.length === 1 时 pickNext() 会算回 index 0 —— 也就是「切到自己」。
    // 于是 setState 把 progress/duration 清 0、isPlaying 置 true，AudioHost 那边
    // URL 没变所以不 reload，声音继续播；用户看到的是「上滑一下，歌没变但进度跳了、
    // 歌词空了」。播放页的上滑手势很容易在滚动歌词时被误判成切歌，这条路径必须堵死。
    if (state.queue.length <= 1) return;
    const i = pickNext();
    if (i < 0) return;
    stopAudio(); // v2.4.10 #16：切歌前先停旧音频
    setState({ index: i, current: state.queue[i], isPlaying: true, progress: 0, duration: 0 });
  },

  prev() {
    if (state.progress > 3) {
      setState({ progress: 0 });
      return;
    }
    if (state.queue.length <= 1) return; // v2.4.10 #4：同上，单曲队列不切
    const i = pickPrev();
    if (i < 0) return;
    stopAudio(); // v2.4.10 #16：切歌前先停旧音频
    setState({ index: i, current: state.queue[i], isPlaying: true, progress: 0, duration: 0 });
  },

  playAt(index: number) {
    if (index < 0 || index >= state.queue.length) return;
    stopAudio(); // v2.4.10 #16：切歌前先停旧音频
    setState({ index, current: state.queue[index], isPlaying: true, progress: 0, duration: 0 });
  },

  // v2.4.8 #1：改为接受 Partial<MediaItem>，便于只回写歌词（updateCurrent({ lyric })）等增量字段。
  // 仍固定沿用原曲的 id/sourceId，避免被增量补丁意外改掉曲目身份。
  updateCurrent(item: Partial<MediaItem>) {
    if (!state.current) return;
    setState({ current: { ...state.current, ...item, id: state.current.id, sourceId: state.current.sourceId } });
  },

  clearQueue() {
    setState({ queue: [], index: -1, current: null, isPlaying: false });
  },

  // 队列重排（拖拽）
  reorderQueue(from: number, to: number) {
    const q = [...state.queue];
    if (from < 0 || to < 0 || from >= q.length || to >= q.length) return;
    const [moved] = q.splice(from, 1);
    q.splice(to, 0, moved);
    let index = state.index;
    if (state.index === from) index = to;
    else if (from < state.index && to >= state.index) index--;
    else if (from > state.index && to <= state.index) index++;
    setState({ queue: q, index });
  },

  removeFromQueue(i: number) {
    const q = state.queue.filter((_, k) => k !== i);
    let index = state.index;
    if (i < state.index) index--;
    else if (i === state.index) index = Math.max(0, Math.min(index, q.length - 1));
    setState({
      queue: q,
      index,
      current: q[index] ?? null,
      isPlaying: q.length > 0,
    });
  },

  enqueueAt(item: MediaItem, at: number) {
    const q = [...state.queue];
    q.splice(at, 0, item);
    let index = state.index;
    if (at <= state.index) index++;
    setState({ queue: q, index });
  },

  attachAudio(el: HTMLAudioElement | null) {
    audioElRef = el;
  },
  attachVideo(el: HTMLVideoElement | null) {
    videoElRef = el;
  },

  seek(t: number) {
    // progress 不持久化（由 <audio> 重建），跳过落盘避免高频写
    setState({ progress: t }, true);
    if (audioElRef) audioElRef.currentTime = t;
    if (videoElRef) videoElRef.currentTime = t;
  },
  /**
   * v2.4.10 #5：过滤掉 NaN / Infinity / 负数时长。
   *
   * 旧实现 `if (d !== state.duration) setState({ duration: d })` 原样接收。
   * 而连续 seek 会让 <audio> 内部重载、重新触发 loadedmetadata —— 此刻 duration
   * 可能是 NaN。NaN 一旦写进 state 就再也出不来（NaN !== NaN 恒为 true，
   * 于是后面每次 setDuration(NaN) 都会再触发一次 setState，连带刷屏）：
   *   FullScreenPlayer 的 `pct = duration > 0 ? ... : 0` → NaN > 0 为 false → pct = 0
   *   → 滑块被推到最左（视觉上「滑块消失了」），时间显示 0:00。
   * 这里只接受有限正数，NaN 直接丢弃，state.duration 保持上一次的有效值。
   */
  setDuration(d: number) {
    if (!Number.isFinite(d) || d <= 0) return;
    if (d !== state.duration) setState({ duration: d }, true);
  },
  setProgress(p: number) {
    if (!Number.isFinite(p) || p < 0) return; // v2.4.10 #5：同上，NaN 进度一律丢弃
    if (Math.abs(p - state.progress) > 0.25) setState({ progress: p }, true);
  },
  setVolume(v: number) {
    setState({ volume: v, muted: v === 0 });
  },
  setMuted(m: boolean) {
    setState({ muted: m });
  },
  setMode(m: PlayMode) {
    setState({ mode: m });
  },

  onEnded() {
    // v2.4.10 #4：单曲队列的循环兜底。
    //
    // next() 现在遇到 length <= 1 会直接 return（那是为了堵死"上滑误切歌"），
    // 但「一首歌播完了」是**合法**的循环场景，必须继续播 ——
    // 否则单曲队列播完一次就彻底静音。
    //
    // ⚠️ 不能只 setState —— <audio> 的 src 没变，AudioHost 那个「URL 没变不 reload」
    //    的优化会让它保持"已播完"状态，isPlaying 置 true 也放不出声。
    //    所以这里必须直接操作元素：先把 currentTime 归零，再 play()。
    if (state.mode === 'one' && state.current) {
      restartElement();
      setState({ progress: 0, isPlaying: true });
    } else if (state.queue.length <= 1) {
      if (!state.current) return;
      restartElement();
      setState({ index: 0, current: state.queue[0] ?? state.current, isPlaying: true, progress: 0 });
    } else {
      player.next();
    }
  },
};

export function usePlayer() {
  return useSyncExternalStore(player.subscribe, player.getState);
}

// 供频谱可视化读取真实 <audio> 元素
export function getAudioElement(): HTMLAudioElement | null {
  return audioElRef;
}

export function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
