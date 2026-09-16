import { useState } from 'react';
import { MediaItem, SourceConfig } from '../engine/types';
import { aggregateArtist } from '../engine';
import { useLibrary } from '../lib/library';
import { player } from '../lib/playerStore';
import { downloadStore } from '../lib/downloads';
import { Icon } from './Icon';
import { gradientFor, initial } from '../lib/cover';

type Props = {
  item: MediaItem;
  sources: SourceConfig[];
  library: ReturnType<typeof useLibrary>;
  onPlay: (item: MediaItem) => void;
  onClose: () => void;
};

/**
 * v2.5.0 #6-2：搜索结果行「⋮」底部列表式浮层。
 * 复用代码里已有的 .fs-menu-mask / .fs-sheet / .fs-sheet-row 样式（styles.css），
 * 不自己写浮层框架。菜单项：
 *   喜欢 / 下一首播放 / 添加到歌单 / 下载 / 查看歌手（无分享）。
 * 「添加到歌单」展开歌单选择；「查看歌手」展开该歌手歌曲 sheet。
 */
export function SearchTrackMenu({ item, sources, library, onPlay, onClose }: Props) {
  // 子视图状态：null=主菜单；'playlist'=歌单选择；artist=歌手歌曲
  const [view, setView] = useState<'main' | 'playlist' | 'artist'>('main');
  const [artistState, setArtistState] = useState<{ loading: boolean; items: MediaItem[]; error?: string }>({ loading: false, items: [] });

  const fav = library.isFavorite(item);

  const toggleFav = () => { library.toggleFavorite(item); onClose(); };

  const playNext = () => {
    const st = player.getState();
    const at = st.index >= 0 ? st.index + 1 : st.queue.length;
    player.enqueueAt(item, at);
    onClose();
  };

  const download = () => { downloadStore.start(item); onClose(); };

  const addToPlaylist = (pid: string) => { library.addToPlaylist(pid, item); onClose(); };

  const createPlaylist = () => { library.createPlaylistWith('我的歌单', item); onClose(); };

  const openArtist = async () => {
    if (!item.artist) return;
    setView('artist');
    setArtistState({ loading: true, items: [] });
    try {
      const r = await aggregateArtist(sources, item.artist, { timeout: 40000 });
      setArtistState({ loading: false, items: r.items });
    } catch (e: any) {
      setArtistState({ loading: false, items: [], error: e?.message || '获取失败' });
    }
  };

  const playArtistSong = (it: MediaItem) => { onPlay(it); onClose(); };

  return (
    <div className="fs-menu-mask" onClick={onClose}>
      <div className="fs-sheet search-track-menu" onClick={(e) => e.stopPropagation()}>
        <div className="fs-sheet-grip" />

        {view === 'main' && (
          <>
            <div className="fs-sheet-head">
              <div className="icon">
                {item.cover ? <img src={item.cover} alt="" /> : <span style={{ background: gradientFor(item.title) }}>{initial(item.title)}</span>}
              </div>
              <div className="sh-title">
                <div className="stm-title">{item.title}</div>
                <div className="stm-sub">{[item.artist, item.album].filter(Boolean).join(' · ') || '未知'}</div>
              </div>
            </div>

            <button className="fs-sheet-row" onClick={toggleFav}>
              <span className="sr-ico"><Icon name={fav ? 'heart-filled' : 'heart'} size={20} /></span>
              <span className="sr-text">{fav ? '取消喜欢' : '喜欢'}</span>
            </button>
            <button className="fs-sheet-row" onClick={playNext}>
              <span className="sr-ico"><Icon name="skip-forward" size={20} /></span>
              <span className="sr-text">下一首播放</span>
            </button>
            <button className="fs-sheet-row" onClick={() => setView('playlist')}>
              <span className="sr-ico"><Icon name="playlist-add" size={20} /></span>
              <span className="sr-text">添加到歌单</span>
            </button>
            <button className="fs-sheet-row" onClick={download}>
              <span className="sr-ico"><Icon name="download" size={20} /></span>
              <span className="sr-text">下载</span>
            </button>
            <button className="fs-sheet-row" onClick={openArtist} disabled={!item.artist}>
              <span className="sr-ico"><Icon name="user" size={20} /></span>
              <span className="sr-text">查看歌手{item.artist ? ` · ${item.artist}` : ''}</span>
            </button>
          </>
        )}

        {view === 'playlist' && (
          <>
            <div className="fs-sheet-head">
              <button className="stm-back" onClick={() => setView('main')} aria-label="返回"><Icon name="arrow-left" size={22} /></button>
              <div className="sh-title">添加到歌单</div>
            </div>
            <div className="fs-plpick">
              {library.lib.playlists.length === 0 && (
                <div className="muted sm" style={{ padding: '4px 8px 10px' }}>还没有歌单</div>
              )}
              {library.lib.playlists.map((p) => (
                <button key={p.id} className="fs-plpick-item" onClick={() => addToPlaylist(p.id)}>
                  <span className="pi-cover" />
                  <span className="pi-name">{p.name}</span>
                  <span className="pi-count">{p.items.length} 首</span>
                </button>
              ))}
              <button className="fs-plpick-create" onClick={createPlaylist}>
                <span className="pc-ico"><Icon name="plus" size={20} /></span>
                <span>新建歌单并添加</span>
              </button>
            </div>
          </>
        )}

        {view === 'artist' && (
          <>
            <div className="fs-sheet-head">
              <button className="stm-back" onClick={() => setView('main')} aria-label="返回"><Icon name="arrow-left" size={22} /></button>
              <div className="sh-title">歌手 · {item.artist}</div>
            </div>
            {artistState.loading && <div className="muted sm" style={{ padding: 12 }}>加载中…</div>}
            {artistState.error && <div className="muted sm" style={{ padding: 12 }}>{artistState.error}</div>}
            {!artistState.loading && !artistState.error && artistState.items.length === 0 && (
              <div className="muted sm" style={{ padding: 12 }}>没有获取到「{item.artist}」的作品</div>
            )}
            <div className="stm-artist-list">
              {artistState.items.map((it, i) => (
                <button key={it.sourceId + it.id + i} className="track-row tl2" onClick={() => playArtistSong(it)}>
                  <span className="tcover">
                    {it.cover ? <img src={it.cover} alt="" /> : <span style={{ background: gradientFor(it.title) }}>{initial(it.title)}</span>}
                  </span>
                  <span className="tmain">
                    <span className="ttitle">{it.title}</span>
                    <span className="tsub">{it.album || it.sourceName || ''}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
