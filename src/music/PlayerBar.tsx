import { useEffect, useRef } from 'react';
import { usePlayer, fmtTime, player } from '../lib/playerStore';
import { useMediaResolver } from '../lib/playback';
import type { useLibrary } from '../lib/library';
import { SourceConfig } from '../engine/types';
import { gradientFor, initial } from '../lib/cover';
import { Icon } from '../components/Icon';

type LibraryReturn = ReturnType<typeof useLibrary>;

const MODE_ICON: Record<string, 'repeat' | 'repeat-one' | 'shuffle'> = { list: 'repeat', one: 'repeat-one', shuffle: 'shuffle' };

export function PlayerBar({
  sources,
  library,
  onOpenFullscreen,
}: {
  sources: SourceConfig[];
  library: LibraryReturn;
  onOpenFullscreen: () => void;
}) {
  const state = usePlayer();
  const { ensureResolved } = useMediaResolver(sources);
  const audioRef = useRef<HTMLAudioElement>(null);

  // 切换曲目：解析并加载（恢复上次进度，做到「关掉再开接着听」）
  useEffect(() => {
    if (!state.current) return;
    const it = state.current;
    const key = `${it.sourceId}:${it.id}`;
    const resumeAt = library.lib.watchProgress[key];
    let alive = true;
    ensureResolved(it).then((resolved) => {
      if (!alive || !audioRef.current) return;
      const a = audioRef.current;
      a.src = resolved.playUrl || '';
      a.load();
      const onMeta = () => {
        a.removeEventListener('loadedmetadata', onMeta);
        if (resumeAt && resumeAt > 3 && resumeAt < a.duration - 3) a.currentTime = resumeAt;
      };
      a.addEventListener('loadedmetadata', onMeta);
      if (state.isPlaying) a.play().catch(() => {});
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.current?.id]);

  // 播放/暂停
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !state.current) return;
    if (state.isPlaying) a.play().catch(() => {});
    else a.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.isPlaying]);

  // 挂载音频元素到全局播放器，便于全屏页控制进度
  useEffect(() => {
    player.attachAudio(audioRef.current);
    return () => player.attachAudio(null);
  }, []);

  // 音量
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = state.muted ? 0 : state.volume;
  }, [state.volume, state.muted]);

  if (!state.current) return null;
  const it = state.current;
  const fav = library.isFavorite(it);

  return (
    <div className="player mini">
      <audio
        ref={audioRef}
        onTimeUpdate={(e) => {
          const a = e.target as HTMLAudioElement;
          player.setProgress(a.currentTime);
          if (state.current && a.duration) library.setWatchProgress(`${state.current.sourceId}:${state.current.id}`, a.currentTime);
        }}
        onLoadedMetadata={(e) => player.setDuration((e.target as HTMLAudioElement).duration)}
        onEnded={() => player.onEnded()}
      />
      <div className="player-cover" onClick={onOpenFullscreen} title="打开播放页">
        {it.cover ? <img src={it.cover} alt="" /> : <span className="ph" style={{ background: gradientFor(it.title) }}>{initial(it.title)}</span>}
      </div>
      <div className="player-meta" onClick={onOpenFullscreen}>
        <div className="ptitle">{it.title}</div>
        <div className="psub">{it.artist ?? it.year ?? ''} · {it.sourceName}</div>
      </div>

      <div className="player-ctrl">
        <button className="icon" onClick={() => player.prev()} title="上一首"><Icon name="skip-back" /></button>
        <button className="icon play" onClick={() => player.toggle()} title={state.isPlaying ? '暂停' : '播放'}>
          <Icon name={state.isPlaying ? 'pause' : 'play'} />
        </button>
        <button className="icon" onClick={() => player.next()} title="下一首"><Icon name="skip-forward" /></button>
      </div>

      <div className="player-progress">
        <span className="t">{fmtTime(state.progress)}</span>
        <input
          type="range"
          min={0}
          max={state.duration || 0}
          value={state.progress}
          onChange={(e) => player.seek(Number(e.target.value))}
        />
        <span className="t">{fmtTime(state.duration)}</span>
      </div>

      <div className="player-side">
        <button className="icon" onClick={() => player.setMode(state.mode === 'list' ? 'one' : state.mode === 'one' ? 'shuffle' : 'list')} title="循环模式"><Icon name={MODE_ICON[state.mode]} /></button>
        <button className={'icon' + (fav ? ' fav' : '')} onClick={() => library.toggleFavorite(it)} title="收藏"><Icon name={fav ? 'heart-filled' : 'heart'} /></button>
        <div className="vol">
          <Icon name="volume" size={18} />
          <input type="range" min={0} max={1} step={0.01} value={state.volume} onChange={(e) => player.setVolume(Number(e.target.value))} />
        </div>
        <button className="icon" onClick={onOpenFullscreen} title="播放页"><Icon name="maximize" /></button>
        <button className="icon" onClick={() => player.clearQueue()} title="关闭"><Icon name="x" /></button>
      </div>
    </div>
  );
}
