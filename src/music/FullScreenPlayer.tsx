import { useEffect, useMemo, useRef, useState, type TouchEvent } from 'react';
import { usePlayer, fmtTime, player, getAudioElement } from '../lib/playerStore';
import { getEqGains, setEqGains, subscribeEq, EQ_PRESETS, EQ_BANDS } from '../lib/spectrum';
import { useSettings } from '../lib/settings';
import type { useLibrary } from '../lib/library';
import { SourceConfig, MediaItem } from '../engine/types';
// v2.4.5 #5：作者页改为真实搜索（此前只在播放队列里筛，所以只有播放过的歌）
import { aggregateSearch, aggregateArtist } from '../engine';
import { gradientFor } from '../lib/cover';
import { Icon } from '../components/Icon';
import ArtistPage from './ArtistPage';
// v2.4.6 #7：命令式中文输入弹窗（替代 window.prompt —— Android WebView 的原生
// JsPromptDialog 按钮文案是内置英文 CANCEL/OK，前端无法控制）
import { promptText } from '../components/PromptDialog';
import { useToast } from '../lib/toast';
// v2.3.11 #4：返回键栈式调度
import { pushBackHandler } from '../lib/backStack';
// v2.4.2 #E：横屏真旋转（等桥 / 校验 / 代际 token / 失败不切 UI）
import { requestOrientation } from '../lib/orientation';
import { setStatusBarVisible, setLandscapeBars, syncNavBarNow, holdNavBarPush } from '../lib/navBar';

const MODE_ICON: Record<string, { icon: 'repeat' | 'repeat-one' | 'shuffle'; label: string }> = {
  list: { icon: 'repeat', label: '列表循环' },
  one: { icon: 'repeat-one', label: '单曲循环' },
  shuffle: { icon: 'shuffle', label: '随机播放' },
};
const MODE_LABEL: Record<string, string> = { list: '列表循环', one: '单曲循环', shuffle: '随机播放' };
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
type SleepMode = 'off' | '15' | '30' | '60' | 'end';

// 计算当前歌词高亮行
function activeIndex(lines: { time: number; text: string }[], progress: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= progress + 0.2) idx = i;
    else break;
  }
  return idx;
}

/* ---------------------------------------------------------------------------
 * 播放页图标：path 与 stroke-width 严格照抄设计稿（律云_ui.html ⑤⑥ 屏），
 * 不用通用图标库，避免线宽/造型与设计稿对不上。
 * ------------------------------------------------------------------------- */
const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const IC = {
  // 顶栏：汉堡（左，打开播放列表）/ 竖排三点（右，打开更多）
  menu: <svg viewBox="0 0 24 24" {...S}><path d="M4 7h16M4 12h16M4 17h10" /></svg>,
  more: <svg viewBox="0 0 24 24" {...S}><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></svg>,
  // 封面内的音符
  note: <svg viewBox="0 0 24 24" {...S}><path d="M9 18V6l10-2v12" /><circle cx="6" cy="18" r="3" /><circle cx="16" cy="16" r="3" /></svg>,
  // 控制区五个按钮，顺序与设计稿一致：循环 / 上一首 / 播放 / 下一首 / 喜欢
  //
  // v2.4.5 #1：控制区图标整套重做为「A · 实心几何」—— 全部原创绘制，
  // 造型语言为实心块面（不描边、无外圈），与网易云音乐等第三方图标无关。
  // 两个硬性修复随本次一并落地：
  //   ① 暂停键改为两根实心圆角柱。旧实现是 <line> + stroke，而 CSS
  //      `.pv-btn.play svg{fill:#fff;stroke:none}` 会把 stroke 抹掉 → 播放中
  //      按钮里什么都看不见（用户反馈「看不到里面的内容」）。实心元素不吃这条规则。
  //   ② 循环模式改为三态三图形（见 IC_MODE），不再三态共用同一个图标。
  prev: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.4" y="5.4" width="3" height="13.2" rx="1.5" fill="currentColor" />
      <path d="M18.7 5.9v12.2a1.1 1.1 0 0 1-1.69.93l-8.6-6.1a1.1 1.1 0 0 1 0-1.86l8.6-6.1A1.1 1.1 0 0 1 18.7 5.9z" fill="currentColor" />
    </svg>
  ),
  play: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.7 4.6a1.2 1.2 0 0 1 1.83-1.02l10.3 6.4a1.2 1.2 0 0 1 0 2.04l-10.3 6.4A1.2 1.2 0 0 1 7.7 17.4z" fill="currentColor" />
    </svg>
  ),
  pause: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6.4" y="4.7" width="4.2" height="14.6" rx="2.1" fill="currentColor" />
      <rect x="13.4" y="4.7" width="4.2" height="14.6" rx="2.1" fill="currentColor" />
    </svg>
  ),
  next: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5.3 5.9v12.2a1.1 1.1 0 0 0 1.69.93l8.6-6.1a1.1 1.1 0 0 0 0-1.86l-8.6-6.1A1.1 1.1 0 0 0 5.3 5.9z" fill="currentColor" />
      <rect x="16.6" y="5.4" width="3" height="13.2" rx="1.5" fill="currentColor" />
    </svg>
  ),
  // 原创几何心：两个圆 + 一个下尖三角拼成（非通用贝塞尔心形路径）
  like: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="8.4" cy="9.5" r="4.1" fill="currentColor" />
      <circle cx="15.6" cy="9.5" r="4.1" fill="currentColor" />
      <path d="M4.5 9.8h15L12 20.7z" fill="currentColor" />
    </svg>
  ),
};

/* v2.4.5 #1：循环模式三态 —— 原创「轨道循环」符号体系。
   list = 三条列表线 + 右侧上下循环箭头；one = 单条 + 数字 1 + 循环箭头；
   shuffle = 交叉折线 + 端点实心方块。三态三个图形，切了就知道当前是哪种。 */
const IC_MODE: Record<string, JSX.Element> = {
  list: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.6 7.6h9.2M3.6 12h9.2M3.6 16.4h5.6" />
      <path d="M17.8 6.6v10.8" />
      <path d="M15.4 8.9 17.9 6.4l2.5 2.5" />
      <path d="M15.4 15.1l2.5 2.5 2.5-2.5" />
    </svg>
  ),
  one: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.6 12h4.4" />
      <text x="10.4" y="16.6" fontSize="13" fontWeight="800" textAnchor="middle" fill="currentColor" stroke="none" fontFamily="system-ui,sans-serif">1</text>
      <path d="M17.8 6.6v10.8" />
      <path d="M15.4 8.9 17.9 6.4l2.5 2.5" />
      <path d="M15.4 15.1l2.5 2.5 2.5-2.5" />
    </svg>
  ),
  shuffle: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.4 7.4h3.1c1 0 1.7.6 2.3 1.6l4.2 6c.6 1 1.3 1.6 2.3 1.6h3.1" />
      <path d="M3.4 16.6h3.1c1 0 1.7-.6 2.3-1.6l4.2-6c.6-1 1.3-1.6 2.3-1.6h3.1" />
      <rect x="16.4" y="5.1" width="3.6" height="3.6" rx="1.4" fill="currentColor" stroke="none" />
      <rect x="16.4" y="15.3" width="3.6" height="3.6" rx="1.4" fill="currentColor" stroke="none" />
      <rect x="1.6" y="5.5" width="2.6" height="2.6" rx="1.1" fill="currentColor" stroke="none" />
      <rect x="1.6" y="15.7" width="2.6" height="2.6" rx="1.1" fill="currentColor" stroke="none" />
    </svg>
  ),
};

