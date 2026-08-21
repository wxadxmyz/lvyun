import { useEffect, useRef, useState } from 'react';
import { usePlayer, fmtTime, player, getAudioElement } from '../lib/playerStore';
import { getEqGains, setEqGains, subscribeEq, EQ_PRESETS, EQ_BANDS } from '../lib/spectrum';
import { useSettings } from '../lib/settings';
import type { useLibrary } from '../lib/library';
import { SourceConfig } from '../engine/types';
import { gradientFor } from '../lib/cover';
import { Icon } from '../components/Icon';
import { useToast } from '../lib/toast';

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
  const toast = useToast();
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [menuView, setMenuView] = useState<'main' | 'add' | 'speed' | 'timer'>('main');
  const [showAuthor, setShowAuthor] = useState(false);
  const [showLandscape, setShowLandscape] = useState(false);
  const [showEq, setShowEq] = useState(false);
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

  // 播放器内部浮层纳入系统返回手势栈：返回先关最上层浮层，再交由 MusicApp 退出播放页
  useEffect(() => {
    (window as any).__playerBack = () => {
      if (showPlaylist) { setShowPlaylist(false); return true; }
      if (showAuthor) { setShowAuthor(false); return true; }
      if (showLandscape) { setShowLandscape(false); return true; }
      if (showMenu) {
        if (menuView !== 'main') { setMenuView('main'); return true; }
        setShowMenu(false); return true;
      }
      if (showEq) { setShowEq(false); return true; }
      if (lyricsOpen) { setLyricsOpen(false); return true; }
      return false;
    };
    return () => { delete (window as any).__playerBack; };
  }, [showPlaylist, showAuthor, showLandscape, showMenu, menuView, showEq, lyricsOpen]);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const sleepTimer = useRef<number | undefined>(undefined);

  const it = state.current ?? ({ title: '未在播放', artist: '', album: '', id: '', sourceId: '', cover: undefined, lyric: [] } as any);
  const empty = !state.current;
  const fav = state.current ? library.isFavorite(it) : false;
  const nowText = empty ? '未在播放' : '正在播放';

  // 歌词：优先用带时间轴的 LyricLine，其次降级的字符串数组
  const lyricLines: { time: number; text: string }[] = Array.isArray(it.lyric)
    ? it.lyric.map((l: any) => ({ time: l.time, text: l.text }))
    : Array.isArray(it.raw?.lyric)
    ? (it.raw.lyric as string[]).map((t: string) => ({ time: 0, text: t }))
    : [];
  const aLine = lyricLines.length ? activeIndex(lyricLines, state.progress) : -1;

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

  const drop = (to: number) => {
    if (dragIndex !== null && dragIndex !== to) player.reorderQueue(dragIndex, to);
    setDragIndex(null);
  };

  // 更多菜单：6 个圆形图标网格项
  const MORE_ITEMS: { key: string; icon: any; label: string; onClick: () => void }[] = [
    { key: 'add', icon: 'plus', label: '加歌单', onClick: () => setMenuView('add') },
    { key: 'speed', icon: 'gauge', label: '倍速播放', onClick: () => setMenuView('speed') },
    { key: 'artist', icon: 'user', label: '查看作者', onClick: () => { setShowMenu(false); setShowAuthor(true); } },
    { key: 'timer', icon: 'clock', label: '定时关闭', onClick: () => setMenuView('timer') },
    {
      key: 'order', icon: 'list', label: '顺序播放',
      onClick: () => { player.setMode('list'); toast.push('已切换：列表循环'); setShowMenu(false); },
    },
    { key: 'land', icon: 'maximize', label: '横屏播放', onClick: () => { setShowMenu(false); setShowLandscape(true); } },
  ];

  // 进度百分比（粉红填充轨道用）
  const pct = state.duration > 0 ? Math.min(100, (state.progress / state.duration) * 100) : 0;

  // 作者主页：本列表内该艺术家的作品
  const artistTracks = state.queue.filter((q) => q.artist === it.artist);

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
      <style>{`
        .fs-player .fs-progress{ display:flex; flex-direction:column; align-items:stretch; gap:8px; }
        .fs-player .fs-progress input[type=range]{ -webkit-appearance:none; appearance:none; width:100%; height:4px; border-radius:2px; background:linear-gradient(to right, #ff5c8a var(--fill,0%), rgba(255,255,255,0.22) var(--fill,0%)); }
        .fs-player .fs-progress input[type=range]::-webkit-slider-thumb{ -webkit-appearance:none; appearance:none; width:16px; height:16px; border-radius:50%; background:#fff; box-shadow:0 0 0 4px rgba(255,255,255,0.16), 0 2px 8px rgba(0,0,0,0.3); }
        .fs-player .fs-progress input[type=range]::-moz-range-thumb{ width:16px; height:16px; border:none; border-radius:50%; background:#fff; }
        .fs-player .fs-progress-time{ display:flex; align-items:center; justify-content:center; gap:8px; font-size:12px; color:var(--muted); font-variant-numeric:tabular-nums; }
        .fs-player .fs-ctrl .play.big{ background:#ff5c8a !important; box-shadow:0 8px 24px rgba(255,92,138,0.5) !important; color:#fff !important; }
        .fs-player .fs-cover{ transition:box-shadow .3s; }
      `}</style>
      <div
        className="fs-bg"
        style={{
          backgroundImage: it.cover ? `url(${it.cover})` : undefined,
          backgroundColor: it.cover ? undefined : gradientFor(it.title),
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          filter: 'blur(40px) brightness(0.62)',
          transform: 'scale(1.25)',
        }}
      />
      {/* 仅一层很淡的压暗，保留封面泛出的彩色光晕（深色模式高亮） */}
      <div className="fs-bg-mask" style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.12)' }} />
      <div className="fs-top">
        <button className="icon" onClick={() => setShowPlaylist(true)} title="播放列表"><Icon name="menu" /></button>
        <span className="fs-now">{nowText}</span>
        <button className="icon" onClick={() => { setMenuView('main'); setShowMenu(true); }} title="更多"><Icon name="more-vertical" /></button>
      </div>

      <div className="fs-stage">
        <div className="fs-disc-wrap" onClick={() => setLyricsOpen((v) => !v)} style={{ cursor: 'pointer' }}>
          <div
            className={'fs-cover' + (state.isPlaying ? ' playing' : '')}
            style={{ borderRadius: 24, animation: 'none', boxShadow: '0 18px 48px rgba(0,0,0,0.5)', overflow: 'hidden', background: it.cover ? undefined : gradientFor(it.title) }}
          >
            {it.cover ? (
              <img src={it.cover} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <span className="fs-ph" style={{ width: '100%', height: '100%' }}>
                <Icon name="music" size={64} />
              </span>
            )}
          </div>
        </div>

        <div className="fs-meta">
          <h1 className="fs-title">{it.title}</h1>
          <div className="fs-artist">{it.artist ?? ''} {it.album ? '· 《' + it.album + '》' : ''}</div>
        </div>

        <div className="fs-ctrls">
          <div className="fs-progress" style={{ '--fill': `${pct}%` } as any}>
            <input
              type="range"
              min={0}
              max={state.duration || 0}
              value={state.progress}
              disabled={empty}
              onChange={(e) => player.seek(Number(e.target.value))}
            />
            <div className="fs-times">
              <span className="t">{fmtTime(state.progress)}</span>
              <span className="t">{fmtTime(state.duration)}</span>
            </div>
          </div>

          <div className="fs-btns">
            <button className="fs-btn" disabled={empty} onClick={() => player.setMode(state.mode === 'list' ? 'one' : state.mode === 'one' ? 'shuffle' : 'list')} title="循环模式"><Icon name={MODE_ICON[state.mode].icon} /></button>
            <button className="fs-btn" disabled={empty} onClick={() => player.prev()} title="上一首"><Icon name="skip-back" /></button>
            <button
              className="fs-btn play"
              onClick={() => player.toggle()}
              title={state.isPlaying ? '暂停' : '播放'}
            ><Icon name={state.isPlaying ? 'pause' : 'play'} /></button>
            <button className="fs-btn" disabled={empty} onClick={() => player.next()} title="下一首"><Icon name="skip-forward" /></button>
            <button className={'fs-btn' + (fav ? ' fav' : '')} disabled={empty} onClick={() => library.toggleFavorite(it)} title="收藏"><Icon name={fav ? 'heart-filled' : 'heart'} /></button>
          </div>
        </div>
      </div>

      {/* 均衡器面板（仍可从设置页进入，此处保留独立入口的轻量调用） */}
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

      {showPlaylist && (
        <div className="fs-playlist">
          <div className="fs-pl-head">
            <button className="icon" onClick={() => setShowPlaylist(false)} aria-label="返回"><Icon name="arrow-left" /></button>
            <span className="pl-title">播放列表</span>
            <button
              className="pl-mode"
              onClick={() => player.setMode(state.mode === 'list' ? 'one' : state.mode === 'one' ? 'shuffle' : 'list')}
            >
              <Icon name={MODE_ICON[state.mode].icon} size={15} /> {MODE_ICON[state.mode].label}
            </button>
          </div>
          <div className="fs-pl-list">
            {state.queue.map((q, i) => (
              <div
                key={i}
                className={'fs-pl-item' + (i === state.index ? ' active' : '') + (dragIndex === i ? ' dragging' : '')}
                draggable
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => drop(i)}
                onClick={() => player.playAt(i)}
              >
                <span className="pl-idx">{i === state.index ? <Icon name="play" size={13} /> : i + 1}</span>
                <div className="pl-meta">
                  <div className="pl-name">{q.title}</div>
                  <div className="pl-sub">{[q.artist, q.album].filter(Boolean).join(' · ') || '未知艺术家'}</div>
                </div>
                <button className={'mini' + (library.isFavorite(q) ? ' fav' : '')} title="收藏" onClick={(e) => { e.stopPropagation(); library.toggleFavorite(q); }}>
                  <Icon name={library.isFavorite(q) ? 'heart-filled' : 'heart'} size={15} />
                </button>
                <span className="pl-handle" title="拖拽排序"><Icon name="menu" size={16} /></span>
              </div>
            ))}
            {state.queue.length === 0 && <div className="muted sm" style={{ padding: 24, textAlign: 'center' }}>当前为单曲播放，没有队列。</div>}
          </div>
          <div className="fs-pl-foot">共 {state.queue.length} 首 · 可拖拽排序 · 点击播放</div>
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

      {/* 作者主页（完整页面） */}
      {showAuthor && (
        <div className="fs-author">
          <div className="fs-author-head">
            <button className="icon" onClick={() => setShowAuthor(false)} aria-label="返回"><Icon name="arrow-left" /></button>
            <div className="fs-author-ava">{(it.artist ?? '?').slice(0, 1)}</div>
          </div>
          <div className="fs-author-info">
            <div className="fs-author-name">{it.artist ?? '未知艺术家'}</div>
            <div className="fs-author-bio">原创音乐人 · 在律云与你相遇</div>
          </div>
          <div className="fs-author-stats">
            <div><div className="n">{artistTracks.length || 12}</div><div className="t">作品</div></div>
            <div><div className="n">0</div><div className="t">粉丝</div></div>
            <div><div className="n">0</div><div className="t">关注</div></div>
          </div>
          <div className="fs-author-acts">
            <button className="fs-pill primary2" onClick={() => { setShowAuthor(false); player.playAt(state.index); }}>关注</button>
            <button className="fs-pill" onClick={() => toast.push('已发送私信')}>私信</button>
          </div>
          <div className="fs-author-sec">热门作品</div>
          <div className="fs-author-tracks">
            {artistTracks.length > 0 ? artistTracks.map((q, i) => (
              <div key={i} className="fs-author-track" onClick={() => { setShowAuthor(false); player.playAt(state.index); }}>
                <span className="at-idx">{i + 1}</span>
                <span className="at-cover" style={{ background: gradientFor(q.title) }} />
                <span className="at-meta"><span className="at-name">{q.title}</span><span className="at-sub">{q.artist ?? ''}</span></span>
              </div>
            )) : (
              <div className="muted sm" style={{ padding: 16, textAlign: 'center' }}>列表内暂无该艺术家的其他作品。</div>
            )}
          </div>
        </div>
      )}

      {/* 横屏模式（整界面横置沉浸） */}
      {showLandscape && (
        <div className="fs-land">
          <button className="fs-land-exit icon" onClick={() => setShowLandscape(false)} aria-label="退出横屏"><Icon name="x" /></button>
          <div className="fs-land-bg">
            <div className="fs-land-orb a" />
            <div className="fs-land-orb b" />
            <div className="fs-land-orb c" />
          </div>
          <div className="fs-land-content">
            <div className="fs-land-cover" style={{ background: it.cover ? undefined : gradientFor(it.title), backgroundImage: it.cover ? `url(${it.cover})` : undefined, backgroundSize: 'cover', backgroundPosition: 'center' }} />
            <div className="fs-land-right">
              <div className="fs-land-title">{it.title}</div>
              <div className="fs-land-sub">{it.artist ?? ''} {it.album ? '· ' + it.album : ''}</div>
              <div className="fs-land-bar"><div className="fs-land-fill" style={{ width: `${pct}%` }} /></div>
              <div className="fs-land-times"><span>{fmtTime(state.progress)}</span><span>{fmtTime(state.duration)}</span></div>
              <div className="fs-land-ctrls">
                <button className="fs-btn" disabled={empty} onClick={() => player.setMode(state.mode === 'list' ? 'one' : state.mode === 'one' ? 'shuffle' : 'list')} title="循环"><Icon name={MODE_ICON[state.mode].icon} /></button>
                <button className="fs-btn" disabled={empty} onClick={() => player.prev()} title="上一首"><Icon name="skip-back" /></button>
                <button className="fs-btn play" onClick={() => player.toggle()} title={state.isPlaying ? '暂停' : '播放'}><Icon name={state.isPlaying ? 'pause' : 'play'} /></button>
                <button className="fs-btn" disabled={empty} onClick={() => player.next()} title="下一首"><Icon name="skip-forward" /></button>
                <button className={'fs-btn' + (fav ? ' fav' : '')} disabled={empty} onClick={() => library.toggleFavorite(it)} title="收藏"><Icon name={fav ? 'heart-filled' : 'heart'} /></button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showMenu && (
        <div className="fs-menu-mask" onClick={() => { setShowMenu(false); setMenuView('main'); }}>
          <div className="fs-sheet" onClick={(e) => e.stopPropagation()}>
            {menuView === 'main' && (
              <>
                <div className="fs-sheet-grip" />
                <div className="fs-grid">
                  {MORE_ITEMS.map((m) => (
                    <button key={m.key} className="fs-grid-item" onClick={m.onClick}>
                      <span className="fs-grid-circle"><Icon name={m.icon} size={26} /></span>
                      <span className="fs-grid-label">{m.label}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {menuView === 'add' && (
              <>
                <div className="fs-sheet-head">
                  <button className="icon" onClick={() => setMenuView('main')} aria-label="返回"><Icon name="arrow-left" /></button>
                  <span className="sh-title">添加到歌单</span>
                </div>
                <div className="fs-plpick">
                  <div className="fs-plpick-create" onClick={() => { const n = window.prompt('歌单名称'); if (n && n.trim()) library.createPlaylist(n.trim()); }}>
                    <span className="pc-ico"><Icon name="plus" size={18} /></span>
                    <span>创建新歌单</span>
                  </div>
                  {library.lib.playlists.map((p) => {
                    const added = p.items.some((x) => x.sourceId === it.sourceId && x.id === it.id);
                    return (
                      <div key={p.id} className={'fs-plpick-item' + (added ? ' added' : '')} onClick={() => library.addToPlaylist(p.id, it)}>
                        <span className="pi-cover" />
                        <span className="pi-name">{p.name}</span>
                        <span className="pi-count">{p.items.length} 首</span>
                        <span className="pi-check"><Icon name="check" size={14} /></span>
                      </div>
                    );
                  })}
                  {library.lib.playlists.length === 0 && <div className="muted sm" style={{ padding: 12 }}>还没有歌单，点上方创建。</div>}
                </div>
              </>
            )}

            {menuView === 'speed' && (
              <>
                <div className="fs-sheet-head">
                  <button className="icon" onClick={() => setMenuView('main')} aria-label="返回"><Icon name="arrow-left" /></button>
                  <span className="sh-title">倍速播放</span>
                </div>
                <div className="fs-speed-val">{speed === 1 ? '原速' : speed + 'x'}</div>
                <input className="fs-slider" type="range" min={0} max={SPEEDS.length - 1} step={1} value={SPEEDS.indexOf(speed)} onChange={(e) => setSpeed(SPEEDS[Number(e.target.value)])} />
                <div className="fs-speed-ticks">{SPEEDS.map((s) => <span key={s}>{s === 1 ? '原速' : s + 'x'}</span>)}</div>
                <div className="fs-pill-row">{SPEEDS.map((s) => <button key={s} className={'fs-pill' + (speed === s ? ' active' : '')} onClick={() => setSpeed(s)}>{s === 1 ? '原速' : s + 'x'}</button>)}</div>
              </>
            )}

            {menuView === 'timer' && (
              <>
                <div className="fs-sheet-head">
                  <button className="icon" onClick={() => setMenuView('main')} aria-label="返回"><Icon name="arrow-left" /></button>
                  <span className="sh-title">定时关闭</span>
                </div>
                <div className="fs-pill-row">
                  {([['off', '关闭'], ['15', '15 分'], ['30', '30 分'], ['60', '60 分'], ['end', '播完本曲']] as [SleepMode, string][]).map(([m, label]) => (
                    <button key={m} className={'fs-pill' + (sleepMode === m ? ' active' : '')} onClick={() => applySleep(m)}>{label}</button>
                  ))}
                </div>
                <label className="fs-radio-row" style={{ marginTop: 14 }}>
                  <input type="checkbox" checked={sleepMode === 'end'} onChange={(e) => applySleep(e.target.checked ? 'end' : 'off')} />
                  播完整首歌后停止
                </label>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
