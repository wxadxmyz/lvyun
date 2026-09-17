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
import MiniPlayer from './MiniPlayer';
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
// v2.4.6 #3：切 tab 时主动重推一次系统栏颜色（四段同色）
import { syncNavBarNow } from '../lib/navBar';
import SplashScreen from '../components/SplashScreen';
import { getCurrentWindow } from '@tauri-apps/api/window';

type Tab = 'home' | 'player' | 'settings';

export default function MusicApp() {
  const store = useSources('music');
  const library = useLibrary('music');
  const { settings } = useSettings();
  const state = usePlayer(); // 订阅播放状态（播放 tab 依赖）
  useGlobalShortcuts(); // 全局快捷键：空格/←→/↑↓/M/N/P

  const [tab, setTab] = useState<Tab>('home');
  const [fromTab, setFromTab] = useState<Tab>('home'); // 进入播放页前的 tab，返回时回到这里而非固定主页
  const [fromSearch, setFromSearch] = useState(false); // v2.4.8 #7：是否从搜索浮层进入播放页
  const [searchOpen, setSearchOpen] = useState(false);
  const [myMusic, setMyMusic] = useState<null | 'favorites' | 'playlists'>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [searchQuery, setSearchQuery] = useState<string | undefined>(undefined);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsSub, setSettingsSub] = useState<string | null>(null);
  const [localOpen, setLocalOpen] = useState(false);
  // v2.5.5 #2：任一全屏覆盖页（搜索/历史/本地）打开时，底部 Tab 被 .fullpage 盖住，
  // 给 .app 加 overlay-open，让迷你播放条降回原 Tab 位置（见 styles.css）。
  const overlayOpen = searchOpen || historyOpen || localOpen;

  // 统一切 tab：进入播放页时记忆来源 tab，供系统返回手势回退到上一级
  const goTab = (t: Tab) => {
    if (t === 'player') {
      setFromTab(tab);
      // v2.4.8 #7：记住「是不是从搜索浮层点歌进的播放页」，返回时据此回到搜索浮层
      setFromSearch(searchOpen);
    }
    setTab(t);
  };

  // v2.4.5 #6：所有「点歌曲」入口播完即跳播放页（统一注入，见 playback.ts）。
  // 覆盖：搜索结果卡片/▶、历史页整行/▶、我的喜欢、歌单▶、榜单、本地音乐。
  const playback = usePlayback(store.sources, library, () => goTab('player'));

  useEffect(() => {
    if (settings.themeColor) {
      document.documentElement.style.setProperty('--accent', settings.themeColor);
      document.documentElement.style.setProperty('--accent2', settings.themeColor);
    }
  }, [settings.themeColor]);

  /* v2.4.6 #3：播放页「四段同色」——通知栏 / 顶栏区 / 底部 Tab / 手势条 与播放器背景一致。
   *
   * 前两段由 CSS 负责（.pv-root 吃 --bg、::before 垫状态栏区、.pv-root ~ .bottom-nav
   * 抹掉分隔线与阴影）；后两段必须由原生桥 setBarsColor 染。桥是异步延迟绑定的，
   * 而「主页 ↔ 播放页」切换正是 --bg 感觉最明显变化的时刻，所以每次 tab 变化都主动推一次，
   * 不依赖 MutationObserver 那 200ms 节流（否则能看出被.Tab 闪一下的割裂感）。 */
  useEffect(() => {
    syncNavBarNow();
  }, [tab]);

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
    fromSearch: false,
  });
  navRef.current = { tab, fromTab, fromSearch };

  // v2.4.10 #7：fromSearch 的 ref 镜像。
  //
  // 返回键桥（__onAndroidBack / onBackButton）是在 useEffect([]) 里注册一次的闭包，
  // 它捕获的是**首次渲染**的 handleBack —— 那时 fromSearch 恒为 false。
  // 之前靠 navRef.current 兜住 tab/fromTab，但 fromSearch 没进这个镜像，
  // 于是「从搜索进播放页 → 返回」会走不到 fromSearch 分支，直接回底层 tab。
  // 这里把它也同步进 ref，让返回行为在整条链路上都读得到最新值。
  const fromSearchRef = useRef(false);
  fromSearchRef.current = fromSearch;

  const handleBack = (): boolean => {
    const s = navRef.current;
    // ⚠️ v2.4.10 #7：播放页分支必须**排在 dispatchBack() 之前**。
    //
    // 旧顺序是先问栈、再判 tab === 'player'。而搜索浮层（SearchView）在播放页打开时
    // 并没有卸载 —— 它只是被 `.main.player-open{display:none}` 藏起来，返回栈上的
    // 那条 handler 一直有效。于是「搜歌 → 点歌进播放页 → 按返回」时：
    //   第 1 步 dispatchBack() 问到了 SearchView，
    //   它的 handler 看到输入框有内容，执行 setKw('') + setItems([]) 并 return true
    //   → 返回被"消费"掉了，播放页纹丝不动，搜索结果却被清空。
    // 用户要的是「返回 → 回到刚才那份搜索结果」，不是「返回 → 结果没了」。
    //
    // 正确语义：播放页是**全屏层**，返回的第一优先级就是退出它（回到搜索浮层，
    // 且保留结果）；只有不在播放页时，才轮到浮层自己决定怎么处理返回。
    if (s.tab === 'player') {
      // v2.4.8 #7：若它是由「搜索浮层」点歌进入的，回到搜索浮层（保留结果与滚动位置）
      // v2.4.10 #7：fromSearch 读 ref 镜像，避免闭包捕获首帧的 false。
      if (fromSearchRef.current) { setSearchOpen(true); setTab(s.fromTab); return true; }
      setTab(s.fromTab);
      return true;
    }
    // 1) 不在播放页 → 问栈：已挂载的浮层/子页各自决定是否消费
    if (dispatchBack()) return true;
    // 2) 栈空 → 外层分级：其它 tab 回到主页
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
        {/* v2.4.5 #2：改用两行式（.track-row.tl2）。
            旧布局是「封面40 + 歌名flex:1 + 歌手160 + 来源90」四列硬拼，
            窄屏总宽一超，flex:1 的歌名列第一个被压成 0 宽 → 歌名整条消失。
            现在歌名独占一行，歌手降为副行，来源缩成小标签，宽度永不为 0。 */}
        {items.map((it, i) => (
          <div className="track-row tl2" key={it.sourceId + it.id} onClick={() => playback.play(it, items, i)}>
            <span className="tcover" style={{ background: gradientFor(it.title) }}>{initial(it.title)}</span>
            <span className="tmain">
              <span className="ttitle">{it.title}</span>
              <span className="tsub">{it.artist ?? it.year ?? ''}</span>
            </span>
            <span className="tsrc">{it.sourceName}</span>
            <span className="tactions">
              <button className="mini" title="播放" onClick={(e) => { e.stopPropagation(); playback.play(it, items, i); }}><Icon name="play" size={16} /></button>
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
      <div className={"app music-theme" + (overlayOpen ? " overlay-open" : "")}>
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
          {/* v2.4.6 #12（方案 A）：顶栏「调试」虫图标已移除。
              新入口 = 设置 → 关于 → 连点版本号 7 次（见 SettingsPage.onVersionTap）。 */}
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
            onOpenLocal={() => setLocalOpen(true)}
          />
        )}

        {tab === 'settings' && (
          <SettingsPage
            onOpenMyMusic={setMyMusic}
            sub={settingsSub}
            setSub={setSettingsSub}
            onOpenDebug={() => setShowDebug(true)}
          />
        )}

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
            {/* v2.4.9 #5.1：播放页打开时搜索页被盖住（不可见），
                传 active 让 SearchView 在返回时恢复原来的滚动位置 */}
            <SearchView
              onClose={() => setSearchOpen(false)}
              sources={store.sources}
              onPlay={(it) => playback.play(it)}
              onQueue={(its) => player.enqueue(its)}
              library={library}
              mediaType="music"
              placeholder="搜索歌曲 / 歌手 / 专辑…"
              initialQuery={searchQuery}
              active={tab !== 'player'}
              onOpenPlayer={() => { setSearchOpen(false); setTab('player'); }}
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

      {/* v2.5.2 #11：底部迷你播放条 —— 非播放页时显示，点整条回播放页。
          放在 .bottom-nav 之前，视觉上贴在 Tab 上方。 */}
      <MiniPlayer onOpen={() => setTab('player')} hidden={tab === 'player'} />

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
