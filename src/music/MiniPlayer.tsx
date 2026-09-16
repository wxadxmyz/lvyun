import { player, usePlayer } from '../lib/playerStore';
import { Icon } from '../components/Icon';
import { gradientFor, initial } from '../lib/cover';

type Props = {
  /** 点整条：回到全屏播放页（由 MusicApp 切 tab） */
  onOpen: () => void;
  /** 播放页已经打开时不显示（避免和播放页自己的控件重复） */
  hidden?: boolean;
};

/**
 * v2.5.2 #11：底部迷你播放条。
 *
 * 背景：此前从播放页返回主页后，正在播的歌**没有任何入口** —— 想暂停/切歌只能
 * 再点回播放页。参考网易云，在非播放页时底部常驻一条 mini 条：
 *   封面 + 歌名 — 歌手 + 播放/暂停 + 播放列表
 * 顶部还有一条 2px 的细进度线。
 *
 * 数据直接订阅 player store（usePlayer），不新增状态源；
 * 没在播放（current 为空）时整条不渲染，不占位。
 */
export default function MiniPlayer({ onOpen, hidden }: Props) {
  const state = usePlayer();
  const cur = state.current;

  if (hidden || !cur) return null;

  const pct = state.duration > 0 ? Math.min(100, (state.progress / state.duration) * 100) : 0;

  return (
    <div className="mini-player" onClick={onOpen}>
      <div className="mp-bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <span className="mp-cover" style={cur.cover ? { backgroundImage: `url(${cur.cover})` } : { background: gradientFor(cur.title) }}>
        {!cur.cover && initial(cur.title)}
      </span>
      <span className="mp-meta">
        <span className="mp-title">{cur.title || '未知歌曲'}</span>
        <span className="mp-sub">{cur.artist || '未知艺术家'}</span>
      </span>
      <button
        className="mp-btn"
        title={state.isPlaying ? '暂停' : '播放'}
        aria-label={state.isPlaying ? '暂停' : '播放'}
        onClick={(e) => { e.stopPropagation(); player.toggle(); }}
      >
        <Icon name={state.isPlaying ? 'pause' : 'play'} size={20} />
      </button>
      <button
        className="mp-btn"
        title="下一首"
        aria-label="下一首"
        onClick={(e) => { e.stopPropagation(); player.next(); }}
      >
        <Icon name="skip-forward" size={18} />
      </button>
    </div>
  );
}
