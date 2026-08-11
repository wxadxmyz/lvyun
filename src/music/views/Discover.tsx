import { useEffect, useState } from 'react';
import { aggregateSearch, MediaItem } from '../../engine';
import { useLibrary } from '../../lib/library';
import { usePlayback } from '../../lib/playback';
import { SourceConfig } from '../../engine/types';
import { gradientFor, initial } from '../../lib/cover';
import { Icon } from '../../components/Icon';

const CATEGORIES = ['华语', '流行', '轻音乐', '经典老歌', '电子', '动漫', '摇滚'];

export function Discover({
  sources,
  library,
  playback,
  onSearch,
}: {
  sources: SourceConfig[];
  library: ReturnType<typeof useLibrary>;
  playback: ReturnType<typeof usePlayback>;
  onSearch: (q: string) => void;
}) {
  const [all, setAll] = useState<MediaItem[]>([]);

  useEffect(() => {
    aggregateSearch(sources, '').then((r) => setAll(r.items.filter((i) => i.mediaType === 'music')));
  }, [sources]);

  const recent = library.lib.history.filter((i) => i.mediaType === 'music');
  const favs = library.lib.favorites.filter((i) => i.mediaType === 'music');
  const hot = all.slice(0, 8);

  const Row = ({ title, items, onPlayAll }: { title: string; items: MediaItem[]; onPlayAll?: () => void }) => (
    <section className="row-section">
      <div className="row-head">
        <h3>{title}</h3>
        {onPlayAll && items.length > 0 && (
          <button className="link" onClick={onPlayAll}><Icon name="play" size={14} /> 播放全部</button>
        )}
      </div>
      <div className="row-cards">
        {items.length === 0 && <span className="muted sm">暂无内容，去搜索或收藏一些歌曲吧。</span>}
        {items.map((it, i) => (
          <div className="mini-card" key={it.sourceId + it.id} onClick={() => playback.play(it, items, i)}>
            <div className="mini-cover">
              {it.cover ? <img src={it.cover} alt="" /> : <span className="ph" style={{ background: gradientFor(it.title) }}>{initial(it.title)}</span>}
              <button className="mini-play" onClick={(e) => { e.stopPropagation(); playback.play(it, items, i); }}><Icon name="play" size={14} /></button>
            </div>
            <div className="mini-title">{it.title}</div>
            <div className="mini-sub">{it.artist ?? ''}</div>
          </div>
        ))}
      </div>
    </section>
  );

  return (
    <div className="view discover">
      <div className="hero">
        <div className="hero-text">
          <h1>发现好音乐</h1>
          <p>跨源聚合 · 一次搜索，听遍所有你添加的 API 源</p>
        </div>
        <div className="hero-art" style={{ background: gradientFor('music') }}><Icon name="music" size={40} /></div>
      </div>

      <div className="chips">
        {CATEGORIES.map((c) => (
          <button key={c} className="chip" onClick={() => onSearch(c)}>{c}</button>
        ))}
      </div>

      <Row title="最近播放" items={recent} onPlayAll={() => playback.playList(recent)} />
      <Row title="我喜欢的" items={favs} onPlayAll={() => playback.playList(favs)} />
      <Row title="热门歌曲" items={hot} onPlayAll={() => playback.playList(hot)} />
    </div>
  );
}
