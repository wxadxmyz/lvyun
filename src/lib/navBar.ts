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

function push(): boolean {
  try {
    const bridge = (window as any).LvYunAndroid;
    if (!bridge) return false;
    const bg = readBg();
    // v2.4.5 #12：播放页「通知栏 → 手势栏一色」。
    // 旧实现只调 setNavBarColor —— 顶部状态栏从来没被染过，视觉必然割裂。
    // 优先用一次 setBarsColor 同时设两根条（避免两次 IPC、两帧不同色）；
    // 老版本桥没有这个方法时，退回分别调用，再退回只染导航栏。
    if (typeof bridge.setBarsColor === 'function') {
      bridge.setBarsColor(bg, false);
      return true;
    }
    let ok = false;
    if (typeof bridge.setNavBarColor === 'function') { bridge.setNavBarColor(bg, false); ok = true; }
    if (typeof bridge.setStatusBarColor === 'function') { bridge.setStatusBarColor(bg, false); ok = true; }
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
