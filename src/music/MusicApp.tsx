import { useState } from 'react';
import { useSources } from '../store';
import { useLibrary } from '../lib/library';
import { usePlayback } from '../lib/playback';
import { usePlayer, player } from '../lib/playerStore';
import { useGlobalShortcuts } from '../lib/shortcuts';
import { useSettings } from '../lib/settings';
import { SourceManager } from '../components/SourceManager';
import { SearchView } from '../components/SearchView';
import { SettingsModal } from '../components/SettingsModal';
import { DebugPanel } from '../components/DebugPanel';
import { PlayerBar } from './PlayerBar';
import { FullScreenPlayer } from './FullScreenPlayer';
import { DesktopLyric } from './DesktopLyric';
import { Discover } from './views/Discover';
import { Library } from './views/Library';
import { Icon } from '../components/Icon';

type Tab = 'discover' | 'search' | 'library' | 'sources';

export default function MusicApp() {
  const store = useSources('music');
  const library = useLibrary('music');
  const playback = usePlayback(store.sources, library);
  const { settings } = useSettings();
  usePlayer(); // 订阅播放状态（底部条依赖）
  useGlobalShortcuts(); // 全局快捷键：空格/←→/↑↓/M/N/P

  const [tab, setTab] = useState<Tab>('discover');
  const [fullscreen, setFullscreen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [searchQuery, setSearchQuery] = useState<string | undefined>(undefined);

  const goSearch = (q: string) => {
    setSearchQuery(q);
    setTab('search');
  };

  // 云同步载荷：把收藏/歌单/历史序列化交给设置面板备份
  const cloudPayload = () =>
    JSON.stringify({ kind: 'music', favorites: library.lib.favorites, playlists: library.lib.playlists, history: library.lib.history });

  return (
    <div className="app music-theme">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo"><Icon name="music" size={18} /></span> 音乐
        </div>
        <nav className="nav">
          <button className={tab === 'discover' ? 'active' : ''} onClick={() => setTab('discover')}><Icon name="home" size={16} /> 发现</button>
          <button className={tab === 'search' ? 'active' : ''} onClick={() => { setSearchQuery(undefined); setTab('search'); }}><Icon name="search" size={16} /> 搜索</button>
          <button className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}><Icon name="library" size={16} /> 我的音乐</button>
          <button className={tab === 'sources' ? 'active' : ''} onClick={() => setTab('sources')}><Icon name="plug" size={16} /> 音源管理</button>
        </nav>
        <div className="sidebar-foot">
          <button className="side-btn" onClick={() => setShowSettings(true)}><Icon name="settings" size={16} /> 设置</button>
          <button className="side-btn" onClick={() => setShowDebug(true)}><Icon name="bug" size={16} /> 调试</button>
          <div className="tip">自定义 API 源 · 跨源聚合</div>
        </div>
      </aside>

      <main className="main">
        {tab === 'discover' && (
          <Discover sources={store.sources} library={library} playback={playback} onSearch={goSearch} />
        )}

        {tab === 'search' && (
          <SearchView
            sources={store.sources}
            onPlay={(it) => playback.play(it)}
            onQueue={(its) => player.enqueue(its)}
            library={library}
            mediaType="music"
            placeholder="搜索歌曲 / 歌手 / 专辑…"
            initialQuery={searchQuery}
          />
        )}

        {tab === 'library' && <Library library={library} playback={playback} />}

        {tab === 'sources' && <SourceManager store={store} onOpenSettings={() => setShowSettings(true)} onOpenDebug={() => setShowDebug(true)} />}
      </main>

      <PlayerBar sources={store.sources} library={library} onOpenFullscreen={() => setFullscreen(true)} />

      <nav className="bottom-nav">
        <button className={tab === 'discover' ? 'active' : ''} onClick={() => setTab('discover')}><span className="ico"><Icon name="home" /></span><span>发现</span></button>
        <button className={tab === 'search' ? 'active' : ''} onClick={() => { setSearchQuery(undefined); setTab('search'); }}><span className="ico"><Icon name="search" /></span><span>搜索</span></button>
        <button className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}><span className="ico"><Icon name="library" /></span><span>我的</span></button>
        <button className={tab === 'sources' ? 'active' : ''} onClick={() => setTab('sources')}><span className="ico"><Icon name="plug" /></span><span>音源</span></button>
        <button className="action" onClick={() => setShowSettings(true)}>
          <span className="ico" aria-hidden="true"><Icon name="settings" /></span>
          <span>设置</span>
        </button>
      </nav>

      {fullscreen && (
        <FullScreenPlayer sources={store.sources} library={library} onClose={() => setFullscreen(false)} />
      )}

      {settings.showDesktopLyric && <DesktopLyric />}

      {showSettings && (
        <SettingsModal appName="音乐" store={store} libraryPayload={cloudPayload} onClose={() => setShowSettings(false)} />
      )}
      {showDebug && <DebugPanel onClose={() => setShowDebug(false)} />}
    </div>
  );
}
