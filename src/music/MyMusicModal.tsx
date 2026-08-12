import { useLibrary } from '../lib/library';
import { usePlayback } from '../lib/playback';
import { gradientFor, initial } from '../lib/cover';
import { Icon } from '../components/Icon';

export function MyMusicModal({
  tab,
  library,
  playback,
  onClose,
}: {
  tab: 'favorites' | 'playlists';
  library: ReturnType<typeof useLibrary>;
  playback: ReturnType<typeof usePlayback>;
  onClose: () => void;
}) {
  const favs = library.lib.favorites.filter((i) => i.mediaType === 'music');
  const playlists = library.lib.playlists;

  return (
    <div className="fullpage">
      <div className="fullpage-head">
        <button className="icon" onClick={onClose}><Icon name="arrow-left" /></button>
        <h3>{tab === 'favorites' ? '我的喜欢' : '创建的歌单'}</h3>
        <span className="muted sm" style={{ marginLeft: 'auto' }}>
          {tab === 'favorites' ? `${favs.length} 首` : `${playlists.length} 个`}
        </span>
      </div>
      <div className="fullpage-body">
        {tab === 'favorites' && (
          <>
            {favs.length === 0 && <div className="empty">还没有喜欢的歌曲。在播放页点亮 ♥ 即可加入这里。</div>}
            <div className="track-list">
              {favs.map((it, i) => (
                <div className="track-row" key={it.sourceId + it.id} onClick={() => playback.play(it, favs, i)}>
                  <span className="tcover">{it.cover ? <img src={it.cover} alt="" /> : <span className="ph" style={{ background: gradientFor(it.title) }}>{initial(it.title)}</span>}</span>
                  <span className="ttitle">{it.title}</span>
                  <span className="tsub">{it.artist ?? ''}</span>
                  <span className={'mini fav' + (library.isFavorite(it) ? ' active' : '')} onClick={(e) => { e.stopPropagation(); library.toggleFavorite(it); }}><Icon name={library.isFavorite(it) ? 'heart-filled' : 'heart'} size={16} /></span>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === 'playlists' && (
          <>
            {playlists.length === 0 && <div className="empty">还没有创建歌单。在「我的喜欢」或播放队列里可整理成歌单。</div>}
            <div className="track-list">
              {playlists.map((p) => (
                <div className="track-row" key={p.id} onClick={() => p.items.length && playback.playList(p.items)}>
                  <span className="tcover"><Icon name="list" size={18} /></span>
                  <span className="ttitle">{p.name}</span>
                  <span className="tsub">{p.items.length} 首</span>
                  <button className="mini" onClick={(e) => { e.stopPropagation(); playback.playList(p.items); }}><Icon name="play" size={14} /></button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
