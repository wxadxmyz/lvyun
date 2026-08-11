import { useRef, useState } from 'react';
import { useLibrary } from '../../lib/library';
import { usePlayback } from '../../lib/playback';
import { MediaItem } from '../../engine/types';
import { gradientFor, initial } from '../../lib/cover';
import { DownloadManager } from '../../components/DownloadManager';
import { Icon } from '../../components/Icon';

export function Library({
  library,
  playback,
  onOpenDebug,
}: {
  library: ReturnType<typeof useLibrary>;
  playback: ReturnType<typeof usePlayback>;
  onOpenDebug?: () => void;
}) {
  const [tab, setTab] = useState<'fav' | 'playlists' | 'history' | 'local' | 'download'>('fav');
  const fileRef = useRef<HTMLInputElement>(null);

  const importLocal = (files: FileList | null) => {
    if (!files) return;
    const items: MediaItem[] = Array.from(files).map((f, i) => ({
      id: 'local_' + Date.now() + '_' + i,
      sourceId: 'local',
      sourceName: '本地',
      title: f.name.replace(/\.[^.]+$/, ''),
      mediaType: 'music',
      playUrl: URL.createObjectURL(f),
    }));
    library.addLocalMusic(items);
    setTab('local');
  };

  const TrackList = ({ items, onRemove }: { items: MediaItem[]; onRemove?: (it: MediaItem) => void }) => (
    <div className="track-list">
      {items.length === 0 && <div className="muted sm">这里还是空的。</div>}
      {items.map((it, i) => (
        <div className="track-row" key={it.sourceId + it.id} onDoubleClick={() => playback.play(it, items, i)}>
          <span className="tidx">{i + 1}</span>
          <span className="tcover" style={{ background: it.cover ? undefined : gradientFor(it.title) }}>
            {it.cover ? <img src={it.cover} alt="" /> : initial(it.title)}
          </span>
          <span className="ttitle" onClick={() => playback.play(it, items, i)}>{it.title}</span>
          <span className="tsub">{it.artist ?? it.year ?? ''}</span>
          <span className="tsrc">{it.sourceName}</span>
          <span className="tactions">
            <button className="mini" title="播放" onClick={() => playback.play(it, items, i)}><Icon name="play" size={16} /></button>
            {onRemove && <button className="mini" title="移除" onClick={() => onRemove(it)}><Icon name="x" size={16} /></button>}
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="view library">
      <div className="page-title-row">
        <h2 className="page-title">我的音乐</h2>
        {onOpenDebug && <button className="mobile-only" onClick={onOpenDebug}><Icon name="bug" size={16} /> 调试</button>}
      </div>
      <div className="tabs">
        <button className={tab === 'fav' ? 'active' : ''} onClick={() => setTab('fav')}>我喜欢的</button>
        <button className={tab === 'playlists' ? 'active' : ''} onClick={() => setTab('playlists')}>播放列表</button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>播放历史</button>
        <button className={tab === 'local' ? 'active' : ''} onClick={() => setTab('local')}>本地音乐</button>
        <button className={tab === 'download' ? 'active' : ''} onClick={() => setTab('download')}>下载</button>
      </div>

      {tab === 'fav' && <TrackList items={library.lib.favorites.filter((i) => i.mediaType === 'music')} onRemove={(it) => library.toggleFavorite(it)} />}
      {tab === 'history' && (
        <>
          <div className="toolbar">
            <button className="link" onClick={() => library.clearHistory()}>清空历史</button>
          </div>
          <TrackList items={library.lib.history.filter((i) => i.mediaType === 'music')} />
        </>
      )}
      {tab === 'local' && (
        <>
          <div className="toolbar">
            <button className="primary" onClick={() => fileRef.current?.click()}>导入本地音乐</button>
            <input ref={fileRef} type="file" accept="audio/*" multiple hidden onChange={(e) => importLocal(e.target.files)} />
          </div>
          <TrackList items={library.lib.localMusic} onRemove={(it) => library.addLocalMusic(library.lib.localMusic.filter((x) => x.id !== it.id))} />
        </>
      )}
      {tab === 'playlists' && (
        <div className="playlists">
          <div className="toolbar">
            <button className="primary" onClick={() => { const n = window.prompt('歌单名称：'); if (n) library.createPlaylist(n); }}>＋ 新建歌单</button>
          </div>
          {library.lib.playlists.length === 0 && <div className="muted sm">还没有歌单。在搜索结果或播放页点「＋」可加入歌单。</div>}
          {library.lib.playlists.map((p) => (
            <div key={p.id} className="playlist-block">
              <div className="playlist-head">
                <h4>{p.name}（{p.items.length}）</h4>
                <span className="mini-actions">
                  <button className="link" onClick={() => playback.playList(p.items)}>播放全部</button>
                  <button className="link danger" onClick={() => library.removePlaylist(p.id)}>删除</button>
                </span>
              </div>
              <TrackList
                items={p.items}
                onRemove={(it) => library.removeFromPlaylist(p.id, it)}
              />
            </div>
          ))}
        </div>
      )}
      {tab === 'download' && <DownloadManager title="下载管理（音乐）" />}
    </div>
  );
}
