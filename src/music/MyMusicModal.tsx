import { useEffect, useState } from 'react';
import { useLibrary } from '../lib/library';
import { usePlayback } from '../lib/playback';
import { gradientFor, initial } from '../lib/cover';
import { Icon } from '../components/Icon';
// v2.3.11 #4：返回键栈式调度
import { pushBackHandler } from '../lib/backStack';

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

  // v2.4.5 #6：歌单详情子页。此前点歌单整行直接 playList 播整张，
  // 用户期望的是「进子页看歌单内容」；现在整行进详情，只有右侧 ▶ 才整张播放。
  const [openId, setOpenId] = useState<string | null>(null);
  const pl = playlists.find((p) => p.id === openId) ?? null;

  // 详情子页纳入系统返回手势：先退回列表，再退出整个浮层
  useEffect(() => {
    if (!openId) return;
    return pushBackHandler(() => { setOpenId(null); return true; });
  }, [openId]);

  // 歌单被删掉（或切 tab）时自动收起详情，避免停在空白页
  useEffect(() => {
    if (openId && !playlists.some((p) => p.id === openId)) setOpenId(null);
  }, [playlists, openId]);

  return (
    <div className="fullpage">
      {pl ? (
        <>
          <div className="fullpage-head">
            <button className="icon" onClick={() => setOpenId(null)} aria-label="返回"><Icon name="arrow-left" /></button>
            <h3>{pl.name}</h3>
            <span className="muted sm" style={{ marginLeft: 'auto' }}>{pl.items.length} 首</span>
          </div>
          <div className="fullpage-body">
            {pl.items.length === 0 && <div className="empty">这个歌单还是空的。在播放页「加歌单」可以把当前歌曲收进来。</div>}
            <div className="track-list">
              {pl.items.length > 0 && (
                <div className="track-row tl2" onClick={() => playback.playList(pl.items)}>
                  <span className="tcover" style={{ background: 'linear-gradient(135deg, var(--accent), var(--accent2))' }}><Icon name="play" size={18} /></span>
                  <span className="tmain">
                    <span className="ttitle">播放全部</span>
                    <span className="tsub">共 {pl.items.length} 首</span>
                  </span>
                </div>
              )}
              {pl.items.map((it, i) => (
                <div className="track-row tl2" key={it.sourceId + it.id} onClick={() => playback.play(it, pl.items, i)}>
                  <span className="tcover">{it.cover ? <img src={it.cover} alt="" /> : <span className="ph" style={{ background: gradientFor(it.title) }}>{initial(it.title)}</span>}</span>
                  <span className="tmain">
                    <span className="ttitle">{it.title}</span>
                    <span className="tsub">{it.artist ?? ''}</span>
                  </span>
                  <span className="tsrc">{it.sourceName}</span>
                  <span className="tactions">
                    <button
                      className="mini"
                      title="从歌单移除"
                      onClick={(e) => { e.stopPropagation(); library.removeFromPlaylist(pl.id, it); }}
                    ><Icon name="x" size={15} /></button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="fullpage-head">
            <button className="icon" onClick={onClose} aria-label="返回"><Icon name="arrow-left" /></button>
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
                    <div className="track-row tl2" key={it.sourceId + it.id} onClick={() => playback.play(it, favs, i)}>
                      <span className="tcover">{it.cover ? <img src={it.cover} alt="" /> : <span className="ph" style={{ background: gradientFor(it.title) }}>{initial(it.title)}</span>}</span>
                      <span className="tmain">
                        <span className="ttitle">{it.title}</span>
                        <span className="tsub">{it.artist ?? ''}</span>
                      </span>
                      <span className="tsrc">{it.sourceName}</span>
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
                    <div className="track-row tl2" key={p.id} onClick={() => setOpenId(p.id)}>
                      <span className="tcover"><Icon name="list" size={18} /></span>
                      <span className="tmain">
                        <span className="ttitle">{p.name}</span>
                        <span className="tsub">{p.items.length} 首</span>
                      </span>
                      <button className="mini" title="播放全部" onClick={(e) => { e.stopPropagation(); playback.playList(p.items); }}><Icon name="play" size={14} /></button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
