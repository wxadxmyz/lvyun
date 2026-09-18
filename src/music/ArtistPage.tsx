import { useEffect, useState } from 'react';
import { MediaItem, SourceConfig } from '../engine/types';
import { aggregateArtistCached, aggregateSearch } from '../engine';
import { useToast } from '../lib/toast';
import { Icon } from '../components/Icon';
import { gradientFor } from '../lib/cover';
import MiniPlayer from './MiniPlayer';

type Props = {
  /** 歌手名（为空时页面提示「没有歌手信息」） */
  artist: string;
  sources: SourceConfig[];
  /** 当前播放队列 —— 同歌手的歌会排在最前面（v2.4.10 #6 的渐进合并逻辑） */
  queue: MediaItem[];
  /** 点击列表里的歌：由调用方决定怎么播（播放页直接播 / 搜索页播完关浮层） */
  onPlay: (list: MediaItem[], index: number) => void;
  onClose: () => void;
  /** v2.5.5 #3：点内嵌迷你条的行为（搜索入口→关浮层切播放页；播放器入口→关歌手页）。可选。 */
  onOpenPlayer?: () => void;
};

/**
 * v2.5.2 #10：歌手主页（从 FullScreenPlayer 抽出，供两个入口共用）。
 *
 * 背景：此前「查看歌手」有两套实现——
 *   · 播放器页 ⋮ → 查看作者：完整页（头像 / 作品数 / 歌手全曲接口 / 分页加载更多）
 *   · 搜索页  ⋮ → 查看歌手：底部 sheet 里塞了个简版列表（只调 aggregateArtist，
 *     没有 artist() 全曲接口、没有失败回退、没有队列合并、没有头像和作品数）
 * 用户实测后要求两处一致，所以把播放器页这套抽成公共组件，两边都渲染它。
 *
 * 取数策略（沿用 v2.4.9 #2 / v2.4.10 #6）：
 *   ① 队列里同歌手的歌先上屏；
 *   ② aggregateArtist（歌手全曲接口 artist()）为主路径，支持 onPartial 边到边上屏；
 *   ③ 一条都没取到才回退「按歌手名聚合搜索」；
 *   ④ 全程「只增不改」，避免列表整体替换导致点第 2 行播第 1 行。
 */
// v2.6.1 A8：关注状态持久化。
//
// 旧实现点了「关注」只弹一个 toast，关掉页面就没了 —— 和「私信」一样是假交互，
// 区别只是它至少可以做成真实状态。这里用 localStorage 持久化「已关注的歌手集合」，
// 让这个按钮真正有意义（后续想做「我的关注」列表也有据可依）。
const FOLLOW_KEY = 'lvyun_followed_artists';

function readFollowed(artist: string): boolean {
  try {
    const arr = JSON.parse(localStorage.getItem(FOLLOW_KEY) ?? '[]');
    return Array.isArray(arr) && arr.includes(artist);
  } catch {
    return false;
  }
}

function writeFollowed(artist: string, on: boolean) {
  try {
    const raw = localStorage.getItem(FOLLOW_KEY);
    let arr: string[] = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) arr = [];
    arr = arr.filter((x) => x !== artist);
    if (on) arr.push(artist);
    localStorage.setItem(FOLLOW_KEY, JSON.stringify(arr));
  } catch {
    /* 配额 / 隐私模式：只影响持久化，不影响当前会话 */
  }
}

