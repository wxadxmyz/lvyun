import { useEffect, useState } from 'react';
import { MediaItem, SourceConfig } from '../engine/types';
import { aggregateArtist, aggregateSearch } from '../engine';
import { useToast } from '../lib/toast';
import { Icon } from '../components/Icon';
import { gradientFor } from '../lib/cover';

type Props = {
  /** 歌手名（为空时页面提示「没有歌手信息」） */
  artist: string;
  sources: SourceConfig[];
  /** 当前播放队列 —— 同歌手的歌会排在最前面（v2.4.10 #6 的渐进合并逻辑） */
  queue: MediaItem[];
  /** 点击列表里的歌：由调用方决定怎么播（播放页直接播 / 搜索页播完关浮层） */
  onPlay: (list: MediaItem[], index: number) => void;
  onClose: () => void;
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
export default function ArtistPage({ artist, sources, queue, onPlay, onClose }: Props) {
  const toast = useToast();
  const [tracks, setTracks] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const PAGE_SIZE = 60;
  const [shown, setShown] = useState(PAGE_SIZE);

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

        const a = await aggregateArtist(sources, name, {
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
      <div className="fs-author-head">
        <button className="icon" onClick={onClose} aria-label="返回"><Icon name="arrow-left" /></button>
        <div className="fs-author-ava">{(artist ?? '?').slice(0, 1)}</div>
      </div>
      <div className="fs-author-info">
        <div className="fs-author-name">{artist || '未知艺术家'}</div>
        <div className="fs-author-bio">原创音乐人 · 在律云与你相遇</div>
      </div>
      <div className="fs-author-stats">
        {/* 加载中固定显示「—」：渐进追加期间数字跳动会误导用户以为点错了 */}
        <div><div className="n">{loading ? '—' : tracks.length}</div><div className="t">作品</div></div>
        <div><div className="n">—</div><div className="t">粉丝</div></div>
        <div><div className="n">—</div><div className="t">关注</div></div>
      </div>
      <div className="fs-author-acts">
        <button className="fs-pill primary2" onClick={() => { toast.push('已关注'); }}>关注</button>
        <button className="fs-pill" onClick={() => toast.push('已发送私信')}>私信</button>
      </div>
      <div className="fs-author-sec">热门作品</div>
      <div className="fs-author-tracks">
        {loading && <div className="muted sm" style={{ padding: 16, textAlign: 'center' }}>正在获取「{artist}」的作品…</div>}
        {!loading && tracks.slice(0, shown).map((q, i) => (
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
          </div>
        ))}
        {!loading && tracks.length > shown && (
          <button className="link" style={{ padding: '12px 16px', alignSelf: 'center' }} onClick={() => setShown((n) => n + PAGE_SIZE)}>
            加载更多（还有 {tracks.length - shown} 首）
          </button>
        )}
        {!loading && tracks.length === 0 && (
          <div className="muted sm" style={{ padding: 16, textAlign: 'center' }}>
            {artist ? `没有获取到「${artist}」的作品，可能是该源不支持歌手全曲接口。` : '当前歌曲没有歌手信息。'}
          </div>
        )}
      </div>
    </div>
  );
}
