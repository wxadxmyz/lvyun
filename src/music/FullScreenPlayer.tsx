import { useEffect, useRef, useState } from 'react';
import { usePlayer, fmtTime, player, getAudioElement } from '../lib/playerStore';
import { getEqGains, setEqGains, subscribeEq, EQ_PRESETS, EQ_BANDS } from '../lib/spectrum';
import { useSettings } from '../lib/settings';
import type { useLibrary } from '../lib/library';
import { SourceConfig, MediaItem } from '../engine/types';
// v2.4.5 #5：作者页改为真实搜索（此前只在播放队列里筛，所以只有播放过的歌）
import { aggregateSearch } from '../engine';
import { gradientFor } from '../lib/cover';
import { Icon } from '../components/Icon';
// v2.4.6 #7：命令式中文输入弹窗（替代 window.prompt —— Android WebView 的原生
// JsPromptDialog 按钮文案是内置英文 CANCEL/OK，前端无法控制）
import { promptText } from '../components/PromptDialog';
import { useToast } from '../lib/toast';
// v2.3.11 #4：返回键栈式调度
import { pushBackHandler } from '../lib/backStack';
// v2.4.2 #E：横屏真旋转（等桥 / 校验 / 代际 token / 失败不切 UI）
import { requestOrientation } from '../lib/orientation';

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
  useEffect(() => {
    document.body.classList.toggle('landscape-on', showLandscape);
    return () => document.body.classList.remove('landscape-on');
  }, [showLandscape]);

  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const sleepTimer = useRef<number | undefined>(undefined);

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
  const lyricLines: { time: number; text: string }[] = Array.isArray(it.lyric)
    ? it.lyric.map((l: any) => ({ time: l.time, text: l.text }))
    : Array.isArray(it.raw?.lyric)
    ? (it.raw.lyric as string[]).map((t: string) => ({ time: 0, text: t }))
    : [];
  const aLine = lyricLines.length ? activeIndex(lyricLines, state.progress) : -1;

  // 倍速：同步到 <audio> 并记忆
  useEffect(() => {
    const a = getAudioElement();
    if (a) a.playbackRate = speed;
    update({ playbackRate: speed });
  }, [speed]);

  // EQ：本地编辑实时应用到处理图，并订阅跨组件同步
  useEffect(() => { setEqGains(eqGains); }, [eqGains]);
  useEffect(() => subscribeEq(() => setEqGainsLocal(getEqGains())), []);

  // 睡眠定时器：到点淡出后暂停
  const fadeOutAndPause = () => {
    const a = getAudioElement();
    if (!a) { player.toggle(); return; }
    const target = a.volume;
    const start = performance.now();
    const step = () => {
      const t = (performance.now() - start) / 3000;
      if (t >= 1) { a.volume = target; player.toggle(); applySleep('off'); return; }
      a.volume = target * (1 - t);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  useEffect(() => {
    clearTimeout(sleepTimer.current);
    if (sleepMode === 'off' || sleepMode === 'end') return;
    sleepTimer.current = window.setTimeout(fadeOutAndPause, Number(sleepMode) * 60000);
    return () => clearTimeout(sleepTimer.current);
  }, [sleepMode]);
  useEffect(() => {
    if (sleepMode === 'end' && state.duration > 0 && state.progress >= state.duration - 1) fadeOutAndPause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sleepMode, state.progress, state.duration]);

  // v2.4.0 H1：横屏进入即启动 3 秒计时；超时淡出 chrome，只剩当前行歌词
  useEffect(() => {
    clearTimeout(landTimer.current);
    if (!showLandscape) { setLandHidden(false); return; }
    landTimer.current = window.setTimeout(() => setLandHidden(true), 3000);
    return () => clearTimeout(landTimer.current);
  }, [showLandscape]);

  // v2.4.2 #E：横屏真旋转 —— 对齐幕海 VideoPlayer.tsx:332。
  // showLandscape 变了就同步系统方向；退出（变 false）自动回竖屏（silent 不弹提示）。
  useEffect(() => {
    requestOrientation(showLandscape ? 'landscape' : 'portrait', {
      silent: !showLandscape,
      toast: toast.push,
    });
  }, [showLandscape, toast]);

  // v2.4.2 #E：卸载归位 —— 退出播放页时强制回竖屏，避免遗留横屏状态把主页也带横了。
  useEffect(() => {
    return () => { requestOrientation('portrait', { silent: true }); };
  }, []);

  // 横屏点击：在「显示 / 隐藏」间切换，并重置 3 秒计时
  const toggleLand = () => {
    setLandHidden((h) => {
      const nh = !h;
      clearTimeout(landTimer.current);
      if (!nh) landTimer.current = window.setTimeout(() => setLandHidden(true), 3000);
      return nh;
    });
  };

  const drop = (to: number) => {
    if (dragIndex !== null && dragIndex !== to) player.reorderQueue(dragIndex, to);
    setDragIndex(null);
  };

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
    // v2.4.2 #E：先请求系统旋转，成功才切横屏 UI —— 转不成功就不进 .fs-land，
    // 彻底消灭「竖屏放大」假横屏（orientation.ts 内部已 toast 失败原因）。
    { key: 'land', icon: 'maximize', label: '横屏播放',
      onClick: () => {
        setShowMenu(false);
        requestOrientation('landscape', {
          toast: toast.push,
          onResult: (ok) => { if (ok) setShowLandscape(true); },
        });
      } },
  ];

  // 进度百分比（粉红填充轨道 + 白色滑块）
  const pct = state.duration > 0 ? Math.min(100, (state.progress / state.duration) * 100) : 0;

  // 进度条：点击 / 拖动 seek
  const barRef = useRef<HTMLDivElement>(null);
  const ldBarRef = useRef<HTMLDivElement>(null); // 竖屏歌词页独立进度条
  const dragging = useRef(false);
  const seekAt = (clientX: number, ref: React.RefObject<HTMLDivElement> = barRef) => {
    const el = ref.current;
    if (!el || !state.duration) return;
    const r = el.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    player.seek(p * state.duration);
  };

  // 作者主页：v2.4.5 #5 改为「真的去音源搜一次」。
  // 旧实现 `state.queue.filter(q => q.artist === it.artist)` 只在当前播放队列里筛，
  // 没播过的歌根本进不了队列 —— 于是作者页永远只剩「播放过的那几首」。
  // 现在：按歌手名聚合搜索已启用音源 → 与队列/历史里的同歌手歌曲合并去重。
  const [artistTracks, setArtistTracks] = useState<MediaItem[]>([]);
  const [artistLoading, setArtistLoading] = useState(false);
  useEffect(() => {
    if (!showAuthor) return;
    const artist = (it.artist ?? '').trim();
    if (!artist) { setArtistTracks([]); return; }
    let alive = true;
    setArtistLoading(true);
    (async () => {
      try {
        const names = sources.filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.name }));
        const r = await aggregateSearch(sources, artist, { mediaType: 'music' });
        if (!alive) return;
        const srcName = (id: string) => names.find((n) => n.id === id)?.name ?? '';
        // 同标题去重（不同源同曲只留一条），队列里的同歌手歌曲排前面
        const fromQueue = state.queue.filter((q) => q.artist === artist);
        const seen = new Set<string>();
        const merged: MediaItem[] = [];
        for (const q of [...fromQueue, ...r.items]) {
          const key = `${q.title}|${q.artist ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push({ ...q, sourceName: q.sourceName || srcName(q.sourceId) } as MediaItem);
        }
        setArtistTracks(merged.slice(0, 50));
      } catch {
        if (alive) setArtistTracks([]);
      } finally {
        if (alive) setArtistLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAuthor, it.artist, sources]);

  return (
    // v2.4.1 #D：外层改用 Fragment，让「3 点菜单」能挂在 .pv-root 之外。
    // 原因：.pv-root 是 z-index:60 的层叠上下文，而底部导航 .bottom-nav 是 z-index:70
    // 且位于 .pv-root 之外 —— 父容器整体在 Tab 之下，内部子元素无论 z-index 多大
    // 都会被 Tab 盖住（3 点菜单贴底弹出，最后几行正好落在 Tab 区域，被切掉一半）。
    // 另：.pv-player 内的 .pv-blur 带 filter:blur(40px)，filter 会创建新的层叠上下文，
    // 使子元素的 position:fixed 失效 —— 所以菜单必须提到 .pv-root 同级才稳。
    <>
      {/* v2.3.11 #1：根节点由 .fs-player 改为 .pv-root。
          播放页在 MusicApp 里已移出 <main>，不再继承 .main 的移动端三边内边距，
          这里上下各自处理安全区、左右到边，真正「占满屏幕」（旧实现被 .main 的内边距夹住，四周留白）。 */}
      <div
        className="pv-root"
      onTouchStart={(e) => { swipeStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
      onTouchEnd={(e) => {
        if (!swipeStart.current) return;
        const dy = e.changedTouches[0].clientY - swipeStart.current.y;
        const dx = e.changedTouches[0].clientX - swipeStart.current.x;
        swipeStart.current = null;
        // 上下滑切歌（仅在纵向位移明显时）
        if (Math.abs(dy) > 50 && Math.abs(dy) > Math.abs(dx)) {
          if (dy < 0) player.next();
          else player.prev();
        }
      }}
    >
      {/* ===== 主界面：1:1 对齐设计稿 ⑤「未在播放」/ ⑥「播放中」===== */}
      <div className="pv-player">
        {/* 封面泛光（设计稿 .blur；有封面时优先用封面色） */}
        <div
          className="pv-blur"
          style={
            it.cover
              ? { backgroundImage: `url(${it.cover})`, backgroundSize: 'cover', backgroundPosition: 'center', opacity: 0.42 }
              : undefined
          }
        />

        {/* 顶栏：汉堡 22px | 正 在 播 放 12px/字距2 | 竖三点 22px */}
        <div className="pv-top">
          <button className="pv-mi" onClick={() => setShowPlaylist(true)} title="播放列表" aria-label="播放列表">{IC.menu}</button>
          {/* v2.4.0 C3：顶栏文案按真实播放状态动态显示 */}
          <span className="pv-ttl">{empty ? '未在播放' : '正在播放'}</span>
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

        {/* v2.4.0 C4：封面下方=歌名/歌手显示位；空态留空（「未在播放」已搬到顶栏），
            .hold 仍撑高度防止控制区跳动 */}
        <div className="pv-title">{empty ? '' : it.title}</div>
        <div className={'pv-artist' + (empty ? ' hold' : '')}>
          {empty ? '' : [it.artist, it.album ? `《${it.album}》` : ''].filter(Boolean).join(' · ') || '未知艺术家'}
        </div>

        {/* 控制区贴底：进度条 4px + 时间 + 五个按钮（顺序/尺寸严格照设计稿） */}
        <div className="pv-ctrls">
          <div
            className="pv-bar"
            ref={barRef}
            onPointerDown={(e) => {
              if (empty || !state.duration) return;
              dragging.current = true;
              seekAt(e.clientX);
              try { (e.target as any).setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
            }}
            onPointerMove={(e) => { if (dragging.current) seekAt(e.clientX); }}
            onPointerUp={() => { dragging.current = false; }}
            onPointerCancel={() => { dragging.current = false; }}
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
              <Icon name="arrow-left" size={26} />
            </button>
            <div className="ld-head">
              <div className="ld-title">{it.title || '未在播放'}</div>
              <div className="ld-sub">{[it.artist, it.album ? `《${it.album}》` : ''].filter(Boolean).join(' · ') || '未知艺术家'}</div>
            </div>
          </div>

          <div className="ld-scroll">
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
              onPointerDown={(e) => { if (empty || !state.duration) return; dragging.current = true; seekAt(e.clientX, ldBarRef); try { (e.target as any).setPointerCapture?.(e.pointerId); } catch { /* ignore */ } }}
              onPointerMove={(e) => { if (dragging.current) seekAt(e.clientX, ldBarRef); }}
              onPointerUp={() => { dragging.current = false; }}
              onPointerCancel={() => { dragging.current = false; }}
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
            <button className="icon" onClick={() => setShowPlaylist(false)} aria-label="返回"><Icon name="arrow-left" size={26} /></button>
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
                className={'fs-pl-item' + (i === state.index ? ' active' : '') + (dragIndex === i ? ' dragging' : '')}
                draggable
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => drop(i)}
                onClick={() => player.playAt(i)}
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
                <span className="pl-handle" title="拖拽排序"><Icon name="menu" size={16} /></span>
              </div>
            ))}
            {state.queue.length === 0 && <div className="muted sm" style={{ padding: 24, textAlign: 'center' }}>当前为单曲播放，没有队列。</div>}
          </div>
          <div className="fs-pl-foot">共 {state.queue.length} 首 · 可拖拽排序 · 点击播放</div>
        </div>
      )}

      {/* 作者主页（完整页面） */}
      {showAuthor && (
        <div className="fs-author">
          <div className="fs-author-head">
            <button className="icon" onClick={() => setShowAuthor(false)} aria-label="返回"><Icon name="arrow-left" /></button>
            <div className="fs-author-ava">{(it.artist ?? '?').slice(0, 1)}</div>
          </div>
          <div className="fs-author-info">
            <div className="fs-author-name">{it.artist ?? '未知艺术家'}</div>
            <div className="fs-author-bio">原创音乐人 · 在律云与你相遇</div>
          </div>
          <div className="fs-author-stats">
            {/* v2.4.5 #5：去掉写死的 `|| 12`（空也显示 12，是假数字），改真实数量 */}
            <div><div className="n">{artistLoading ? '…' : artistTracks.length}</div><div className="t">作品</div></div>
            <div><div className="n">—</div><div className="t">粉丝</div></div>
            <div><div className="n">—</div><div className="t">关注</div></div>
          </div>
          <div className="fs-author-acts">
            <button className="fs-pill primary2" onClick={() => { setShowAuthor(false); player.playAt(state.index); }}>关注</button>
            <button className="fs-pill" onClick={() => toast.push('已发送私信')}>私信</button>
          </div>
          <div className="fs-author-sec">热门作品</div>
          <div className="fs-author-tracks">
            {artistLoading && <div className="muted sm" style={{ padding: 16, textAlign: 'center' }}>正在搜索「{it.artist}」的作品…</div>}
            {!artistLoading && artistTracks.map((q, i) => (
              // v2.4.5 #5：点哪首播哪首（旧实现无论点哪首都播 state.index 那首）
              <div key={i} className="fs-author-track" onClick={() => { setShowAuthor(false); player.playQueue(artistTracks, i); }}>
                <span className="at-idx">{i + 1}</span>
                <span className="at-cover" style={{ background: gradientFor(q.title) }} />
                <span className="at-meta"><span className="at-name">{q.title}</span><span className="at-sub">{[q.artist, q.sourceName].filter(Boolean).join(' · ')}</span></span>
              </div>
            ))}
            {!artistLoading && artistTracks.length === 0 && (
              <div className="muted sm" style={{ padding: 16, textAlign: 'center' }}>
                {it.artist ? `没有搜到「${it.artist}」的作品，可能是该源不支持按作者搜索。` : '当前歌曲没有歌手信息。'}
              </div>
            )}
          </div>
        </div>
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
          ><Icon name="arrow-left" size={24} /></button>
          <div className="fs-land-bg">
            <div className="fs-land-orb a" />
            <div className="fs-land-orb b" />
            <div className="fs-land-orb c" />
          </div>
          <div className="fs-land-content">
            <div className="fs-land-head">
              <div className="fs-land-title">{it.title || '未在播放'}</div>
              <div className="fs-land-sub">{[it.artist, it.album ? `《${it.album}》` : ''].filter(Boolean).join(' · ') || '未知艺术家'}</div>
            </div>
            <div className="fs-land-lyric">
              {lyricLines.length ? (
                lyricLines.map((l, i) => (
                  <p key={i} className={'ld-line' + (i === aLine ? ' active' : '') + (i < aLine ? ' past' : '')}>{l.text || '·'}</p>
                ))
              ) : (
                <p className="ld-empty">暂无歌词 / 该音源未提供歌词</p>
              )}
            </div>
            <div className="fs-land-bar" onClick={(e) => e.stopPropagation()}>
              <div className="fs-land-fill" style={{ width: `${pct}%` }} />
              <div className="fs-land-times"><span>{fmtTime(state.progress)}</span><span>{fmtTime(state.duration)}</span></div>
            </div>
          </div>
          {/* 隐藏态独立层：当前行歌词居中放大（避免流式布局位置跑偏，见 11.4①） */}
          {landHidden && aLine >= 0 && (
            <div className="ld-solo">{lyricLines[aLine].text || '·'}</div>
          )}
        </div>
      )}

    </div>

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
