import { useEffect, useState } from 'react';
import { aggregateSearch, MediaItem, SourceConfig } from '../../engine';
import { useLibrary } from '../../lib/library';
import { usePlayback } from '../../lib/playback';
import { Icon } from '../../components/Icon';
import { pushBackHandler } from '../../lib/backStack';
import { ToplistItem } from '../../lib/toplists';
// v2.4.1 #I：榜单结果同样标记源指纹，保证换源后播放能走新源
import { markSourceRev } from '../../player';

export function ToplistDetail({
  item,
  sources,
  library,
  playback,
  onClose,
}: {
  item: ToplistItem;
  sources: SourceConfig[];
  library: ReturnType<typeof useLibrary>;
  playback: ReturnType<typeof usePlayback>;
  onClose: () => void;
}) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searched, setSearched] = useState(false);

  // v2.4.0 I1：用榜单 keyword 去搜「用户自己的音源」，结果即该榜单歌曲（App 不存不分发）
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setSearched(false);
    aggregateSearch(sources, item.keyword)
      .then((r) => { if (alive) setItems(r.items.filter((i) => i.mediaType === 'music').map((it) => markSourceRev(it, sources))); })
      .catch(() => { if (alive) setItems([]); })
      .finally(() => { if (alive) { setLoading(false); setSearched(true); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  // 左上返回 + 系统返回键统一走 onClose（栈式返回）；返回 true 表示已消费
  useEffect(() => pushBackHandler(() => { onClose(); return true; }), [onClose]);

  const groups = items.reduce<Record<string, MediaItem[]>>((acc, it) => {
    (acc[it.sourceName] ??= []).push(it);
    return acc;
  }, {});

  return (
    <div className="fullpage">
      <div className="fullpage-head">
        <button className="icon" onClick={onClose} aria-label="返回"><Icon name="arrow-left" /></button>
        <div className="fp-head">
          <h3>{item.name}</h3>
          {item.desc && <span className="fp-desc">{item.desc}</span>}
        </div>
      </div>
      <div className="fullpage-body">
        {loading && <div className="loading">正在用你的音源搜索「{item.keyword}」…</div>}
        {searched && !loading && items.length === 0 && (
          <div className="empty">你的音源里没找到「{item.keyword}」相关结果。<br />换个源或换张榜单试试。</div>
        )}
        {Object.entries(groups).map(([src, list]) => (
          <div key={src} className="result-group">
            <div className="row-head"><h4>来自：{src}（{list.length}）</h4></div>
            <div className="track-list">
              {list.map((it, i) => (
                <div className="track-row" key={it.sourceId + it.id} onClick={() => playback.play(it, list, i)}>
                  <span className="tcover" style={{ background: `linear-gradient(140deg, ${item.color?.[0] ?? '#ff5e99'}, ${item.color?.[1] ?? '#ff8a4c'})` }}>
                    {it.cover ? <img src={it.cover} alt="" /> : (item.initial ?? it.title.slice(0, 1))}
                  </span>
                  <span className="ttitle">{it.title}</span>
                  <span className="tsub">{it.artist ?? it.year ?? ''}</span>
                  <span className="tsrc">{it.sourceName}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
