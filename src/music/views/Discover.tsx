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
  onOpenSources,
  onOpenHistory,
}: {
  sources: SourceConfig[];
  library: ReturnType<typeof useLibrary>;
  playback: ReturnType<typeof usePlayback>;
  onSearch: (q: string) => void;
  onOpenSources: () => void;
  onOpenHistory: () => void;
}) {
  const [all, setAll] = useState<MediaItem[]>([]);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (sources.length === 0) return;
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

  const homeTop = (
    <div className="home-top">
      <div className="ht-logo">音<span className="dot">流</span></div>
      <div className="ht-actions">
        <button className="ht-ico" onClick={() => onSearch('')} title="搜索"><Icon name="search" size={20} /></button>
        <button className="ht-ico" onClick={onOpenHistory} title="历史"><Icon name="clock" size={20} /></button>
      </div>
    </div>
  );

  if (sources.length === 0) {
    return (
      <div className="view discover">
        {homeTop}
        <div className="blank-state">
          <div className="blank-art"><Icon name="music" size={44} /></div>
          <h2>导入音源，发现好音乐</h2>
          <p className="muted">在「设置 → 音源管理」里导入一个 JSON 音源，<br />推荐歌单与搜索就会在这里出现。</p>
          <button className="import-fab" onClick={onOpenSources}>
            <Icon name="plus" size={18} /> 导入音源
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="view discover">
      {homeTop}
      <div className="search-bar big">
        <span className="search-ico"><Icon name="search" size={18} /></span>
        <input
          value={q}
          placeholder="搜索歌曲 / 歌手 / 专辑…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) onSearch(q.trim()); }}
        />
        <button className="primary" onClick={() => q.trim() && onSearch(q.trim())}>搜索</button>
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
