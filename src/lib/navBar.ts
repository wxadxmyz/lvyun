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
    if (!bridge || typeof bridge.setNavBarColor !== 'function') return false;
    bridge.setNavBarColor(readBg(), false);
    return true;
  } catch {
    return false;
  }
}

let installed = false;

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
}
