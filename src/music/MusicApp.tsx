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
import { LocalMusicView } from './views/LocalMusicView';
import { MyMusicModal } from './MyMusicModal';
import { SettingsPage } from './SettingsPage';
import { Disclaimer } from '../components/Disclaimer';
import { gradientFor, initial } from '../lib/cover';
import { Icon } from '../components/Icon';
import SplashScreen from '../components/SplashScreen';
import { getCurrentWindow } from '@tauri-apps/api/window';

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
  const [fromTab, setFromTab] = useState<Tab>('home'); // 进入播放页前的 tab，返回时回到这里而非固定主页
  const [searchOpen, setSearchOpen] = useState(false);
  const [myMusic, setMyMusic] = useState<null | 'favorites' | 'playlists'>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [searchQuery, setSearchQuery] = useState<string | undefined>(undefined);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsSub, setSettingsSub] = useState<string | null>(null);
  const [localOpen, setLocalOpen] = useState(false);

  // 统一切 tab：进入播放页时记忆来源 tab，供系统返回手势回退到上一级
  const goTab = (t: Tab) => {
    if (t === 'player') setFromTab(tab);
    setTab(t);
  };

  useEffect(() => {
    if (settings.themeColor) {
      document.documentElement.style.setProperty('--accent', settings.themeColor);
      document.documentElement.style.setProperty('--accent2', settings.themeColor);
    }
  }, [settings.themeColor]);

  // Android 原生返回键桥接：Kotlin MainActivity 通过 __onAndroidBack 调用此函数
  useEffect(() => {
    (window as any).__onAndroidBack = () => {
      const s = navRef.current;
      if ((window as any).__playerBack && (window as any).__playerBack()) return false;
      if (s.showDebug) { setShowDebug(false); return false; }
      if (s.searchOpen) { setSearchOpen(false); return false; }
      if (s.myMusic) { setMyMusic(null); return false; }
      if (s.historyOpen) { setHistoryOpen(false); return false; }
      if (s.localOpen) { setLocalOpen(false); return false; }
      if (s.settingsSub) { setSettingsSub(null); return false; }
      if (s.tab === 'player') { setTab(s.fromTab); return false; } // 播放页返回上一级 tab，而非主页
      if (s.tab !== 'home') { setTab('home'); return false; }
      return true; // 不拦截，交给系统退出
    };
    return () => { delete (window as any).__onAndroidBack; };
  }, []);

  // 手势返回：Android 返回键 / 侧滑逐级返回，而非直接退出到桌面
  const navRef = useRef({
    tab: 'home' as Tab,
    fromTab: 'home' as Tab,
    searchOpen: false,
    myMusic: null as null | 'favorites' | 'playlists',
    showDebug: false,
    historyOpen: false,
    localOpen: false,
    settingsSub: null as string | null,
  });
  navRef.current = { tab, fromTab, searchOpen, myMusic, showDebug, historyOpen, localOpen, settingsSub };
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const un = await getCurrentWindow().onBackButton((event) => {
          const s = navRef.current;
          if ((window as any).__playerBack && (window as any).__playerBack()) { event.preventDefault(); return; }
          if (s.showDebug) {
            event.preventDefault();
            setShowDebug(false);
          } else if (s.searchOpen) {
            event.preventDefault();
            setSearchOpen(false);
          } else if (s.myMusic) {
            event.preventDefault();
            setMyMusic(null);
          } else if (s.historyOpen) {
            event.preventDefault();
            setHistoryOpen(false);
          } else if (s.localOpen) {
            event.preventDefault();
            setLocalOpen(false);
          } else if (s.settingsSub) {
            event.preventDefault();
            setSettingsSub(null);
          } else if (s.tab === 'player') {
            event.preventDefault();
            setTab(s.fromTab);
          } else if (s.tab !== 'home') {
            event.preventDefault();
            setTab('home');
          }
          // 否则不拦截，交给系统退出 App
        });
        unlisten = un;
      } catch {
        /* 不支持 onBackButton 的环境忽略 */
      }
    })();
    return () => unlisten?.();
  }, []);

  // touchStart ref for swipe navigation
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
      if (dx < 0 && i < ORDER.length - 1) goTab(ORDER[i + 1]);
      else if (dx > 0 && i > 0) goTab(ORDER[i - 1]);
    }
  };

  const goSearch = (q: string) => {
    setSearchQuery(q);
    setSearchOpen(true);
  };

  // 「历史播放记录」列表：点击右上角时钟图标打开
  const HistoryList = () => {
    const items = library.lib.history.filter((i) => i.mediaType === 'music');
    return (
      <div className="track-list">
        {items.length === 0 && <div className="muted sm">还没有播放记录。</div>}
        {items.map((it, i) => (
          <div className="track-row" key={it.sourceId + it.id} onClick={() => playback.play(it, items, i)}>
            <span className="tcover" style={{ background: gradientFor(it.title) }}>{initial(it.title)}</span>
            <span className="ttitle">{it.title}</span>
            <span className="tsub">{it.artist ?? it.year ?? ''}</span>
            <span className="tsrc">{it.sourceName}</span>
            <span className="tactions">
              <button className="mini" title="播放" onClick={() => playback.play(it, items, i)}><Icon name="play" size={16} /></button>
            </span>
          </div>
        ))}
      </div>
    );
  };

  const openSources = () => goTab('settings');

  return (
    <>
      <SplashScreen
        appName="律云"
        iconSrc={import.meta.env.BASE_URL + 'icon.png'}
        gradient="linear-gradient(160deg, #FF7AB6 0%, #C05CFF 45%, #3A1E5C 100%)"
      />
      <div className="app music-theme" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <linearGradient id="lvTabGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ff5c8a" /><stop offset="1" stopColor="#b46cff" />
          </linearGradient>
          <linearGradient id="lvTabGradHot" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ff7aa6" /><stop offset="1" stopColor="#c98bff" />
          </linearGradient>
          <g id="ic-home"><path d="m3 9.2 9-6.4 9 6.4v10.4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9.2 21.6V12.4h5.6v9.2" /></g>
          <g id="ic-player"><path d="M9 18V4.5l11-2v13.5" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></g>
          <g id="ic-settings"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></g>
        </defs>
      </svg>
      <header className="topbar">
        <div className="brand">
          <span className="logo">
            <Icon name="music" size={20} />
          </span>{' '}
          律云
        </div>
        <nav className="nav">
          <button className={tab === 'home' ? 'active' : ''} onClick={() => goTab('home')}>
            主页
          </button>
          <button className={tab === 'player' ? 'active' : ''} onClick={() => goTab('player')}>
            播放
          </button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => goTab('settings')}>
            设置
          </button>
        </nav>
        <div className="tb-right">
          <button className="icon" onClick={() => setShowDebug(true)} title="调试">
            <Icon name="bug" />
          </button>
          <button className="icon settings-btn" onClick={() => goTab('settings')} title="设置" aria-label="设置">
            <Icon name="settings" size={20} />
          </button>
        </div>
      </header>

      <main className="main">
        {tab === 'home' && !localOpen && (
          <Discover
            sources={store.sources}
            library={library}
            playback={playback}
            onSearch={goSearch}
            onOpenSources={openSources}
            onOpenHistory={() => setHistoryOpen(true)}
            onOpenDebug={() => setShowDebug(true)}
            onOpenLocal={() => setLocalOpen(true)}
          />
        )}

        {tab === 'player' && (
          <FullScreenPlayer sources={store.sources} library={library} onClose={() => setTab(fromTab)} />
        )}

        {tab === 'settings' && <SettingsPage onOpenMyMusic={setMyMusic} sub={settingsSub} setSub={setSettingsSub} />}

        {localOpen && <LocalMusicView playback={playback} onClose={() => setLocalOpen(false)} />}

        {historyOpen && (
          <div className="fullpage">
            <div className="fullpage-head">
              <button className="icon" onClick={() => setHistoryOpen(false)}>
                <Icon name="arrow-left" />
              </button>
              <h3>历史播放</h3>
              {library.lib.history.some((i) => i.mediaType === 'music') && (
                <button className="link" style={{ marginLeft: 'auto' }} onClick={() => library.clearHistory()}>清空</button>
              )}
            </div>
            <div className="fullpage-body">
              <HistoryList />
            </div>
          </div>
        )}

        {searchOpen && (
          <div className="fullpage">
            <SearchView
              onClose={() => setSearchOpen(false)}
              sources={store.sources}
              onPlay={(it) => playback.play(it)}
              onQueue={(its) => player.enqueue(its)}
              library={library}
              mediaType="music"
              placeholder="搜索歌曲 / 歌手 / 专辑…"
              initialQuery={searchQuery}
            />
          </div>
        )}

        {myMusic && (
          <MyMusicModal tab={myMusic} library={library} playback={playback} onClose={() => setMyMusic(null)} />
        )}

        {settings.showDesktopLyric && <DesktopLyric />}
      </main>

      <nav className="bottom-nav">
        {(['home', 'player', 'settings'] as const).map((id) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => goTab(id)}>
            <span className="ico">
              <svg className="tab-ic" viewBox="0 0 24 24" aria-hidden="true"><use href={`#ic-${id}`} /></svg>
            </span>
            <span>{id === 'home' ? '主页' : id === 'player' ? '播放' : '设置'}</span>
          </button>
        ))}
      </nav>

      <Disclaimer onAccept={() => {}} />
      {showDebug && <DebugPanel onClose={() => setShowDebug(false)} />}
    </div>
    </>
  );
}
