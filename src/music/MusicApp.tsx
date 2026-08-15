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
import { gradientFor, initial } from '../lib/cover';
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsSub, setSettingsSub] = useState<string | null>(null);

  useEffect(() => {
    if (settings.themeColor) {
      document.documentElement.style.setProperty('--accent', settings.themeColor);
      document.documentElement.style.setProperty('--accent2', settings.themeColor);
    }
  }, [settings.themeColor]);

  // touchStart ref for swipe navigation
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
            onOpenHistory={() => setHistoryOpen(true)}
          />
        )}

        {tab === 'player' && state.current && (
          <FullScreenPlayer sources={store.sources} library={library} onClose={() => setTab('home')} />
        )}
        {tab === 'player' && !state.current && (
          <div className="fs-player fs-empty">
            <div className="fs-top">
              <button className="icon" disabled>
                <Icon name="chevron-down" />
              </button>
              <span className="fs-now">正在播放</span>
              <button className="icon" disabled>
                <Icon name="list" />
              </button>
            </div>
            <div className="fs-body">
              <div className="fs-disc-wrap">
                <div className="fs-disc">
                  <span className="ph" style={{ background: 'var(--panel2)' }}>
                    <Icon name="music" size={56} />
                  </span>
                </div>
              </div>
              <div className="fs-info">
                <h1 className="fs-title">未在播放</h1>
                <div className="fs-progress">
                  <span className="t">0:00</span>
                  <input type="range" disabled />
                  <span className="t">-0:00</span>
                </div>
                <div className="fs-ctrl">
                  <button className="icon" disabled>
                    <Icon name="repeat" />
                  </button>
                  <button className="icon big" disabled>
                    <Icon name="skip-back" />
                  </button>
                  <button className="icon play big" disabled>
                    <Icon name="play" />
                  </button>
                  <button className="icon big" disabled>
                    <Icon name="skip-forward" />
                  </button>
                  <button className="icon" disabled>
                    <Icon name="heart" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === 'settings' && <SettingsPage onOpenMyMusic={setMyMusic} sub={settingsSub} setSub={setSettingsSub} />}

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
