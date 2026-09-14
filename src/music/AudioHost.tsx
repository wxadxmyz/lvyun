import { useEffect, useRef } from 'react';
import { usePlayer, player } from '../lib/playerStore';
import { resolvePlay } from '../player';
import type { SourceConfig } from '../engine/types';
import type { useLibrary } from '../lib/library';
import { useToast } from '../lib/toast';

/**
 * v2.4.4 #0：全局音频宿主 —— 恢复 App 的播放能力。
 *
 * 【背景 / 为什么必须补这个文件】
 * v2.4.0（commit 87bd2fc）把 src/music/PlayerBar.tsx 当作「死代码」删除了
 * （commit message: "E2 删除死代码 PlayerBar + 清理 .player.* CSS"），
 * 而那个组件是**全项目唯一持有 <audio> 元素并调用 .play() 的地方**。
 * 删除后没有任何组件接替，于是 App 从 v2.4.0 起失去了播放能力：
 *   点击歌曲 → player.playItem() → 状态机 current/isPlaying 变了
 *            → 但没人创建 <audio>、没人调 .play()
 *            → 完全静音，进度条恒 0:00（onTimeUpdate 永不触发），无任何报错。
 *
 * 【本组件职责】
 *   1. 持有唯一的 <audio> 元素（模块/组件内单例，绝不重复创建 ——
 *      WebAudio 侧一个 <audio> 一生只能 createMediaElementSource 一次，见 spectrum.ts）；
 *   2. current 变化 → resolvePlay() 取直链 → src/load/play，并恢复上次听的位置（续听）；
 *   3. isPlaying 变化 → play() / pause()；
 *   4. 注册/注销到全局 player（player.attachAudio），让进度条、倍速、音量、
 *      seek、睡眠定时、EQ/频谱等所有依赖 getAudioElement() 的功能全部复活；
 *   5. onTimeUpdate / onLoadedMetadata / onEnded 回写 player 状态与观看进度；
 *   6. onError 必须可见地提示 —— 此前播放失败是彻底静默的，这是最难排查的一点。
 *
 * 【挂载位置】MusicApp 顶层（<div className="app"> 内、<main> 之外），
 * 保证不随 Tab 切换/播放页开关而卸载，音频连续不断。
 */
export function AudioHost({
  sources,
  library,
}: {
  sources: SourceConfig[];
  library: ReturnType<typeof useLibrary>;
}) {
  const state = usePlayer();
  const toast = useToast();
  const audioRef = useRef<HTMLAudioElement>(null);

  // 用 ref 持有易变的依赖，避免把它们写进 effect 依赖数组导致频繁重解析。
  // （sources / library 每次渲染都是新对象引用，直接进依赖会每帧重跑播放流程。）
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  /** 当前 <audio> 已装载的直链（用 dataset 而非 el.src，规避浏览器对 src 的绝对化改写） */
  const loadedUrlRef = useRef<string>('');

  // ── 注册到全局播放器 ────────────────────────────────────────────────
  // 卸载必须传 null，否则 player 会持有已销毁的元素引用，seek/倍速全部失效。
  useEffect(() => {
    player.attachAudio(audioRef.current);
    return () => player.attachAudio(null);
  }, []);

  // ── 切换曲目：解析直链 → load → 播放 ────────────────────────────────
  useEffect(() => {
    const it = state.current;
    const a = audioRef.current;
    if (!it || !a) return;

    const key = `${it.sourceId}:${it.id}`;
    const resumeAt = libraryRef.current.lib.watchProgress[key];
    let alive = true;

    resolvePlay(it, sourcesRef.current)
      .then((resolved) => {
        if (!alive) return; // 已经切到别的歌了，丢弃本次结果
        const el = audioRef.current;
        if (!el) return;

        const url = resolved.playUrl || '';
        if (!url) {
          toastRef.current.push('未取到播放地址，请检查该音源', 'err');
          return;
        }

        // 只有 URL 真的变了才 reload —— 否则「暂停后点同一首」会白白重新缓冲。
        if (loadedUrlRef.current !== url) {
          loadedUrlRef.current = url;
          el.src = url;
          el.load();
          // 续听：仅在切到新曲目时定位（放在首自动恢复会造成进度倒跳）
          const onMeta = () => {
            el.removeEventListener('loadedmetadata', onMeta);
            if (resumeAt && resumeAt > 3 && el.duration && resumeAt < el.duration - 3) {
              el.currentTime = resumeAt;
            }
          };
          el.addEventListener('loadedmetadata', onMeta);
        }

        if (state.isPlaying) el.play().catch(() => {});
      })
      .catch((e: unknown) => {
        if (!alive) return;
        toastRef.current.push((e as Error)?.message || '播放失败', 'err');
      });

    return () => {
      alive = false;
    };
    // 只在「曲目身份」变化时重跑；isPlaying 由下面的 effect 单独处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.current?.id, state.current?.sourceId]);

  // ── 播放 / 暂停 ────────────────────────────────────────────────────
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !state.current) return;
    if (state.isPlaying) a.play().catch(() => {});
    else a.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.isPlaying]);

  // ── 音量 / 静音 ────────────────────────────────────────────────────
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = state.muted ? 0 : state.volume;
  }, [state.volume, state.muted]);

  // 无 controls 的 <audio> 不占布局，这里不需要额外样式。
  return (
    <audio
      ref={audioRef}
      preload="metadata"
      // crossOrigin 不设：多数音乐源直链不支持 CORS，设了反而会加载失败。
      onTimeUpdate={(e) => {
        const a = e.target as HTMLAudioElement;
        player.setProgress(a.currentTime);
        const it = state.current;
        if (it && a.duration) {
          libraryRef.current.setWatchProgress(`${it.sourceId}:${it.id}`, a.currentTime);
        }
      }}
      onLoadedMetadata={(e) => player.setDuration((e.target as HTMLAudioElement).duration)}
      onEnded={() => player.onEnded()}
      onError={() => {
        // v2.4.4 #0：播放失败必须让用户看见。
        // 此前这里什么都没有 —— 源挂了 / 地址失效 / 明文 HTTP 被拦，
        // 表现都是「点了没反应」，完全无法自查。
        toastRef.current.push('播放失败：地址无效或网络不可用', 'err');
      }}
    />
  );
}
