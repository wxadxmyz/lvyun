/**
 * v2.3.10：把应用背景色同步给 Android 系统导航栏（底部手势条区域）。
 *
 * 背景：APP 走 edge-to-edge 后，系统会在导航栏区域叠一层半透明灰罩，
 * 也就是「底部手势条跟软件背景不是一个颜色」。让导航栏底色 = 主题 --bg，
 * 灰罩就与页面背景同色，视觉上消失。
 *
 * 做法对齐慕海 v3.5.0（src/lib/theme.tsx 的 syncNavBar）：
 * 原生侧由 .github/workflows/android.yml 注入的 MainActivity 提供桥
 * window.LvYunAndroid.setNavBarColor(color, light)。
 * 桥是在 onWindowFocusChanged 里延后绑定的，前端首帧几乎必然还没挂上，
 * 所以这里必须重试，而不是调一次就放弃。
 *
 * 注：Android 15 起系统强制 edge-to-edge 并废弃 navigationBarColor，
 * 部分机型/版本上可能不生效 —— 原生侧已有 #0E0E11 兜底色，不会变成刺眼的灰。
 */

const RETRIES = [0, 300, 1200, 3000, 6000];
const DEFAULT_BG = '#0E0E11';

function readBg(): string {
  try {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    // 只接受 #rgb / #rrggbb，避免把渐变或空值丢给 Color.parseColor 抛异常
    if (bg && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(bg)) return bg;
  } catch {
    /* ignore */
  }
  return DEFAULT_BG;
}

/**
 * v2.5.0 #5：判断背景是不是「浅色」，决定系统栏图标用深还是浅。
 * 浅色背景（如简洁白 #f4f5f9）→ 需要深色图标（lightIcons=true）；
 * 深色背景 → 浅色图标（lightIcons=false）。
 */
function isLightColor(hex: string): boolean {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) {
    const s = /^#([0-9a-fA-F]{3})$/.exec(hex);
    if (!s) return false;
    const r = parseInt(s[1][0] + s[1][0], 16);
    const g = parseInt(s[1][1] + s[1][1], 16);
    const b = parseInt(s[1][2] + s[1][2], 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 170;
  }
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 170;
}

function push(): boolean {
  try {
    const bridge = (window as any).LvYunAndroid;
    if (!bridge) return false;
    const bg = readBg();
    const light = isLightColor(bg); // 浅色背景 → 深色图标
    // v2.4.5 #12：播放页「通知栏 → 手势栏一色」。
    // 优先用一次 setBarsColor 同时设两根条（避免两次 IPC、两帧不同色）。
    // v2.5.0 #5：lightIcons 不再写死 false，而是按背景明暗算 —— 浅色主题下
    //   状态栏/手势栏图标也能看清（旧实现浅色主题下图标是浅色，白底上看不见）。
    if (typeof bridge.setBarsColor === 'function') {
      bridge.setBarsColor(bg, light);
      return true;
    }
    let ok = false;
    if (typeof bridge.setNavBarColor === 'function') { bridge.setNavBarColor(bg, light); ok = true; }
    if (typeof bridge.setStatusBarColor === 'function') { bridge.setStatusBarColor(bg, light); ok = true; }
    return ok;
  } catch {
    return false;
  }
}

let installed = false;

/**
 * v2.4.6 #3：公开的「立即同步一次」——播放页进入 / 退出、切 tab、切皮肤时调用。
 *
 * 为什么光靠 MutationObserver 不够：
 *   ① observer 只监听后续变化，首帧 apply(skin) 可能早于 observer 建立；
 *   ② 观察回调有 200ms 节流，用户从主页点进播放页时底部 Tab 会短暂保持旧色，
 *      肉眼能看出「闪」一下；
 *   ③ Android 15 起 navigationBarColor 被系统废弃，部分场景需要重推才生效。
 * 所以关键时机（路由变化）主动推一次，不依赖观察。
 */
export function syncNavBarNow(): void {
  // 让浏览器先完成 DOM 变更（例如播放页刚挂到 body 上），再读计算样式
  requestAnimationFrame(() => requestAnimationFrame(() => push()));
}

export function installNavBarSync(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  for (const d of RETRIES) window.setTimeout(push, d);

  // 主题切换时 --bg 会变，documentElement 的 style 随之改写 —— 重新同步一次。
  // 节流：safeArea 兜底也会改 documentElement.style，不必每次都推给原生。
  let timer: number | undefined;
  const schedule = () => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      push();
    }, 200);
  };
  try {
    const mo = new MutationObserver(schedule);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  } catch {
    /* ignore */
  }
  window.addEventListener('focus', schedule, { passive: true });
  // 从后台切回前台时系统可能重置了两条 bar 的颜色，补推一次
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) schedule();
  });
}

/**
 * v2.5.0 #2/#4：横屏隐藏 / 显示系统状态栏。
 * 横屏播放时整条状态栏隐藏；点屏幕显控件时再显示，控件隐藏时再隐藏。
 * 仅 Android 桥有效，其它环境（桌面/浏览器）直接忽略。
 */
export function setStatusBarVisible(visible: boolean): void {
  try {
    const bridge = (window as any).LvYunAndroid;
    if (bridge && typeof bridge.setStatusBarVisible === 'function') {
      bridge.setStatusBarVisible(visible);
    }
  } catch {
    /* ignore */
  }
}

/**
 * v2.5.0 #7：启动页把状态栏 / 手势栏染成启动渐变的两端色（顶部粉、底部深紫），
 * 让两条系统栏与渐变同色「消失」。仅 Android 有效。
 */
export function setSplashBars(statusColor: string, navColor: string): void {
  try {
    const bridge = (window as any).LvYunAndroid;
    if (!bridge) return;
    if (typeof bridge.setStatusBarColor === 'function') bridge.setStatusBarColor(statusColor, false);
    if (typeof bridge.setNavBarColor === 'function') bridge.setNavBarColor(navColor, false);
  } catch {
    /* ignore */
  }
}
