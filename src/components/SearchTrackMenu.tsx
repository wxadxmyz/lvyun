import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { MediaItem, SourceConfig } from '../engine/types';
import { useLibrary } from '../lib/library';
import { pushBackHandler } from '../lib/backStack';
import { player } from '../lib/playerStore';
import { downloadStore } from '../lib/downloads';
import { Icon } from './Icon';
import { gradientFor, initial } from '../lib/cover';
import ArtistPage from '../music/ArtistPage';

type Props = {
  item: MediaItem;
  sources: SourceConfig[];
  library: ReturnType<typeof useLibrary>;
  onPlay: (item: MediaItem) => void;
  onClose: () => void;
  /** v2.5.5 #3：歌手详情页内嵌迷你条「打开播放器」的行为（关歌手页+关浮层+切 player tab），由上层透传 */
  onOpenPlayer?: () => void;
};

/**
 * v2.5.0 #6-2：搜索结果行「⋮」底部列表式浮层。
 * 复用代码里已有的 .fs-menu-mask / .fs-sheet / .fs-sheet-row 样式（styles.css），
 * 不自己写浮层框架。菜单项：
 *   喜欢 / 下一首播放 / 添加到歌单 / 下载 / 查看歌手（无分享）。
 * 「添加到歌单」展开歌单选择；「查看歌手」展开该歌手歌曲 sheet。
 */
export function SearchTrackMenu({ item, sources, library, onPlay, onClose, onOpenPlayer }: Props) {
  // 子视图状态：null=主菜单；'playlist'=歌单选择
  // v2.5.2 #10：'artist' 视图删掉 —— 原来是在这个小 sheet 里塞简版列表，
  // 与播放器页的完整歌手主页不是一个东西。现在统一打开公共组件 ArtistPage。
  const [view, setView] = useState<'main' | 'playlist'>('main');
  const [artistPage, setArtistPage] = useState<string | null>(null);

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

  // v2.5.2 #10：不再自己拉数据，直接打开与播放器页同一个完整歌手主页
  const openArtist = () => {
    if (!item.artist) return;
    setArtistPage(item.artist);
  };

  // v2.5.5 #3：歌手详情页打开期间，系统返回先关歌手页，再按才放行给搜索页返回
  // （否则返回事件被底层 SearchView 的 handler 消费，直接关掉整个搜索浮层 → 像回主页）。
  useEffect(() => {
    if (!artistPage) return;
    return pushBackHandler(() => {
      setArtistPage(null);
      return true;
    });
  }, [artistPage]);


  return createPortal(
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

      </div>

      {/* v2.5.2 #10：歌手主页（与播放器页「查看作者」同一个组件）。
          挂在 sheet 之外、mask 之内，铺满全屏盖住底部 sheet。 */}
      {artistPage && (
        <div className="stm-artist-page" onClick={(e) => e.stopPropagation()}>
          <ArtistPage
            artist={artistPage}
            sources={sources}
            queue={player.getState().queue}
            onPlay={(list, idx) => {
              player.playQueue(list, idx);
              setArtistPage(null);
              onClose();
            }}
            onClose={() => setArtistPage(null)}
            onOpenPlayer={
              onOpenPlayer
                ? () => { setArtistPage(null); onOpenPlayer(); }
                : undefined
            }
          />
        </div>
      )}
    </div>
  , document.body);
}
