import { useEffect, useRef, useState } from 'react';
import { useSources } from '../store';
import { useLibrary } from '../lib/library';
import { usePlayback } from '../lib/playback';
import { usePlayer, player } from '../lib/playerStore';
import { useGlobalShortcuts } from '../lib/shortcuts';
import { useSettings } from '../lib/settings';
import { SearchView } from '../components/SearchView';
import { DebugPanel } from '../components/DebugPanel';
import { FullScreenPlayer } from './FullScreenPlayer';
import { DesktopLyric } from './DesktopLyric';
import { Discover } from './views/Discover';
import { MyMusicModal } from './MyMusicModal';
import { SettingsPage } from './SettingsPage';
import { Disclaimer } from '../components/Disclaimer';
import { Icon } from '../components/Icon';

type Tab = 'home' | 'player' | 'settings';
const ORDER: Tab[] = ['home', 'player', 'settings'];

export default function MusicApp() {
  const store = useSources('music');
  const library = useLibrary('music');
  const playback = usePlayback(store.sources, library);
  const { settings } = useSettings();
  const state = usePlayer(); // 订阅播放状态（播放 tab 依赖）
  useGlobalShortcuts(); // 全局快捷键：空格/←→/↑↓/M/N/P

  const [tab, setTab] = useState<Tab>('home');
  const [searchOpen, setSearchOpen] = useState(false);
  const [myMusic, setMyMusic] = useState<null | 'favorites' | 'playlists'>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [searchQuery, setSearchQuery] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (settings.themeColor) {
      document.documentElement.style.setProperty('--accent', settings.themeColor);
      document.documentElement.style.setProperty('--accent2', settings.themeColor);
    }
  }, [settings.themeColor]);

  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const dx = e.changedTouches[0].clientX - touchStart.current.x;
    const dy = e.changedTouches[0].clientY - touchStart.current.y;
    touchStart.current = null;
    // 仅横滑切界面（避免与竖向滚动/播放页上下滑冲突）
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      const i = ORDER.indexOf(tab);
      if (dx < 0 && i < ORDER.length - 1) setTab(ORDER[i + 1]);
      else if (dx > 0 && i > 0) setTab(ORDER[i - 1]);
    }
  };

  const goSearch = (q: string) => {
    setSearchQuery(q);
    setSearchOpen(true);
  };

  const openSources = () => setTab('settings');

  return (
    <div className="app music-theme" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <header className="topbar">
        <div className="brand">
          <span className="logo">
            <Icon name="music" size={20} />
          </span>{' '}
          音乐
        </div>
        <nav className="nav">
          <button className={tab === 'home' ? 'active' : ''} onClick={() => setTab('home')}>
            主页
          </button>
          <button className={tab === 'player' ? 'active' : ''} onClick={() => setTab('player')}>
            播放
          </button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            设置
          </button>
        </nav>
        <div className="tb-right">
          <button className="icon" onClick={() => setShowDebug(true)} title="调试">
            <Icon name="bug" />
          </button>
          <button className="icon settings-btn" onClick={() => setTab('settings')} title="设置" aria-label="设置">
            <Icon name="settings" size={20} />
          </button>
        </div>
      </header>

      <main className="main">
        {tab === 'home' && (
          <Discover
            sources={store.sources}
            library={library}
            playback={playback}
            onSearch={goSearch}
            onOpenSources={openSources}
            onOpenHistory={() => {
              setSearchQuery(undefined);
              setSearchOpen(true);
            }}
          />
        )}

        {tab === 'player' && state.current && (
          <FullScreenPlayer sources={store.sources} library={library} onClose={() => setTab('home')} />
        )}
        {tab === 'player' && !state.current && (
          <div className="fs-player fs-empty">
            <div className="fs-empty-inner">
              <div className="fs-cover empty">
                <Icon name="music" size={56} />
              </div>
              <h3 className="fs-title">未在播放</h3>
              <div className="fs-ctrls">
                <button className="fs-btn" disabled>
                  <Icon name="skip-back" size={22} />
                </button>
                <button className="fs-btn play" disabled>
                  <Icon name="play" size={26} />
                </button>
                <button className="fs-btn" disabled>
                  <Icon name="skip-forward" size={22} />
                </button>
              </div>
              <button className="primary" onClick={() => setTab('home')}>
                去主页听听
              </button>
            </div>
          </div>
        )}

        {tab === 'settings' && <SettingsPage onOpenMyMusic={setMyMusic} />}

        {searchOpen && (
          <div className="fullpage">
            <div className="fullpage-head">
              <button className="icon" onClick={() => setSearchOpen(false)}>
                <Icon name="arrow-left" />
              </button>
              <h3>搜索</h3>
            </div>
            <div className="fullpage-body">
              <SearchView
                sources={store.sources}
                onPlay={(it) => playback.play(it)}
                onQueue={(its) => player.enqueue(its)}
                library={library}
                mediaType="music"
                placeholder="搜索歌曲 / 歌手 / 专辑…"
                initialQuery={searchQuery}
              />
            </div>
          </div>
        )}

        {myMusic && (
          <MyMusicModal tab={myMusic} library={library} playback={playback} onClose={() => setMyMusic(null)} />
        )}

        {settings.showDesktopLyric && <DesktopLyric />}
      </main>

      <nav className="bottom-nav">
        <button className={tab === 'home' ? 'active' : ''} onClick={() => setTab('home')}>
          <span className="ico">
            <Icon name="home" />
          </span>
          <span>主页</span>
        </button>
        <button className={tab === 'player' ? 'active' : ''} onClick={() => setTab('player')}>
          <span className="ico">
            <Icon name="music" />
          </span>
          <span>播放</span>
        </button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          <span className="ico">
            <Icon name="settings" />
          </span>
          <span>设置</span>
        </button>
      </nav>

      <Disclaimer onAccept={() => {}} />
      {showDebug && <DebugPanel onClose={() => setShowDebug(false)} />}
    </div>
  );
}
