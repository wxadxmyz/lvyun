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
// v2.4.4 #0：全局音频宿主 —— 全项目唯一的 <audio> 元素持有者与播放执行者。
// 挂在 .app 顶层、<main> 之外，不随 Tab 切换或播放页开关而卸载。
import { AudioHost } from './AudioHost';
import { DesktopLyric } from './DesktopLyric';
import { Discover } from './views/Discover';
import { LocalMusicView } from './views/LocalMusicView';
import { MyMusicModal } from './MyMusicModal';
import { SettingsPage } from './SettingsPage';
import { Disclaimer } from '../components/Disclaimer';
import { gradientFor, initial } from '../lib/cover';
import { Icon } from '../components/Icon';
// v2.3.11 #4：返回键栈式调度
import { dispatchBack, pushBackHandler } from '../lib/backStack';
import SplashScreen from '../components/SplashScreen';
import { getCurrentWindow } from '@tauri-apps/api/window';

type Tab = 'home' | 'player' | 'settings';

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

  /* ---------------------------------------------------------------------
   * v2.3.11 #4：返回键改为「栈式调度」，两份入口共用同一个 handleBack。
   *
   * 返回值语义严格对齐 MainActivity 的约定（.github/workflows/android.yml:122-124）：
   *   Kotlin: `window.__onAndroidBack() → true 则不调用 super.onBackPressed()`
   *   即 **true = 本次返回已被消费（App 不退出）；false = 无人处理，交给系统退出**。
   *
   * ⚠️ 旧实现把这两个值写反了：关闭浮层后返回 false，Kotlin 侧照样调
   *    super.onBackPressed()，于是「在二级页按返回 → 直接退出到桌面」。
   *    这正是不少「返回手势不逐级」反馈的真正原因 —— 不是跳回主页，是退出了 App。
   *
   * 另一处结构性问题：原先是一条扁平 if-else 单槽链，settingsSub 只是 string|null，
   * 子页内部更深的层级父容器看不见，所以只能一步清空。现在每个浮层/子页自己
   * pushBackHandler，栈从顶往下问，天然支持 N 级逐级返回。
   * ------------------------------------------------------------------- */
  const navRef = useRef({
    tab: 'home' as Tab,
    fromTab: 'home' as Tab,
  });
  navRef.current = { tab, fromTab };

  const handleBack = (): boolean => {
    // 1) 先问栈：已挂载的浮层/子页各自决定是否消费
    if (dispatchBack()) return true;
    // 2) 栈空 → 外层分级：播放页回到来源 tab，其它 tab 回到主页
    const s = navRef.current;
    if (s.tab === 'player') { setTab(s.fromTab); return true; }
    if (s.tab !== 'home') { setTab('home'); return true; }
    return false; // 已经在主页 → 交给系统退出
  };

  // Android 原生返回键桥接：Kotlin MainActivity 通过 __onAndroidBack 调用此函数
  useEffect(() => {
    (window as any).__onAndroidBack = () => handleBack();
    return () => { delete (window as any).__onAndroidBack; };
  }, []);

  // 手势返回：Tauri v2 的 onBackButton（Android Predictive Back / 侧滑）。
  // 注意：这里用「点访问」而非直接调用 —— onBackButton 的类型定义并非在所有
  // @tauri-apps/api 版本里都有（旧版本是 onBackButton / 新版本仍保留），运行时由
  // catch 兜底，避免类型与运行时耦合导致整个文件编译不过。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const w = getCurrentWindow() as unknown as {
          onBackButton?: (cb: (e: { preventDefault: () => void }) => void) => Promise<() => void>;
        };
        if (typeof w.onBackButton !== 'function') return;
        const un = await w.onBackButton((event) => {
          if (handleBack()) event.preventDefault();
        });
        unlisten = un;
      } catch {
        /* 不支持 onBackButton 的环境忽略 */
      }
    })();
    return () => unlisten?.();
  }, []);

  /* App 层级的浮层各自登记返回行为。栈式调度下新增浮层只要加一行，
     不必再回到这里的中央登记表——从根上消灭「浮层忘了登记就退 App」的问题。 */
  useEffect(() => {
    if (!showDebug) return;
    return pushBackHandler(() => { setShowDebug(false); return true; });
  }, [showDebug]);
  useEffect(() => {
    if (!myMusic) return;
    return pushBackHandler(() => { setMyMusic(null); return true; });
  }, [myMusic]);
  useEffect(() => {
    if (!historyOpen) return;
    return pushBackHandler(() => { setHistoryOpen(false); return true; });
  }, [historyOpen]);
  useEffect(() => {
    if (!localOpen) return;
    return pushBackHandler(() => { setLocalOpen(false); return true; });
  }, [localOpen]);

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
      <div className="app music-theme">
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

      <main className={'main' + (tab === 'player' ? ' player-open' : '')}>
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

        {tab === 'settings' && <SettingsPage onOpenMyMusic={setMyMusic} sub={settingsSub} setSub={setSettingsSub} />}

        {localOpen && <LocalMusicView playback={playback} library={library} onClose={() => setLocalOpen(false)} />}

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

      {/* v2.3.11 #1：播放页独立成与 <main> 平级的全屏层。
          放在 main 里时会同时吃到 .main（移动端 14px / tabbar+80px）与 .pv-player
          自身的内边距，四周自然留出白边；抬出来后才能真正铺满。 */}
      {tab === 'player' && (
        <FullScreenPlayer sources={store.sources} library={library} onClose={() => setTab(fromTab)} />
      )}

      {/* v2.4.4 #0：音频宿主必须常驻（早于 bottom-nav、晚于 main）。
          放在这里保证任何 Tab 下 MusicApp 都在渲染它，切页面不会断音。 */}
      <AudioHost sources={store.sources} library={library} />

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
