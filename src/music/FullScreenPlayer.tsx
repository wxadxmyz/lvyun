import { useEffect, useRef, useState } from 'react';
import { usePlayer, fmtTime, player, getAudioElement } from '../lib/playerStore';
import { getAnalyser, getEqGains, setEqGains, subscribeEq, EQ_PRESETS, EQ_BANDS } from '../lib/spectrum';
import { useSettings } from '../lib/settings';
import type { useLibrary } from '../lib/library';
import { SourceConfig } from '../engine/types';
import { gradientFor, initial } from '../lib/cover';
import { Icon } from '../components/Icon';

const MODE_ICON: Record<string, { icon: 'repeat' | 'repeat-one' | 'shuffle'; label: string }> = {
  list: { icon: 'repeat', label: '列表循环' },
  one: { icon: 'repeat-one', label: '单曲循环' },
  shuffle: { icon: 'shuffle', label: '随机播放' },
};
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
type SleepMode = 'off' | '15' | '30' | '60' | 'end';

// 计算当前歌词高亮行
function activeIndex(lines: { time: number; text: string }[], progress: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= progress + 0.2) idx = i;
    else break;
  }
  return idx;
}

export function FullScreenPlayer({
  sources,
  library,
  onClose,
}: {
  sources: SourceConfig[];
  library: ReturnType<typeof useLibrary>;
  onClose: () => void;
}) {
  const state = usePlayer();
  const { settings, update } = useSettings();
  const [showQueue, setShowQueue] = useState(false);
  const [showEq, setShowEq] = useState(false);
  const [showSleep, setShowSleep] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [speed, setSpeed] = useState(settings.playbackRate || 1);
  const [eqGains, setEqGainsLocal] = useState<number[]>(getEqGains());
  const [eqPreset, setEqPreset] = useState('关闭');
  const [sleepMode, setSleepMode] = useState<SleepMode>(
    settings.sleepEnd ? 'end' : settings.sleepTimer > 0 ? (String(settings.sleepTimer) as SleepMode) : 'off',
  );
  // 应用到播放器并持久化到设置（与设置页睡眠定时子页共用一份状态）
  const applySleep = (m: SleepMode) => {
    setSleepMode(m);
    if (m === 'off') update({ sleepTimer: 0, sleepEnd: false });
    else if (m === 'end') update({ sleepTimer: 0, sleepEnd: true });
    else update({ sleepTimer: Number(m), sleepEnd: false });
  };
  useEffect(() => {
    setSleepMode(settings.sleepEnd ? 'end' : settings.sleepTimer > 0 ? (String(settings.sleepTimer) as SleepMode) : 'off');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.sleepTimer, settings.sleepEnd]);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const sleepTimer = useRef<number | undefined>(undefined);

  if (!state.current) return null;
  const it = state.current;
  const fav = library.isFavorite(it);

  // 歌词：优先用带时间轴的 LyricLine，其次降级的字符串数组
  const lyricLines: { time: number; text: string }[] = Array.isArray(it.lyric)
    ? it.lyric.map((l) => ({ time: l.time, text: l.text }))
    : Array.isArray(it.raw?.lyric)
    ? (it.raw.lyric as string[]).map((t: string) => ({ time: 0, text: t }))
    : [];
  const aLine = lyricLines.length ? activeIndex(lyricLines, state.progress) : -1;

  // 频谱可视化：把真实 <audio> 接到 analyser（EQ 之后），单例避免重复创建
  useEffect(() => {
    const audio = getAudioElement();
    const canvas = canvasRef.current;
    if (!audio || !canvas) return;
    const analyser = getAnalyser(audio);
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const ctx2d = canvas.getContext('2d')!;

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(data);
      const w = canvas.width;
      const h = canvas.height;
      ctx2d.clearRect(0, 0, w, h);
      const bars = data.length;
      const gap = 3;
      const bw = (w - gap * (bars - 1)) / bars;
      const a1 = getCss('--accent') || '#6a8cff';
      const a2 = getCss('--accent2') || '#b15bff';
      for (let i = 0; i < bars; i++) {
        const v = data[i] / 255;
        const bh = Math.max(2, v * h);
        const grad = ctx2d.createLinearGradient(0, h, 0, h - bh);
        grad.addColorStop(0, a1);
        grad.addColorStop(1, a2);
        ctx2d.fillStyle = grad;
        ctx2d.fillRect(i * (bw + gap), h - bh, bw, bh);
      }
    };
    draw();
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [it.id]);

  // 倍速：同步到 <audio> 并记忆
  useEffect(() => {
    const a = getAudioElement();
    if (a) a.playbackRate = speed;
    update({ playbackRate: speed });
  }, [speed]);

  // EQ：本地编辑实时应用到处理图，并订阅跨组件同步
  useEffect(() => { setEqGains(eqGains); }, [eqGains]);
  useEffect(() => subscribeEq(() => setEqGainsLocal(getEqGains())), []);

  // 睡眠定时器：到点淡出后暂停
  const fadeOutAndPause = () => {
    const a = getAudioElement();
    if (!a) { player.toggle(); return; }
    const target = a.volume;
    const start = performance.now();
    const step = () => {
      const t = (performance.now() - start) / 3000;
      if (t >= 1) { a.volume = target; player.toggle(); applySleep('off'); return; }
      a.volume = target * (1 - t);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  useEffect(() => {
    clearTimeout(sleepTimer.current);
    if (sleepMode === 'off' || sleepMode === 'end') return;
    sleepTimer.current = window.setTimeout(fadeOutAndPause, Number(sleepMode) * 60000);
    return () => clearTimeout(sleepTimer.current);
  }, [sleepMode]);
  useEffect(() => {
    if (sleepMode === 'end' && state.duration > 0 && state.progress >= state.duration - 1) fadeOutAndPause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sleepMode, state.progress, state.duration]);

  function getCss(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  const drop = (to: number) => {
    if (dragIndex !== null && dragIndex !== to) player.reorderQueue(dragIndex, to);
    setDragIndex(null);
  };

  return (
    <div
      className="fs-player"
      onTouchStart={(e) => { swipeStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
      onTouchEnd={(e) => {
        if (!swipeStart.current) return;
        const dy = e.changedTouches[0].clientY - swipeStart.current.y;
        const dx = e.changedTouches[0].clientX - swipeStart.current.x;
        swipeStart.current = null;
        // 上下滑切歌（仅在纵向位移明显时）
        if (Math.abs(dy) > 50 && Math.abs(dy) > Math.abs(dx)) {
          if (dy < 0) player.next();
          else player.prev();
        }
      }}
    >
      <div
        className="fs-bg"
        style={{ backgroundImage: it.cover ? `url(${it.cover})` : gradientFor(it.title) }}
      />
      <div className="fs-top">
        <button className="icon" onClick={onClose} title="收起"><Icon name="chevron-down" /></button>
        <span className="fs-now">正在播放 · {it.sourceName}</span>
        <button className="icon" onClick={() => setShowQueue((v) => !v)} title="播放队列"><Icon name="list" /></button>
      </div>

      <div className="fs-body">
        <div className="fs-disc-wrap" onClick={() => setLyricsOpen((v) => !v)} style={{ cursor: 'pointer' }}>
          <div className={'fs-disc' + (state.isPlaying ? ' spinning' : '')}>
            {it.cover ? <img src={it.cover} alt="" /> : <span className="ph" style={{ background: gradientFor(it.title) }}>{initial(it.title)}</span>}
          </div>
          <div className="fs-needle" />
          <canvas ref={canvasRef} className="fs-spectrum" width={300} height={64} />
          <span className="fs-tap-hint">点击看歌词</span>
        </div>

        <div className="fs-info">
          <h1 className="fs-title">{it.title}</h1>
          <div className="fs-artist">{it.artist ?? ''} {it.album ? '· 《' + it.album + '》' : ''}</div>

          <div className="fs-lyric">
            {lyricLines.length ? (
              lyricLines.map((l, i) => (
                <p key={i} className={'lyric-line' + (i === aLine ? ' active' : '')}>{l.text || '·'}</p>
              ))
            ) : (
              <p className="lyric-line muted">[ 暂无歌词 ] 接入真实音源后将逐行显示歌词。</p>
            )}
          </div>

          <div className="fs-progress">
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

          <div className="fs-tools">
            <select className="fs-speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="倍速">
              {SPEEDS.map((s) => <option key={s} value={s}>{s === 1 ? '原速' : s + 'x'}</option>)}
            </select>
            <button className={'icon' + (showEq ? ' active' : '')} onClick={() => setShowEq((v) => !v)} title="均衡器"><Icon name="sliders" /> 音效</button>
            <button className={'icon' + (sleepMode !== 'off' ? ' active' : '')} onClick={() => setShowSleep((v) => !v)} title="睡眠定时">
              {sleepMode === 'off' ? <><Icon name="clock" size={16} /> 定时</> : <><Icon name="clock" size={16} /> {sleepMode === 'end' ? '播完' : sleepMode + '分'}</>}
            </button>
          </div>

          <div className="fs-ctrl">
            <button className="icon" onClick={() => player.setMode(state.mode === 'list' ? 'one' : state.mode === 'one' ? 'shuffle' : 'list')} title="循环模式"><Icon name={MODE_ICON[state.mode].icon} /></button>
            <button className="icon big" onClick={() => player.prev()} title="上一首"><Icon name="skip-back" /></button>
            <button className="icon play big" onClick={() => player.toggle()} title={state.isPlaying ? '暂停' : '播放'}><Icon name={state.isPlaying ? 'pause' : 'play'} /></button>
            <button className="icon big" onClick={() => player.next()} title="下一首"><Icon name="skip-forward" /></button>
            <button className={'icon' + (fav ? ' fav' : '')} onClick={() => library.toggleFavorite(it)} title="收藏"><Icon name={fav ? 'heart-filled' : 'heart'} /></button>
            <div className="vol">
              <Icon name="volume" size={18} />
              <input type="range" min={0} max={1} step={0.01} value={state.volume} onChange={(e) => player.setVolume(Number(e.target.value))} />
            </div>
          </div>
        </div>
      </div>

      {/* 均衡器面板 */}
      {showEq && (
        <div className="fs-panel">
          <div className="fs-panel-head">均衡器
            <button className="link" onClick={() => { setEqPreset('关闭'); setEqGainsLocal([...EQ_PRESETS[0].gains]); }}>重置</button>
          </div>
          <div className="eq-presets">
            {EQ_PRESETS.map((p) => (
              <button key={p.name} className={'mini' + (eqPreset === p.name ? ' active' : '')}
                onClick={() => { setEqPreset(p.name); setEqGainsLocal([...p.gains]); }}>{p.name}</button>
            ))}
          </div>
          <div className="eq-sliders">
            {EQ_BANDS.map((f, i) => (
              <div key={i} className="eq-band">
                <input type="range" min={-12} max={12} step={1} value={eqGains[i]}
                  onChange={(e) => { setEqPreset('自定义'); const g = [...eqGains]; g[i] = Number(e.target.value); setEqGainsLocal(g); }} />
                <span className="eq-label">{f >= 1000 ? f / 1000 + 'k' : f}</span>
                <span className="eq-val">{eqGains[i] > 0 ? '+' : ''}{eqGains[i]}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 睡眠定时面板 */}
      {showSleep && (
        <div className="fs-panel">
          <div className="fs-panel-head">睡眠定时（到时淡出暂停）</div>
          <div className="eq-presets">
            {([['off', '关闭'], ['15', '15 分钟'], ['30', '30 分钟'], ['60', '60 分钟'], ['end', '播完本曲']] as [SleepMode, string][]).map(([m, label]) => (
              <button key={m} className={'mini' + (sleepMode === m ? ' active' : '')} onClick={() => applySleep(m)}>{label}</button>
            ))}
          </div>
        </div>
      )}

      {showQueue && (
        <div className="fs-queue">
          <div className="fs-queue-head">
            播放队列（{state.queue.length}）
            <span className="muted sm">可拖拽排序</span>
            {state.queue.length > 0 && <button className="link danger" onClick={() => player.clearQueue()}>清空</button>}
          </div>
          <div className="fs-queue-list">
            {state.queue.map((q, i) => (
              <div
                key={i}
                className={'fs-queue-item' + (i === state.index ? ' active' : '') + (dragIndex === i ? ' dragging' : '')}
                draggable
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => drop(i)}
                onClick={() => player.playAt(i)}
              >
                <span className="qidx">{i === state.index ? <Icon name="play" size={14} /> : i + 1}</span>
                <span className="qtitle">{q.title}</span>
                <span className="qsub">{q.artist ?? ''}</span>
                {i !== state.index && (
                  <button className="mini" title="下一首播放" onClick={(e) => { e.stopPropagation(); player.enqueueAt(q, state.index + 1); }}><Icon name="skip-forward" size={14} /></button>
                )}
                <button className="mini" title="移除" onClick={(e) => { e.stopPropagation(); player.removeFromQueue(i); }}><Icon name="x" size={14} /></button>
              </div>
            ))}
            {state.queue.length === 0 && <div className="muted sm">当前为单曲播放，没有队列。</div>}
          </div>
        </div>
      )}

      {lyricsOpen && (
        <div className="fs-lyrics-full" onClick={() => setLyricsOpen(false)}>
          {lyricLines.length ? (
            lyricLines.map((l, i) => (
              <p key={i} className={'lyric-line' + (i === aLine ? ' active' : '')}>{l.text || '·'}</p>
            ))
          ) : (
            <p className="lyric-line muted">[ 暂无歌词 ] 接入真实音源后将逐行显示歌词。</p>
          )}
        </div>
      )}
    </div>
  );
}