export function FullScreenPlayer({
  sources,
  library,
  onClose,
}: {
  sources: SourceConfig[];
  library: ReturnType<typeof useLibrary>;
  onClose: () => void;
}) {
  const state = usePlayer();
  const { settings, update } = useSettings();
  const toast = useToast();
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [menuView, setMenuView] = useState<'main' | 'add' | 'speed' | 'timer'>('main');
  const [showAuthor, setShowAuthor] = useState(false);
  const [showLandscape, setShowLandscape] = useState(false);
  // v2.4.0 H1：横屏 3 秒无操作自动隐藏（只剩当前行歌词），点击切换
  const [landHidden, setLandHidden] = useState(false);
  const landTimer = useRef<number | undefined>(undefined);
  const [showEq, setShowEq] = useState(false);
  // 封面位切换成同尺寸歌词面板（设计稿 .lyrics，200×200 替换 .cover）
  const [coverLyric, setCoverLyric] = useState(false);
  // v2.4.6 #11：加歌单的**目标歌曲**。
  //   旧实现写死当前播放的 `it`，于是「播放列表行尾 ＋」只能加正在播的那首。
  //   现在两个入口各自指定目标：⋮ 菜单 → null（跟随当前播放）；行尾 ＋ → 该行歌曲。
  const [addTarget, setAddTarget] = useState<MediaItem | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [speed, setSpeed] = useState(settings.playbackRate || 1);
  const [eqGains, setEqGainsLocal] = useState<number[]>(getEqGains());
  const [eqPreset, setEqPreset] = useState('关闭');
  const [sleepMode, setSleepMode] = useState<SleepMode>(
    settings.sleepEnd ? 'end' : settings.sleepTimer > 0 ? (String(settings.sleepTimer) as SleepMode) : 'off',
  );
  // 应用到播放器并持久化到设置（与设置页睡眠定时子页共用一份状态）
  const applySleep = (m: SleepMode) => {
    setSleepMode(m);
    if (m === 'off') update({ sleepTimer: 0, sleepEnd: false });
    else if (m === 'end') update({ sleepTimer: 0, sleepEnd: true });
    else update({ sleepTimer: Number(m), sleepEnd: false });
  };
  useEffect(() => {
    setSleepMode(settings.sleepEnd ? 'end' : settings.sleepTimer > 0 ? (String(settings.sleepTimer) as SleepMode) : 'off');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.sleepTimer, settings.sleepEnd]);

  // 播放器内部浮层纳入系统返回手势栈：返回先关最上层浮层，再交由 MusicApp 退出播放页。
  // v2.3.11 #4：由「往 window 上挂单槽 __playerBack」改为「向返回栈压一条 handler」。
  // 单槽的毛病是只有最后挂载者能说话，播放器与 App 级浮层同时存在时会互相覆盖；
  // 压栈后 MusicApp 的 dispatchBack 会先问到这一层，栈的自然顺序就是层级顺序。
  useEffect(
    () =>
      pushBackHandler(() => {
        if (showLandscape) { setShowLandscape(false); return true; }
        if (showAuthor) { setShowAuthor(false); return true; }
        if (showEq) { setShowEq(false); return true; }
        if (showMenu) {
          // 菜单内的二级视图（如歌单选择、睡眠定时）先退回主菜单，再关菜单
          if (menuView !== 'main') { setMenuView('main'); setAddTarget(null); return true; }
          setShowMenu(false);
          setAddTarget(null);
          return true;
        }
        if (showPlaylist) { setShowPlaylist(false); return true; }
        if (coverLyric) { setCoverLyric(false); return true; }
        return false; // 播放器自己没有浮层，放行给外层
      }),
    [showPlaylist, showAuthor, showLandscape, showMenu, menuView, showEq, coverLyric],
  );
  // v2.4.6 #6：横屏时给 <body> 挂 .landscape-on 标记。
  // 底部 Tab（.bottom-nav）挂在 App 根层、与播放页同级，CSS 无法从 .fs-land 反向选中它，
  // 所以用 body 标记做开关：横屏隐藏 Tab + 收紧内容 padding，进度条才能贴到底边。
  //
  // v2.4.10 #13：改为「等布局稳定后再挂」。
  //
  // 旧实现是同步 toggle —— showLandscape 一置 true，.landscape-on 立刻生效，
  // 而它触发的是一整套重排（.main.player-open display:none、.pv-root 转 fixed），
  // 此刻 .fs-land 还没完成布局；重排结果就是「整屏空白」，用户必须再点一下才恢复。
  // 这就是「横屏要点两下才进得去」的主要表现之一。
  //
  // 现在用双 requestAnimationFrame 把挂类推迟到「下一帧渲染完成后」：
  // 第一帧让 React 把 .fs-land 挂进 DOM，第二帧等浏览器完成布局，再挂类触发重排。
  // 卸载时（含 showLandscape 变 false）用 cleanup 取消未执行的 rAF，避免迟到执行。
  useEffect(() => {
    if (!showLandscape) {
      document.body.classList.remove('landscape-on');
      return;
    }
    let raf1 = 0, raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        document.body.classList.add('landscape-on');
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      document.body.classList.remove('landscape-on');
    };
  }, [showLandscape]);

  // v2.4.10 #13：旋转期间锁住输入的透明遮罩。
  //
  // 旋转校验最长要 6s（orientation.ts 的 VERIFY_MAX_RETRY），这段时间里
  // 底部 Tab 还在（.landscape-on 未挂）、播放页已开 —— 用户随手点一下 Tab 就
  // goTab('home') → tab !== 'player' → FullScreenPlayer **整棵卸载**
  // → 卸载 effect 发 portrait → 转回竖屏 → 掉回主页。
  // 用户观感是「点了横屏，结果跳到别的页面，还得切回来点第二下」。
  //
  // 用一层 pointer-events:auto 的透明遮罩把这段窗口期封住，旋转完成即撤。
  const [oriLocked, setOriLocked] = useState(false);

  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  // v2.4.9 #5.7：sleepTimer ref 已随定时器一起搬到 AudioHost，这里不再保留
  // （留着只会让人以为定时还挂在本组件上）。

  const it = state.current ?? ({ title: '未在播放', artist: '', album: '', id: '', sourceId: '', cover: undefined, lyric: [] } as any);
  const empty = !state.current;
  const fav = state.current ? library.isFavorite(it) : false;

  // v2.4.6 #11：决定「加歌单」作用于哪首歌。
  //   addTarget 为空 → 跟随当前播放歌曲（⋮ 菜单入口）
  //   addTarget 有值 → 用行内指定的那首（播放列表行尾 ＋ 入口）
  const addItem: MediaItem | null = addTarget ?? (state.current ?? null);

  // v2.4.6 #7 + #11：新建歌单后**自动把目标歌曲收进去**。
  //   旧实现只 createPlaylist，用户还得再点一次歌单才加进去（点两次才完成一个动作）。
  const newPlaylist = async () => {
    const name = await promptText({
      title: '新建歌单',
      placeholder: '给歌单起个名字',
      maxLength: 30,
      confirmText: '创建',
    });
    if (!name) return;
    // createPlaylist 的 setState 是异步的，当前 tick 拿不到新歌单 id，
    // 所以用「创建并可选入库」的单次 API 一步完成，避免 create → add 两步竞态。
    library.createPlaylistWith(name, addItem ?? undefined);
    toast.push(addItem ? `已创建「${name}」并加入 1 首` : `已创建「${name}」`);
  };

  // 歌词：优先用带时间轴的 LyricLine，其次降级的字符串数组
  //
  // v2.4.10 #4：加 useMemo —— 旧实现每次渲染都 .map() 出新数组，
  // 于是下游任何 state 变化（连 isPlaying 翻一下）都会新建 lyricLines，
  // 进而让「自动跟随」effect 的一个隐性依赖（渲染期间重建的 DOM 行）反复触发。
  // 用 useMemo 把引用稳定在「歌词内容真正变化时」。
  const lyricLines: { time: number; text: string }[] = useMemo(
    () =>
      Array.isArray(it.lyric)
        ? it.lyric.map((l: any) => ({ time: l.time, text: l.text }))
        : Array.isArray(it.raw?.lyric)
        ? (it.raw.lyric as string[]).map((t: string) => ({ time: 0, text: t }))
        : [],
    [it.lyric, it.raw?.lyric],
  );
  const aLine = lyricLines.length ? activeIndex(lyricLines, state.progress) : -1;

  // v2.4.9 #3.2 / #4.7：歌词自动跟随（竖屏全屏歌词页 + 横屏 3 行歌词区共用）。
  //   1) 用 scrollBy + 差值计算，不用 scrollIntoView —— 后者在部分 WebView 上会
  //      连带把祖先容器一起滚，横屏时会把整页顶歪。
  //   2) 用户手动滑动后 1.5s 内不抢滚动权，否则「刚滑上去看两句又被拽回当前行」。
  //
  // v2.4.10 #4：三处关键修正（旧实现「上滑两下歌词就空了」的根因）。
  //
  //   ① 手动 / 程序滚动必须分开标记。
  //      旧实现把 onScroll 直接当「用户手滑」——但 scrollBy({behavior:'smooth'}) 自己
  //      也会触发 scroll 事件，于是程序滚一下就把自己锁 1.5s，用户再滑就彻底失控。
  //      现在只有 onTouchStart / onWheel 才置手动标志；onScroll 只做同步。
  //
  //   ② 改用绝对赋值 scrollTop，不再 scrollBy。
  //      scrollBy 是**相对**位移：若上一次滚动还没结束（smooth 动画在跑），
  //      新一次 delta 会叠加在中间态上，越滚越远，最终滚过列表末尾 → 整屏空白。
  //      绝对定位天然幂等 —— 重复调用结果一致，不会累积。
  //
  //   ③ delta 加合理性校验：超过容器高度 1.5 倍的位移一律丢弃。
  //      歌词 DOM 重建的瞬间 getBoundingClientRect() 可能拿到未布局的中间态，
  //      算出的 delta 会是个离谱的大数（几千 px）。旧实现照单全收 → scrollBy 直接
  //      滚到尽头 → 「上滑两下歌词消失」。这里直接丢弃这种异常值。
  const ldScrollRef = useRef<HTMLDivElement>(null);
  const landLyricRef = useRef<HTMLDivElement>(null);
  const lyricManualUntil = useRef(0);
  // v2.5.0 #1：歌词页「首次挂载」用瞬时居中，之后才平滑跟随。
  // 否则点开歌词页（scrollTop=0、当前行在视口下方）会被 smooth 从底部滚上来。
  const firstCenterRef = useRef(true);
  const markLyricManual = () => { lyricManualUntil.current = Date.now() + 1500; };
  // v2.4.10 #4：只有真实的手势 / 滚轮才算「用户操作」，程序滚动不算。
  const onLyricTouch = markLyricManual;
  const onLyricWheel = markLyricManual;
  // v2.5.0 #1：打开竖屏歌词页 / 进入横屏时，重新武装「首次瞬时居中」。
  useEffect(() => {
    if (coverLyric || showLandscape) firstCenterRef.current = true;
  }, [coverLyric, showLandscape]);
  useEffect(() => {
    if (aLine < 0) return;
    if (Date.now() < lyricManualUntil.current) { firstCenterRef.current = false; return; }
    const first = firstCenterRef.current;
    const centerOn = (box: HTMLDivElement | null) => {
      if (!box) return;
      const el = box.querySelector('.ld-line.active') as HTMLElement | null;
      if (!el) return;
      const boxRect = box.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      // ③ 布局未就绪（元素尺寸为 0）或位移离谱 → 丢弃，等下一次 aLine 变化再试。
      //    这里用容器高度做上界：正常情况下目标行离中心不会超过半个容器高。
      if (!boxRect.height || !elRect.height) return;
      const delta = elRect.top + elRect.height / 2 - (boxRect.top + boxRect.height / 2);
      if (!Number.isFinite(delta)) return;
      if (Math.abs(delta) > boxRect.height * 1.5) return;
      if (Math.abs(delta) < 4) return;
      // ② 绝对赋值：scrollTop 是「目标行位于容器中心」的解析解，幂等且不会累积漂移。
      const want = box.scrollTop + delta;
      const max = box.scrollHeight - box.clientHeight;
      const next = Math.max(0, Math.min(max, want));
      if (!Number.isFinite(next) || Math.abs(next - box.scrollTop) < 1) return;
      // v2.5.0 #1：首次（刚打开歌词页/刚进横屏）用瞬时定位，直接居中；
      //   之后（播放中逐行跟随）才平滑滚动 —— 即「从顶部开始、高亮到中间锁定」。
      box.scrollTo({ top: next, behavior: first ? 'auto' : 'smooth' });
    };
    centerOn(ldScrollRef.current);
    centerOn(landLyricRef.current);
    firstCenterRef.current = false;
  }, [aLine, coverLyric, showLandscape]);

  // 倍速：同步到 <audio> 并记忆
  useEffect(() => {
    const a = getAudioElement();
    if (a) a.playbackRate = speed;
    update({ playbackRate: speed });
  }, [speed]);

  // EQ：本地编辑实时应用到处理图，并订阅跨组件同步
  useEffect(() => { setEqGains(eqGains); }, [eqGains]);
  useEffect(() => subscribeEq(() => setEqGainsLocal(getEqGains())), []);

  // v2.4.9 #5.7：睡眠定时器逻辑已迁移至 AudioHost（常驻 <audio> 宿主，见 AudioHost.tsx）。
  // 原因：此前定时器挂在 FullScreenPlayer，退出播放页 / 进入横屏会卸载本组件，
  // 导致 clearTimeout 把定时清掉，出现「设了 30 分钟却提前停/根本不停」。
  // 迁移后定时与播放页生命周期解耦，常驻生效。下方 sleepMode / applySleep 仅驱动 UI 展示。

  // v2.4.0 H1：横屏进入即启动 3 秒计时；超时淡出 chrome，只剩当前行歌词
  useEffect(() => {
    clearTimeout(landTimer.current);
    if (!showLandscape) {
      // 退出横屏：恢复竖屏系统栏主题色，清掉横屏的透明深底设置
      // v2.5.2 #3：先解除冻结（内部立即补推主题色），否则退出横屏后系统栏
      // 会一直停在横屏的透明状态，回竖屏就成了「系统栏透出窗口底色」。
      holdNavBarPush(false);
      setLandHidden(false);
      setStatusBarVisible(true);
      syncNavBarNow();
      return;
    }
    // v2.5.1 #5：进入横屏即让两条系统栏透明、播放器深底渐变透出
    // （通知栏/手势栏 = 播放器背景色）；并隐藏整条状态栏（点屏幕显控件时再显示）。
    // v2.5.2 #3：冻结 navBar 的主题色染色 —— 横屏旋转 / 控件显隐都会触发 resize，
    // safeArea.ts 改写 --sat/--sab 会唤醒 MutationObserver → push() 把两根条
    // 染成 --bg 白色，把这里刚设好的透明顶掉（v2.5.1 白条没修好的根因）。
    holdNavBarPush(true);
    setLandscapeBars();
    setStatusBarVisible(false);
    landTimer.current = window.setTimeout(() => setLandHidden(true), 3000);
    return () => {
      clearTimeout(landTimer.current);
      // 兜底：若组件在横屏态被直接卸载（例如旋转窗口期父层换掉了播放页），
      // 这里必须解除冻结，否则系统栏会一直停在横屏的透明状态。
      holdNavBarPush(false);
    };
  }, [showLandscape]);

  // v2.4.2 #E：横屏真旋转 —— 对齐幕海 VideoPlayer.tsx:332。
  // showLandscape 变了就同步系统方向；退出（变 false）自动回竖屏（silent 不弹提示）。
  //
  // v2.4.10 #13：**方向指令的唯一入口**。
  //
  // 旧实现在这里和 MORE_ITEMS 的「横屏播放」按钮里**各发了一遍** requestOrientation。
  // orientation.ts 每次调用都 `++verifyGen` 作废前一条校验链 ——
  // 两遍调用导致第一遍的校验链被自己人干掉，只剩第二遍在跑；
  // 而第二遍是从按钮点击那一刻起算，等桥 + 校验的窗口叠在一起，表现就是「转不过去」。
  //
  // 现在按钮只负责 setShowLandscape(true)，方向指令统一由本 effect 发。
  // 失败时 onResult(false) 会 setShowLandscape(false) 回退，不会卡在"转了但没进横屏 UI"。
  //
  // ⚠️ 输入锁只在「进入横屏」时加。
  //   本 effect 在 showLandscape=false 时同样会跑（含组件首次挂载）——
  //   那时发的是静默的 portrait 归位，不该锁住任何东西，
  //   否则「每次打开播放页，前 3 秒点什么都没反应」。
  // v2.5.2 #12：新增 landPending —— 「已发出横屏指令、但还没转成功」的中间态。
  // 这段时间只铺 .ori-lock 深色遮罩（吃点击 + 挡住一切中间态），不渲染 .fs-land，
  // 从而彻底消灭「点横屏先闪一个别的页面」。
  const [landPending, setLandPending] = useState(false);

  useEffect(() => {
    // 既不在横屏、也没有待转请求 → 静默归位竖屏，不锁输入
    if (!showLandscape && !landPending) {
      requestOrientation('portrait', { silent: true });
      setOriLocked(false);
      return;
    }
    // 已经在横屏里了 → 指令早就发过，这里不要再发（重复发会让 verifyGen 互相作废）
    if (showLandscape) return;

    // pending：发横屏指令 + 锁输入，等结果
    setOriLocked(true);
    let done = false;
    const unlock = () => { if (!done) { done = true; setOriLocked(false); } };
    requestOrientation('landscape', {
      toast: toast.push,
      onResult: (ok) => {
        unlock();
        setLandPending(false);
        if (ok) {
          setShowLandscape(true); // 转成功了才渲染横屏 UI（视口此时已是横屏）
        } else {
          setShowLandscape(false);
        }
      },
    });
    // 兜底解锁：桥不可用 / onResult 不回调时，4s 后强制解锁，避免界面卡死
    const t = window.setTimeout(unlock, 4000);
    return () => { clearTimeout(t); unlock(); };
  }, [showLandscape, landPending, toast]);

  // v2.4.2 #E：卸载归位 —— 退出播放页时强制回竖屏，避免遗留横屏状态把主页也带横了。
  //
  // v2.4.10 #13：只在「真的还处于横屏态」时补发。
  //   正常退出路径（点返回 / 按系统返回）会先 setShowLandscape(false)，
  //   那次归位由 [showLandscape] effect 负责（它会发 portrait 并清 .landscape-on）。
  //   走到这里说明组件是在横屏仍未归位的情况下被卸载的（例如旋转窗口期里
  //   父层把播放页换掉了）—— 这种"被动卸载"才需要补一枪 portrait，
  //   否则会留下竖屏 App 顶着横屏标记的状态。
  //   判据用 body 上的 .landscape-on 而不是内部标志位：它就是最终生效的那个状态。
  useEffect(() => {
    return () => {
      if (document.body.classList.contains('landscape-on')) {
        requestOrientation('portrait', { silent: true });
      }
    };
  }, []);

  // 横屏点击：在「显示 / 隐藏」间切换，并重置 3 秒计时
  const toggleLand = () => {
    setLandHidden((h) => {
      const nh = !h;
      clearTimeout(landTimer.current);
      if (!nh) landTimer.current = window.setTimeout(() => setLandHidden(true), 3000);
      // v2.5.1 #5：无论控件显隐，系统栏都保持透明深底（= 播放器背景色）。
      // 控件显示(nh=false) → 状态栏显示(但透明深底)；控件隐藏(nh=true) → 状态栏整体隐藏。
      setLandscapeBars();
      setStatusBarVisible(!nh);
      return nh;
    });
  };

  // v2.5.1 #6：播放列表改触摸拖拽。HTML5 draggable/onDrop 在移动端 WebView 根本不触发，
  // 列表一直拖不动。改用手柄 .pl-handle 上的 touch 事件：
  //   start 记起点、move 用 elementFromPoint 找手指下的行、跨行即 live 调 reorderQueue 重排、end 收尾。
  // 触摸事件会被浏览器捕获到 start 时的手柄节点上，所以 move/end 即使手指移出手柄也照常触发。
  const dragFromRef = useRef<number | null>(null);
  const justDraggedRef = useRef(false);
  const onPlHandleTouchStart = (i: number) => (e: TouchEvent) => {
    e.preventDefault();
    dragFromRef.current = i;
    setDragIndex(i);
  };
  const onPlHandleTouchMove = (e: TouchEvent) => {
    if (dragFromRef.current === null) return;
    const t = e.touches[0];
    const el = document.elementFromPoint(t.clientX, t.clientY) as HTMLElement | null;
    const row = el?.closest('.fs-pl-item') as HTMLElement | null;
    if (!row) return;
    const to = Number(row.dataset.idx);
    if (!Number.isNaN(to) && to !== dragFromRef.current) {
      player.reorderQueue(dragFromRef.current, to);
      dragFromRef.current = to;
      setDragIndex(to);
    }
  };
  const onPlHandleTouchEnd = () => {
    if (dragFromRef.current !== null) {
      // 防止拖完松手时手柄所在的整行 onClick 误触发播放
      justDraggedRef.current = true;
      window.setTimeout(() => { justDraggedRef.current = false; }, 400);
    }
    dragFromRef.current = null;
    setDragIndex(null);
  };

  // v2.5.2 #9：播放列表左滑删除。
  // 能力本来就有（playerStore.ts 的 removeFromQueue），缺的是交互入口。
  // 与 v2.5.1 的拖拽排序靠**方向**区分：竖向 = 拖拽（手柄），横向 = 左滑删除（整行）。
  const [swiped, setSwiped] = useState<number | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number; idx: number } | null>(null);
  const justSwipedRef = useRef(false);

  const onPlRowTouchStart = (i: number) => (e: React.TouchEvent) => {
    const t = e.touches[0];
    swipeStartRef.current = { x: t.clientX, y: t.clientY, idx: i };
    justSwipedRef.current = false;
  };
  const onPlRowTouchMove = (e: React.TouchEvent) => {
    const s = swipeStartRef.current;
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    // 竖向位移为主 → 是拖拽/滚动，不干预
    if (Math.abs(dx) <= Math.abs(dy)) return;
    if (dx < -40) {
      justSwipedRef.current = true;
      setSwiped(s.idx);
    } else if (dx > 24) {
      setSwiped(null);
    }
  };
  const onPlRowTouchEnd = () => { swipeStartRef.current = null; };

  // v2.4.5 #1：循环模式三态循环 + 明确反馈。
  // 旧实现只调 setMode 却不提示，而底部按钮三态共用一个 repeat 图标 —— 点了不知道切没切。
  // 现在：切换 → toast 文案 + 非「列表循环」时按钮染主题色（.pv-btn.mode.on）。
  const cycleMode = () => {
    const next = state.mode === 'list' ? 'one' : state.mode === 'one' ? 'shuffle' : 'list';
    player.setMode(next);
    toast.push(`已切换：${MODE_LABEL[next] ?? next}`);
  };

  // 更多菜单：圆形图标网格（4 列，54px 圆），对齐设计稿三点面板
  const MORE_ITEMS: { key: string; icon: any; label: string; onClick: () => void }[] = [
    // v2.4.6 #11：显式清空 addTarget —— 保证 ⋮ 菜单入口永远是「作用于当前播放歌曲」，
    // 不会残留上一次行尾 ＋ 指定的那首（否则菜单会加错歌）。
    { key: 'add', icon: 'plus', label: '加歌单', onClick: () => { setAddTarget(null); setMenuView('add'); } },
    { key: 'speed', icon: 'gauge', label: '倍速播放', onClick: () => setMenuView('speed') },
    { key: 'artist', icon: 'user', label: '查看作者', onClick: () => { setShowMenu(false); setShowAuthor(true); } },
    { key: 'timer', icon: 'clock', label: '定时关闭', onClick: () => setMenuView('timer') },
    {
      key: 'order', icon: 'list', label: '顺序播放',
      onClick: () => { player.setMode('list'); toast.push('已切换：列表循环'); setShowMenu(false); },
    },
    { key: 'less', icon: 'x-circle', label: '少推荐', onClick: () => { toast.push('已减少此类推荐'); setShowMenu(false); } },
    // v2.4.0 H1（方案 C）：删除「整屏歌词」菜单项，歌词统一由「点封面」全屏进入
    //
    // v2.4.10 #13：这里只置状态，**不再自己发方向指令**。
    //   方向指令的唯一出口是上方那个 [showLandscape] effect —— 两处都发会让
    //   orientation.ts 的 verifyGen 互相作废，旋转校验链永远跑不完（"要点两下"）。
    { key: 'land', icon: 'maximize', label: '横屏播放',
      onClick: () => {
        setShowMenu(false);
        // v2.5.2 #12：不再直接 setShowLandscape(true)。
        //   旧实现一点就立刻渲染 .fs-land，而物理旋转是异步的（等桥 + 每 400ms
        //   校验、最长 6s）—— 这几百毫秒里视口还是竖屏，横屏布局被塞进竖屏视口
        //   渲染成一团错乱画面，用户看到的就是「先闪一下别的页面」。
        //   现在先置 pending：转成功（onResult(true)）才真正渲染横屏页。
        setLandPending(true);
      } },
  ];

  // 进度百分比（粉红填充轨道 + 白色滑块）
  //
  // v2.4.10 #5：加 Number.isFinite 守卫 + 「非空态保留滑块」。
  //   旧实现 `state.duration > 0 ? ... : 0`。duration 一旦是 NaN（连续 seek 触发
  //   <audio> 重载、loadedmetadata 重发 NaN），`NaN > 0` 恒为 false → pct 恒 0
  //   → 滑块 left:0% 被推到最左（视觉上「滑块没了」）、时间显示 0:00。
  //   store 侧已在 setDuration/setProgress 过滤 NaN（治本），这里再守一道（兜底）。
  const durationOk = Number.isFinite(state.duration) && state.duration > 0;
  const progressOk = Number.isFinite(state.progress) && state.progress >= 0;
  const pct = durationOk && progressOk ? Math.min(100, (state.progress / state.duration) * 100) : 0;

  // 进度条：点击 / 拖动 seek
  const barRef = useRef<HTMLDivElement>(null);
  const ldBarRef = useRef<HTMLDivElement>(null); // 竖屏歌词页独立进度条
  // v2.4.10 #10：横屏进度条独立 ref（此前横屏那条压根没有 ref，所以点不动）
  const landBarRef = useRef<HTMLDivElement>(null);
  //
  // v2.4.10 #5：两条进度条的拖动标志必须**各用各的**。
  //   旧实现 `const dragging = useRef(false)` 被播放页 barRef 与歌词页 ldBarRef 共用。
  //   从歌词页返回播放页时，ldBarRef 的 onPointerUp 在元素已被卸载的情况下不触发，
  //   dragging 就永久卡在 true —— 此后播放页的 onPointerMove 只要动一下手指
  //   就持续 seekAt，把 <audio>.currentTime 反复写。连续 seek 触发元素内部重载 →
  //   loadedmetadata 重发 NaN → duration 变 NaN → 滑块与时间全废（即「返回后进度条变了」）。
  const dragBar = useRef(false);
  const dragLdBar = useRef(false);
  const dragLandBar = useRef(false);

  // v2.4.10 #5：seek 节流 —— 拖动时 pointermove 触发频率远高于 <audio> 能承受的
  // 重定位频率，100ms 一次既跟手又不会把元素拖垮。
  const lastSeekAt = useRef(0);
  const seekAt = (
    clientX: number,
    ref: React.RefObject<HTMLDivElement> = barRef,
    opts: { force?: boolean } = {},
  ) => {
    const el = ref.current;
    // 用元素自身的 rect 判断可用性，不再依赖 state.duration（NaN 时会被守卫挡掉，
    // 但拖动中 duration 恰好瞬时为 NaN 不该让整条进度条失灵）。
    if (!el) return;
    const now = Date.now();
    if (!opts.force && now - lastSeekAt.current < 100) return;
    lastSeekAt.current = now;
    const dur = Number.isFinite(state.duration) && state.duration > 0 ? state.duration : 0;
    if (!dur) return;
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    player.seek(p * dur);
  };

  // v2.4.10 #5：卸载时清空所有拖动标志。
  // 本组件会随 tab 切换卸载（MusicApp.tsx:317 `tab === 'player' && <FullScreenPlayer/>`），
  // 卸载瞬间 pointerup 不会到达，标志会残留到下一次挂载 —— 表现就是「返回后进度条不会走」。
  useEffect(() => () => {
    dragBar.current = false;
    dragLdBar.current = false;
    dragLandBar.current = false;
  }, []);

  // v2.5.2 #10：作者主页的数据逻辑与页面已抽到 src/music/ArtistPage.tsx，
  // 供「播放器页 ⋮ → 查看作者」与「搜索页 ⋮ → 查看歌手」两个入口共用，
  // 这里不再自己维护 artistTracks / artistLoading / 分页状态。

  return (
    // v2.4.1 #D：外层改用 Fragment，让「3 点菜单」能挂在 .pv-root 之外。
    // 原因：.pv-root 是 z-index:60 的层叠上下文，而底部导航 .bottom-nav 是 z-index:70
    // 且位于 .pv-root 之外 —— 父容器整体在 Tab 之下，内部子元素无论 z-index 多大
    // 都会被 Tab 盖住（3 点菜单贴底弹出，最后几行正好落在 Tab 区域，被切掉一半）。
    // 另：菜单提到 .pv-root 同级，可避开 .pv-player 内部层叠上下文对子元素
    // position:fixed 的约束，确保浮层能稳定浮在底部导航 .bottom-nav(z-index:70) 之上。
    <>
      {/* v2.3.11 #1：根节点由 .fs-player 改为 .pv-root。
          播放页在 MusicApp 里已移出 <main>，不再继承 .main 的移动端三边内边距，
          这里上下各自处理安全区、左右到边，真正「占满屏幕」（旧实现被 .main 的内边距夹住，四周留白）。 */}
      <div
        className="pv-root"
      onTouchStart={(e) => {
        // v2.4.10 #4：滑动区 / 控件区内的触摸不参与「上下滑切歌」判定。
        // 旧实现无条件记录起点，于是「上滑歌词」会被 .pv-root 的 onTouchEnd 当成
        // 切歌手势 → player.next()。单曲队列下 next() 切到自己（v2.4.10 已在 store
        // 里堵死），但歌词滚动本身也会被这次误判打断，表现为「滑两下歌词没了」。
        const t = e.target as HTMLElement | null;
        if (t?.closest?.('.ld-scroll,.pv-bar,.pv-btns,.fs-pl-list,.fs-author-tracks,.fs-land-lyric,.fs-land-bar,.fs-land-ctrls')) {
          swipeStart.current = null;
          return;
        }
        swipeStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }}
      onTouchEnd={(e) => {
        if (!swipeStart.current) return;
        const t = e.target as HTMLElement | null;
        const dy = e.changedTouches[0].clientY - swipeStart.current.y;
        const dx = e.changedTouches[0].clientX - swipeStart.current.x;
        swipeStart.current = null;
        // 同一个排除名单要在结束时再判一次：起点可能在空白处，但手指抬起时
        // 已经滑进了歌词区（target 是抬起位置下的元素）。
        if (t?.closest?.('.ld-scroll,.pv-bar,.pv-btns,.fs-pl-list,.fs-author-tracks,.fs-land-lyric,.fs-land-bar,.fs-land-ctrls')) return;
        // 上下滑切歌（仅在纵向位移明显时）
        if (Math.abs(dy) > 50 && Math.abs(dy) > Math.abs(dx)) {
          if (dy < 0) player.next();
          else player.prev();
        }
      }}
    >
      {/* ===== 主界面：1:1 对齐设计稿 ⑤「未在播放」/ ⑥「播放中」===== */}
      <div className="pv-player">
        {/* 顶栏：汉堡 22px | 正 在 播 放 12px/字距2 | 竖三点 22px */}
        {/* v2.4.9 #5.3：歌名 / 歌手上移到顶端「正在播放」位置，字号加大。
            旧布局把歌名放在封面下方，视线要在「封面 → 下方文字 → 底部控件」之间
            来回跳，且小屏上封面一大就把文字挤到很低（用户反馈"位置偏低"）。
            现在顶栏中段直接承载曲名（17px 加粗）+ 歌手/专辑（12px），
            封面下方不再重复显示，封面因此可以吃掉腾出来的高度（#5.2）。 */}
        <div className="pv-top">
          <button className="pv-mi" onClick={() => setShowPlaylist(true)} title="播放列表" aria-label="播放列表">{IC.menu}</button>
          <div className="pv-now">
            {/* v2.4.10 #3：非空态去掉「正在播放」四个字。
                那一行本来是设计稿里的冗余标注 —— 用户已经在播放页里，不需要再被告知
                「正在播放」；占掉顶栏一行高度，还把歌名挤到第二行。
                空态保留「未在播放」（这里确实是唯一能让用户知道"没歌"的地方）。
                标题 / 副行字号同步上调，把腾出来的空间吃掉（见 styles.css）。 */}
            {empty ? (
              <span className="pv-ttl">未在播放</span>
            ) : (
              <>
                {/* v2.5.1 #3：顶部并单行「歌名 — 歌手」，去掉与封面下方重复的专辑。
                    旧实现分两行（歌名 + 歌手·专辑）把第一行挤到顶、占竖向空间。 */}
                <span className="pv-now-title">
                  {it.title || '未知歌曲'}{it.artist ? ` — ${it.artist}` : ''}
                </span>
              </>
            )}
          </div>
          <button className="pv-mi" onClick={() => { setMenuView('main'); setShowMenu(true); }} title="更多" aria-label="更多">{IC.more}</button>
        </div>

        {/* 封面位：200×200 r20，点击在「封面 / 歌词」间切换（设计稿 .cover / .lyrics 同尺寸同位） */}
        {/* 封面位：.pv-art-slot 撑走「顶栏之下、标题之上」的剩余高度并纵向居中，
            尺寸由 CSS 的 min(78vw, 330px) 决定（v2.4.6 #4）。 */}
        <div className="pv-art-slot">
        {coverLyric ? (
          <div className="pv-lyrics" onClick={() => setCoverLyric(false)}>
            {lyricLines.length ? (
              <>
                {aLine > 0 && <span>{lyricLines[aLine - 1]?.text || '·'}</span>}
                <span className="now">{lyricLines[aLine]?.text || '·'}</span>
                {aLine + 1 < lyricLines.length && <span>{lyricLines[aLine + 1]?.text || '·'}</span>}
              </>
            ) : (
              <span className="now">暂无歌词</span>
            )}
          </div>
        ) : (
          <div
            className={'pv-cover' + (empty ? ' empty' : '')}
            onClick={() => !empty && setCoverLyric(true)}
            title={empty ? undefined : '查看歌词'}
          >
            {it.cover ? <img src={it.cover} alt="" /> : IC.note}
          </div>
        )}
        </div>

        {/* v2.4.9 #5.3：歌名/歌手已移到顶栏（.pv-now），这里不再重复显示。
            空态仍保留两行占位，避免控制区在「有歌/没歌」之间上下跳动。 */}
        {empty && <div className="pv-title" />}
        {empty && <div className="pv-artist hold">占位</div>}

        {/* 控制区贴底：进度条 4px + 时间 + 五个按钮（顺序/尺寸严格照设计稿） */}
        <div className="pv-ctrls">
          <div
            className="pv-bar"
            ref={barRef}
            onPointerDown={(e) => {
              if (empty || !durationOk) return;
              dragBar.current = true;
              seekAt(e.clientX, barRef, { force: true });
              try { (e.target as any).setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
            }}
            onPointerMove={(e) => { if (dragBar.current) seekAt(e.clientX, barRef); }}
            onPointerUp={() => { dragBar.current = false; }}
            onPointerCancel={() => { dragBar.current = false; }}
            /* v2.4.10 #5：补 onPointerLeave —— 指针移出元素后 pointerup 可能在别处触发，
               漏了这条就会出现「拖着拖着松手了但标志没清」的卡死。 */
            onPointerLeave={() => { dragBar.current = false; }}
          >
            <i className={empty ? 'zero' : ''} style={{ width: `${pct}%` }} />
            <span className={'pv-thumb' + (empty ? ' zero' : '')} style={{ left: `${pct}%` }} />
          </div>
          <div className="pv-times">
            <span>{fmtTime(state.progress)}</span>
            {/* 空态右侧为 -0:00（设计稿原样） */}
            <span>{empty ? '-0:00' : fmtTime(state.duration)}</span>
          </div>
          <div className="pv-btns">
            {empty ? (
              /* 空态：设计稿用 <span> 而非 <button>，明示不可点击；播放键保留粉底作唯一主 CTA */
              <>
                <span className="pv-btn mode disabled">{IC_MODE.list}</span>
                <span className="pv-btn disabled">{IC.prev}</span>
                <span className="pv-btn play disabled">{IC.play}</span>
                <span className="pv-btn disabled">{IC.next}</span>
                <span className="pv-btn like disabled">{IC.like}</span>
              </>
            ) : (
              <>
                <button
                  className={'pv-btn mode' + (state.mode !== 'list' ? ' on' : '')}
                  onClick={cycleMode}
                  title={MODE_LABEL[state.mode] ?? '循环模式'}
                  aria-label={MODE_LABEL[state.mode] ?? '循环模式'}
                >{IC_MODE[state.mode] ?? IC_MODE.list}</button>
                <button className="pv-btn" onClick={() => player.prev()} title="上一首" aria-label="上一首">{IC.prev}</button>
                <button className="pv-btn play" onClick={() => player.toggle()} title={state.isPlaying ? '暂停' : '播放'} aria-label={state.isPlaying ? '暂停' : '播放'}>
                  {state.isPlaying ? IC.pause : IC.play}
                </button>
                <button className="pv-btn" onClick={() => player.next()} title="下一首" aria-label="下一首">{IC.next}</button>
                <button className={'pv-btn like' + (fav ? ' on' : '')} onClick={() => library.toggleFavorite(it)} title={fav ? '取消喜欢' : '喜欢'} aria-label={fav ? '取消喜欢' : '喜欢'}>
                  {IC.like}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* v2.4.0 H1（方案 C）：点封面 → 全屏滚动歌词页（竖屏）。
          顶栏：左 返回箭头 / 中 歌名歌手 / 右 空；中部所有歌词行居中；
          底部为与播放页完全一致的进度条 + 5 控制按钮。 */}
      {coverLyric && (
        <div className="ld-page">
          <div className="ld-top">
            <button className="ld-back" onClick={() => setCoverLyric(false)} aria-label="返回">
              <Icon name="arrow-left" size={30} />
            </button>
            <div className="ld-head">
              <div className="ld-title">{it.title || '未在播放'}</div>
              <div className="ld-sub">{[it.artist, it.album ? `《${it.album}》` : ''].filter(Boolean).join(' · ') || '未知艺术家'}</div>
            </div>
          </div>

          {/* v2.4.9 #3.2/#4.7：歌词自动跟随当前行。
              竖屏歌词页与横屏 3 行歌词区共用同一套逻辑 —— 当前行变化时把它滚到
              容器中间。只在用户没有手动拖动滚动条时跟随（1.5s 内手动滑过就先不抢），
              否则会出现「你刚滑到上面看两句，它又给你拽回去」。 */}
          <div className="ld-scroll" ref={ldScrollRef} onTouchStart={onLyricTouch} onWheel={onLyricWheel}>
            {lyricLines.length ? (
              lyricLines.map((l, i) => (
                <p key={i} className={'ld-line' + (i === aLine ? ' active' : '') + (i < aLine ? ' past' : '')}>{l.text || '·'}</p>
              ))
            ) : (
              <p className="ld-empty">暂无歌词 / 该音源未提供歌词</p>
            )}
          </div>

          <div className="pv-ctrls">
            <div className="pv-bar" ref={ldBarRef}
              onPointerDown={(e) => { if (empty || !durationOk) return; dragLdBar.current = true; seekAt(e.clientX, ldBarRef, { force: true }); try { (e.target as any).setPointerCapture?.(e.pointerId); } catch { /* ignore */ } }}
              onPointerMove={(e) => { if (dragLdBar.current) seekAt(e.clientX, ldBarRef); }}
              onPointerUp={() => { dragLdBar.current = false; }}
              onPointerCancel={() => { dragLdBar.current = false; }}
              onPointerLeave={() => { dragLdBar.current = false; }}
            >
              <i className={empty ? 'zero' : ''} style={{ width: `${pct}%` }} />
              <span className={'pv-thumb' + (empty ? ' zero' : '')} style={{ left: `${pct}%` }} />
            </div>
            <div className="pv-times">
              <span>{fmtTime(state.progress)}</span>
              <span>{empty ? '-0:00' : fmtTime(state.duration)}</span>
            </div>
            <div className="pv-btns">
              {empty ? (
                <>
                  <span className="pv-btn mode disabled">{IC_MODE.list}</span>
                  <span className="pv-btn disabled">{IC.prev}</span>
                  <span className="pv-btn play disabled">{IC.play}</span>
                  <span className="pv-btn disabled">{IC.next}</span>
                  <span className="pv-btn like disabled">{IC.like}</span>
                </>
              ) : (
                <>
                  <button className={'pv-btn mode' + (state.mode !== 'list' ? ' on' : '')} onClick={cycleMode} title={MODE_LABEL[state.mode] ?? '循环模式'}>{IC_MODE[state.mode] ?? IC_MODE.list}</button>
                  <button className="pv-btn" onClick={() => player.prev()} title="上一首">{IC.prev}</button>
                  <button className="pv-btn play" onClick={() => player.toggle()} title={state.isPlaying ? '暂停' : '播放'}>{state.isPlaying ? IC.pause : IC.play}</button>
                  <button className="pv-btn" onClick={() => player.next()} title="下一首">{IC.next}</button>
                  <button className={'pv-btn like' + (fav ? ' on' : '')} onClick={() => library.toggleFavorite(it)} title={fav ? '取消喜欢' : '喜欢'}>{IC.like}</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 均衡器面板（仍可从设置页进入，此处保留独立入口的轻量调用） */}
      {showEq && (
        <div className="fs-panel">
          <div className="fs-panel-head">均衡器
            <button className="link" onClick={() => { setEqPreset('关闭'); setEqGainsLocal([...EQ_PRESETS[0].gains]); }}>重置</button>
          </div>
          <div className="eq-presets">
            {EQ_PRESETS.map((p) => (
              <button key={p.name} className={'mini' + (eqPreset === p.name ? ' active' : '')}
                onClick={() => { setEqPreset(p.name); setEqGainsLocal([...p.gains]); }}>{p.name}</button>
            ))}
          </div>
          <div className="eq-sliders">
            {EQ_BANDS.map((f, i) => (
              <div key={i} className="eq-band">
                <input type="range" min={-12} max={12} step={1} value={eqGains[i]}
                  onChange={(e) => { setEqPreset('自定义'); const g = [...eqGains]; g[i] = Number(e.target.value); setEqGainsLocal(g); }} />
                <span className="eq-label">{f >= 1000 ? f / 1000 + 'k' : f}</span>
                <span className="eq-val">{eqGains[i] > 0 ? '+' : ''}{eqGains[i]}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {showPlaylist && (
        <div className="fs-playlist">
          <div className="fs-pl-head">
            <button className="icon" onClick={() => setShowPlaylist(false)} aria-label="返回"><Icon name="arrow-left" size={30} /></button>
            <span className="pl-title">播放列表</span>
            {/* v2.4.5 #1：与底部按钮走同一个 cycleMode（带 toast），不再各写一套 */}
            <button className="pl-mode" onClick={cycleMode} title={MODE_LABEL[state.mode] ?? '循环模式'}>
              <Icon name={MODE_ICON[state.mode]?.icon ?? 'repeat'} size={15} /> {MODE_LABEL[state.mode] ?? '列表循环'}
            </button>
          </div>
          <div className="fs-pl-list">
            {state.queue.map((q, i) => (
              <div
                key={i}
                data-idx={i}
                className={'fs-pl-item' + (i === state.index ? ' active' : '') + (dragIndex === i ? ' dragging' : '') + (swiped === i ? ' swiped' : '')}
                onClick={() => {
                  // v2.5.2 #9：刚左滑过 → 这一次抬手的 click 不算点击播放
                  if (justSwipedRef.current) { justSwipedRef.current = false; return; }
                  if (justDraggedRef.current) { justDraggedRef.current = false; return; }
                  // 有行处于展开态时，点任意行先收起，不误播
                  if (swiped !== null) { setSwiped(null); return; }
                  player.playAt(i);
                }}
                onTouchStart={onPlRowTouchStart(i)}
                onTouchMove={onPlRowTouchMove}
                onTouchEnd={onPlRowTouchEnd}
                onTouchCancel={onPlRowTouchEnd}
              >
                <span className="pl-idx">{i === state.index ? <Icon name="play" size={13} /> : i + 1}</span>
                <div className="pl-meta">
                  <div className="pl-name">{q.title}</div>
                  <div className="pl-sub">{[q.artist, q.album].filter(Boolean).join(' · ') || '未知艺术家'}</div>
                </div>
                <button className={'mini' + (library.isFavorite(q) ? ' fav' : '')} title="收藏" onClick={(e) => { e.stopPropagation(); library.toggleFavorite(q); }}>
                  <Icon name={library.isFavorite(q) ? 'heart-filled' : 'heart'} size={15} />
                </button>
                {/* v2.4.6 #11：「加歌单」按钮 —— 新增，位于拖拽手柄**左侧**。
                    点击后打开与 ⋮ 菜单同一个「添加到歌单」浮层，只是目标换成这一行。
                    拖拽手柄（右侧 ⋮⋮）原样保留，两者互不影响。 */}
                <button
                  className="mini pl-add"
                  title="添加到歌单"
                  aria-label="添加到歌单"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAddTarget(q);
                    setMenuView('add');
                    setShowMenu(true);
                  }}
                >
                  <Icon name="plus" size={16} />
                </button>
                {/* v2.5.1 #6：拖拽手柄改用 touch 事件（见 onPlHandleTouch*），HTML5 DnD 移动端不触发 */}
                <span
                  className="pl-handle"
                  title="拖拽排序"
                  onTouchStart={onPlHandleTouchStart(i)}
                  onTouchMove={onPlHandleTouchMove}
                  onTouchEnd={onPlHandleTouchEnd}
                ><Icon name="menu" size={16} /></span>
                {/* v2.5.2 #9：左滑露出的删除按钮。平时 translateX(100%) 藏在行右侧之外，
                    行加 .swiped 时整体滑入；点击直接 removeFromQueue，不弹二次确认
                    （删错了可以再搜一次加回来，二次确认在播放场景里太重）。 */}
                <button
                  className="pl-del"
                  title="从播放列表移除"
                  aria-label="从播放列表移除"
                  onClick={(e) => {
                    e.stopPropagation();
                    player.removeFromQueue(i);
                    setSwiped(null);
                  }}
                ><Icon name="trash" size={16} /></button>
              </div>
            ))}
            {state.queue.length === 0 && <div className="muted sm" style={{ padding: 24, textAlign: 'center' }}>播放列表为空，去搜索或点播一首歌吧。</div>}
          </div>
          <div className="fs-pl-foot">共 {state.queue.length} 首 · 可拖拽排序 · 点击播放</div>
        </div>
      )}

      {/* 作者主页（完整页面）—— v2.5.2 #10：改用公共组件 ArtistPage，
          与搜索页「查看歌手」共用同一套页面（头像 / 作品数 / 全曲 / 分页）。 */}
      {showAuthor && (
        <ArtistPage
          artist={it.artist ?? ''}
          sources={sources}
          queue={state.queue}
          onPlay={(list, idx) => {
            setShowAuthor(false);
            // v2.4.10 #16：playQueue 内部已先停旧音频
            player.playQueue(list, idx);
          }}
          onClose={() => setShowAuthor(false)}
        />
      )}

      {/* v2.4.0 H1：横屏播放页 —— 无封面，中部给歌词；顶部中间歌名歌手；
          底部仅进度条（无按钮）；左上角返回（原右上 × 改左上）；
          3 秒无操作淡出 chrome，只剩当前行歌词（独立绝对定位层 .ld-solo）。 */}
      {showLandscape && (
        <div className={'fs-land' + (landHidden ? ' hidden' : '')} onClick={toggleLand}>
          <button
            className="fs-land-back"
            onClick={(e) => { e.stopPropagation(); setShowLandscape(false); }}
            aria-label="退出横屏"
          ><Icon name="arrow-left" size={30} /></button>
          <div className="fs-land-bg">
            <div className="fs-land-orb a" />
            <div className="fs-land-orb b" />
            <div className="fs-land-orb c" />
          </div>
          <div className="fs-land-content">
            <div className="fs-land-head">
              {/* v2.5.2 #5：原来两行（歌名 / 歌手·专辑），改成单行「歌名 — 歌手」。
                  专辑去掉——它本就是冗余信息，两行还把顶部撑高、字号被迫放大。 */}
              <div className="fs-land-title">
                {(it.title || '未在播放') + (it.artist ? ` — ${it.artist}` : '')}
              </div>
            </div>
            <div className="fs-land-lyric" ref={landLyricRef} onTouchStart={onLyricTouch} onWheel={onLyricWheel}>
              {lyricLines.length ? (
                // v2.4.10 #8：只渲染「当前行 ±1」的三行，其余加 .ld-dim（CSS display:none）。
                //   · 目标行不在布局里 → 无论容器高度怎么算都不会露出第四行；
                //   · 同时这也让「自动跟随」的 delta 计算稳定 —— 布局里最多 3 行，
                //     不存在「元素在视口外导致 rect 异常」的情况。
                //   边界：aLine < 0（还没到第一句）时退化为中心三行，保证画面不空。
                (aLine >= 0
                  ? lyricLines
                      .map((l, i) => ({ l, i }))
                      .filter(({ i }) => Math.abs(i - aLine) <= 1)
                  : lyricLines.slice(0, 3).map((l, i) => ({ l, i }))
                ).map(({ l, i }) => (
                  <p
                    // key 用**原数组下标** i（不是过滤后的序号）：i 是歌词行的稳定身份，
                    // aLine 前进时同一行会一直带着同一个 i，React 能正重复用节点、
                    // 触发的是「文字替换」而不是「重建」，切行过渡才平滑。
                    key={i}
                    className={'ld-line' + (i === aLine ? ' active' : '') + (i < aLine ? ' past' : '') + (aLine >= 0 && Math.abs(i - aLine) > 1 ? ' ld-dim' : '')}
                  >{l.text || '·'}</p>
                ))
              ) : (
                <p className="ld-empty">暂无歌词 / 该音源未提供歌词</p>
              )}
            </div>
            {/* v2.4.7 #4：横屏控制行 —— 上一曲 / 暂停·播放 / 下一曲（此前横屏只有进度条，无按钮） */}
            <div className="fs-land-ctrls" onClick={(e) => e.stopPropagation()}>
              <button className="fs-land-ctrl" onClick={() => player.prev()} title="上一曲" aria-label="上一曲">{IC.prev}</button>
              <button className="fs-land-ctrl play" onClick={() => player.toggle()} title={state.isPlaying ? '暂停' : '播放'} aria-label={state.isPlaying ? '暂停' : '播放'}>
                {state.isPlaying ? IC.pause : IC.play}
              </button>
              <button className="fs-land-ctrl" onClick={() => player.next()} title="下一曲" aria-label="下一曲">{IC.next}</button>
            </div>
            {/* v2.4.10 #10/#11：横屏进度条重做。
                -------------------------------------------------------------------
                #10「滑不动」：旧实现只有 `onClick={(e)=>e.stopPropagation()}` ——
                那只是为了阻止点击冒泡到 .fs-land 的 onClick（切换控制区显隐），
                不是进度条交互。它没有任何 pointer handler，也没有 ref，
                压根不是一条可交互的进度条。现在补齐竖屏同款的四件套 + ref。

                #11「左右没有时间」：.fs-land-times 原本是 .fs-land-bar 的**子元素**，
                而 .fs-land-bar 是 height:4px + overflow:hidden —— 时间行被完全裁掉。
                现在把时间行移到进度条外面（同级），并各自给固定宽度：
                时间行不再参与进度条的裁剪，进度条也不被时间行撑高。 */}
            <div className="fs-land-progress" onClick={(e) => e.stopPropagation()}>
              {/* v2.5.2 #8：时间与进度条同一行（旧实现时间行在进度条下方）。
                  左=当前时间、中=进度条（flex:1 水平居中）、右=总时间。 */}
              <span className="fs-land-cur">{fmtTime(state.progress)}</span>
              <div
                className="fs-land-bar"
                ref={landBarRef}
                onPointerDown={(e) => {
                  if (empty || !durationOk) return;
                  dragLandBar.current = true;
                  seekAt(e.clientX, landBarRef, { force: true });
                  try { (e.target as any).setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
                }}
                onPointerMove={(e) => { if (dragLandBar.current) seekAt(e.clientX, landBarRef); }}
                onPointerUp={() => { dragLandBar.current = false; }}
                onPointerCancel={() => { dragLandBar.current = false; }}
                onPointerLeave={() => { dragLandBar.current = false; }}
              >
                <div className="fs-land-fill" style={{ width: `${pct}%` }} />
                {/* v2.4.10 #10：补滑块 —— 竖屏有 .pv-thumb，横屏旧实现只有一条 fill， 
                    看不出可拖动，也没有「抓手」的视觉反馈。 */}
                <span className={'fs-land-thumb' + (empty ? ' zero' : '')} style={{ left: `${pct}%` }} />
              </div>
              <span className="fs-land-total">{empty ? '-0:00' : fmtTime(state.duration)}</span>
            </div>
          </div>
          {/* 隐藏态独立层：当前行歌词居中放大（避免流式布局位置跑偏，见 11.4①） */}
          {landHidden && aLine >= 0 && (
            <div className="ld-solo">{lyricLines[aLine].text || '·'}</div>
          )}
        </div>
      )}

    </div>

      {/* v2.4.10 #13：旋转窗口期的输入锁。
          旋转校验最长 6s，这期间底部 Tab 仍在（.landscape-on 还没挂）、播放页已渲染，
          用户点一下 Tab 就会让 FullScreenPlayer 整棵卸载 → 退回竖屏 → 掉回主页。
          这层透明遮罩把这段窗口期的点击全部吃掉，旋转完成（或超时）即撤。 */}
      {oriLocked && <div className="ori-lock" aria-hidden="true" />}

      {/* v2.4.1 #D：3 点菜单挂在 .pv-root 之外（Fragment 同级）。
          这样它的层叠上下文不再受 .pv-root(z-index:60) 约束，
          得以浮在底部导航 .bottom-nav(z-index:70) 之上，最后几行不被 Tab 切掉。 */}
      {showMenu && (
        <div className="fs-menu-mask" onClick={() => { setShowMenu(false); setMenuView('main'); }}>
          <div className="fs-sheet" onClick={(e) => e.stopPropagation()}>
            {menuView === 'main' && (
              <>
                <div className="fs-sheet-grip" />
                <div className="fs-grid">
                  {MORE_ITEMS.map((m) => (
                    <button key={m.key} className="fs-grid-item" onClick={m.onClick}>
                      <span className="fs-grid-circle"><Icon name={m.icon} size={26} /></span>
                      <span className="fs-grid-label">{m.label}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {menuView === 'add' && (
              <>
                <div className="fs-sheet-head">
                  <button className="icon" onClick={() => { setMenuView('main'); setAddTarget(null); }} aria-label="返回"><Icon name="arrow-left" /></button>
                  <span className="sh-title">添加到歌单</span>
                  {addTarget && <span className="sh-sub" title={addTarget.title}>{addTarget.title}</span>}
                </div>
                <div className="fs-plpick">
                  <div className="fs-plpick-create" onClick={() => { void newPlaylist(); }}>
                    <span className="pc-ico"><Icon name="plus" size={18} /></span>
                    <span>创建新歌单</span>
                  </div>
                  {library.lib.playlists.map((p) => {
                    const added = addItem
                      ? p.items.some((x) => x.sourceId === addItem.sourceId && x.id === addItem.id)
                      : false;
                    return (
                      <div
                        key={p.id}
                        className={'fs-plpick-item' + (added ? ' added' : '')}
                        onClick={() => {
                          if (!addItem) return;
                          library.addToPlaylist(p.id, addItem);
                          // v2.4.6 #11：给明确反馈，且**不关浮层** —— 允许连续加进多个歌单
                          toast.push(added ? `「${p.name}」中已有这首歌` : `已加入「${p.name}」`);
                        }}
                      >
                        <span className="pi-cover" />
                        <span className="pi-name">{p.name}</span>
                        <span className="pi-count">{p.items.length} 首</span>
                        <span className="pi-check"><Icon name="check" size={14} /></span>
                      </div>
                    );
                  })}
                  {library.lib.playlists.length === 0 && <div className="muted sm" style={{ padding: 12 }}>还没有歌单，点上方创建。</div>}
                </div>
              </>
            )}

            {menuView === 'speed' && (
              <>
                <div className="fs-sheet-head">
                  <button className="icon" onClick={() => setMenuView('main')} aria-label="返回"><Icon name="arrow-left" /></button>
                  <span className="sh-title">倍速播放</span>
                </div>
                <div className="fs-speed-val">{speed === 1 ? '原速' : speed + 'x'}</div>
                <input className="fs-slider" type="range" min={0} max={SPEEDS.length - 1} step={1} value={SPEEDS.indexOf(speed)} onChange={(e) => setSpeed(SPEEDS[Number(e.target.value)])} />
                <div className="fs-speed-ticks">{SPEEDS.map((s) => <span key={s}>{s === 1 ? '原速' : s + 'x'}</span>)}</div>
                <div className="fs-pill-row">{SPEEDS.map((s) => <button key={s} className={'fs-pill' + (speed === s ? ' active' : '')} onClick={() => setSpeed(s)}>{s === 1 ? '原速' : s + 'x'}</button>)}</div>
              </>
            )}

            {menuView === 'timer' && (
              <>
                <div className="fs-sheet-head">
                  <button className="icon" onClick={() => setMenuView('main')} aria-label="返回"><Icon name="arrow-left" /></button>
                  <span className="sh-title">定时关闭</span>
                </div>
                <div className="fs-pill-row">
                  {([['off', '关闭'], ['15', '15 分'], ['30', '30 分'], ['60', '60 分'], ['end', '播完本曲']] as [SleepMode, string][]).map(([m, label]) => (
                    <button key={m} className={'fs-pill' + (sleepMode === m ? ' active' : '')} onClick={() => applySleep(m)}>{label}</button>
                  ))}
                </div>
                <label className="fs-radio-row" style={{ marginTop: 14 }}>
                  <input type="checkbox" checked={sleepMode === 'end'} onChange={(e) => applySleep(e.target.checked ? 'end' : 'off')} />
                  播完整首歌后停止
                </label>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