export default function ArtistPage({ artist, sources, queue, onPlay, onClose, onOpenPlayer }: Props) {
  const toast = useToast();
  const [tracks, setTracks] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const PAGE_SIZE = 60;
  const [shown, setShown] = useState(PAGE_SIZE);
  // v2.6.1 A8：头部「更多」浮层 + 关注状态（持久化）
  const [moreOpen, setMoreOpen] = useState(false);
  const [followed, setFollowed] = useState(false);
  useEffect(() => { setFollowed(readFollowed((artist ?? '').trim())); }, [artist]);
  useEffect(() => { setShown(PAGE_SIZE); }, [artist]);

  useEffect(() => {
    const name = (artist ?? '').trim();
    setTracks([]);
    if (!name) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const names = sources.filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.name }));
        const srcName = (id: string) => names.find((n) => n.id === id)?.name ?? '';
        const fromQueue = queue.filter((q) => q.artist === name);
        const seen = new Set<string>();
        const merged: MediaItem[] = [];
        const push = (list: MediaItem[]) => {
          for (const q of list) {
            const key = `${q.title}|${q.artist ?? ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push({ ...q, sourceName: q.sourceName || srcName(q.sourceId) } as MediaItem);
          }
        };

        push(fromQueue);
        if (merged.length) setTracks([...merged]);

        const a = await aggregateArtistCached(sources, name, {
          onPartial: (partial) => {
            if (!alive) return;
            push(partial);
            setTracks([...merged]);
          },
        });
        if (!alive) return;
        push(a.items);
        setTracks([...merged]);

        // 源不支持 artist() 或一条都没取到 → 回退按歌手名聚合搜索
        if (merged.length <= fromQueue.length) {
          const r = await aggregateSearch(sources, name, { mediaType: 'music' });
          if (!alive) return;
          push(r.items);
        }

        if (!alive) return;
        setTracks([...merged]);
      } catch {
        // 出错不清空已上屏内容（渐进渲染下可能已有几十条）
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artist, sources]);

  return (
    <div className="fs-author">
      {/* v2.6.1 A8：头部结构对齐 UI.html 的 .ahead ——「返回 + 标题/副标题 + 更多」一行式，
          替代旧版「返回 + 大圆头像」的分离布局。 */}
      <div className="fs-author-head">
        <button className="icon" onClick={onClose} aria-label="返回"><Icon name="arrow-left" /></button>
        <div className="fs-author-tt">
          <div className="n">{artist || '未知艺术家'}</div>
          <div className="s">{loading ? '正在获取作品…' : `原创音乐人 · ${tracks.length} 首作品`}</div>
        </div>
        {/* v2.6.1 A8：补「更多」按钮（UI.html .ahead 的第三个按钮）。 */}
        <button className="icon" onClick={() => setMoreOpen((v) => !v)} aria-label="更多操作"><Icon name="more" /></button>
      </div>
      {moreOpen && (
        <div className="fs-author-more">
          <button onClick={() => { setMoreOpen(false); onPlay(tracks, 0); }} disabled={!tracks.length}>
            <Icon name="play" size={16} /> 播放全部
          </button>
          <button onClick={() => { setMoreOpen(false); setShown(tracks.length); }} disabled={!tracks.length}>
            <Icon name="list" size={16} /> 展开全部
          </button>
        </div>
      )}
      <div className="fs-author-hero">
        <div className="fs-author-ava">{(artist ?? '?').slice(0, 1)}</div>
        <div className="fs-author-who">
          <div className="nm">{artist || '未知艺术家'}</div>
          <div className="bio">在律云与你相遇 · 原创音乐人</div>
        </div>
      </div>
      <div className="fs-author-stats">
        {/* 加载中固定显示「—」：渐进追加期间数字跳动会误导用户以为点错了 */}
        <div><div className="n">{loading ? '—' : tracks.length}</div><div className="t">作品</div></div>
        <div><div className="n">—</div><div className="t">粉丝</div></div>
        <div><div className="n">—</div><div className="t">关注</div></div>
      </div>
      {/* v2.6.1 A8：「私信」按钮已删除 —— 律云是聚合播放器，没有账号 / 消息体系，
          点了只弹一个 toast 说「已发送私信」，是纯占位假交互，会误导用户。
          「关注」保留并改为 localStorage 持久化，这样它至少是有意义的本地状态。 */}
      <div className="fs-author-acts">
        <button
          className={'fs-pill' + (followed ? ' primary2' : '')}
          onClick={() => {
            const next = !followed;
            setFollowed(next);
            writeFollowed(artist, next);
            toast.push(next ? `已关注 ${artist}` : `已取消关注 ${artist}`);
          }}
        >
          {followed ? '已关注' : '关注'}
        </button>
      </div>
      <div className="fs-author-sec">热门作品</div>
      <div className="fs-author-tracks">
        {loading && tracks.length === 0 && (
          // v2.5.5 #6：骨架屏占位（替代只有一个「正在获取」文案），进入不再像卡住
          <div className="fs-author-skeleton" aria-hidden="true">
            {Array.from({ length: 7 }).map((_, i) => (
              <div className="skel-row" key={i}>
                <span className="skel-idx" />
                <span className="skel-cover" />
                <span className="skel-meta"><i className="skel-name" /><i className="skel-sub" /></span>
              </div>
            ))}
          </div>
        )}
        {!loading && tracks.length === 0 && (
          <div className="muted sm" style={{ padding: 16, textAlign: 'center' }}>
            {artist ? `没有获取到「${artist}」的作品，可能是该源不支持歌手全曲接口。` : '当前歌曲没有歌手信息。'}
          </div>
        )}
        {tracks.length > 0 && tracks.slice(0, shown).map((q, i) => (
          <div
            key={q.sourceId + ':' + q.id}
            className="fs-author-track"
            onClick={() => {
              // 按身份重新定位下标，避免列表变化时播错行
              const idx = tracks.findIndex((x) => x.sourceId === q.sourceId && x.id === q.id);
              onPlay(tracks, idx < 0 ? i : idx);
            }}
          >
            <span className="at-idx">{i + 1}</span>
            <span className="at-cover" style={{ background: gradientFor(q.title) }} />
            <span className="at-meta">
              <span className="at-name">{q.title}</span>
              <span className="at-sub">{[q.artist, q.sourceName].filter(Boolean).join(' · ')}</span>
            </span>
            {/* v2.6.1 A8：补行内播放按钮（UI.html .arow .p），与历史页 .tactions 的交互一致。 */}
            <button
              className="at-play"
              title="播放"
              aria-label="播放"
              onClick={(e) => {
                e.stopPropagation();
                const idx = tracks.findIndex((x) => x.sourceId === q.sourceId && x.id === q.id);
                onPlay(tracks, idx < 0 ? i : idx);
              }}
            >
              <Icon name="play" size={16} />
            </button>
          </div>
        ))}
        {!loading && tracks.length > shown && (
          <button className="link" style={{ padding: '12px 16px', alignSelf: 'center' }} onClick={() => setShown((n) => n + PAGE_SIZE)}>
            加载更多（还有 {tracks.length - shown} 首）
          </button>
        )}
      </div>
      {/* v2.5.5 #3：歌手详情页内嵌迷你播放条，位置=原 Tab 位置（见 styles.css .fs-author .mini-player）。
          公共组件，搜索/播放器两个入口自动带上。 */}
      <MiniPlayer onOpen={onOpenPlayer ?? (() => {})} />
    </div>
  );
}
