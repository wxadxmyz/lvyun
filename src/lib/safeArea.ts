// 安全区兜底（#8 上滑误触通知栏）
//
// 背景：App 已开启沉浸模式（MainActivity 里 enableEdgeToEdge()），WebView 内容会延伸到系统栏下方。
// 部分安卓 WebView 在沉浸式下 env(safe-area-inset-top) 返回 0，导致 styles.css 里的 --sat 变成 0px，
// 全屏播放器顶部内容直接贴到状态栏/通知栏热区，用户在顶部区域上滑时容易误触系统通知栏。
//
// 做法：只有当 env() 确实没给出值时才注入兜底（真机返回真实 inset 时不覆盖），
// 让 .fs-top 已有的 padding: calc(4px + var(--sat)) 生效，把内容从通知栏热区推下来。

// v2.4.1 #C：与 styles.css 的 --sat 兜底口径统一。
// 此前这里写 24、CSS 兜底写 26，两处不一致 —— 若 env() 上报 0，
// JS 兜底注入 24px 会覆盖 CSS 的 26px，实际留白比预期少 2px。
const SAT_FALLBACK = 34; // 与 CSS 保持一致的安卓状态栏兜底高度（px）

function readPx(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

export function installSafeAreaFallback() {
  const root = document.documentElement;

  const apply = () => {
    /* v2.4.10 #14：横屏时不注入安全区。
     *
     * 实测（截图像素级采样，dpr 3.5）：横屏顶部凭空多出 148 device px = 42.3 css px
     * 的空白带，颜色精确等于 App 的 --bg（#f4f5f9），不是系统状态栏的白 ——
     * 也就是律云自己画出来的。构成是 `padding-top 8px + --sat 34px`。
     *
     * 那 34px 就来自下面的 SAT_FALLBACK：横屏时 Android 的
     * env(safe-area-inset-top) 返回 0（横屏本来就没有状态栏，
     * 或 WebView 在沉浸式下不上报），于是 `readPx('--sat') <= 0` 成立 → 注入 34px。
     *
     * 底部同理：横屏的手势条是贴在**侧边**的，底部留白（8px padding + ~7px --sab）
     * 什么也挡不住，纯属浪费。
     *
     * 所以横屏直接把两个变量归零。
     *
     * ⚠️ 为什么归零是安全的：--sat/--sab 是 :root 上的全局变量，横屏时整个屏幕
     *    由 .pv-root（position:fixed; inset:0; z-index:60）接管，
     *    .main 已 display:none（styles.css `body.landscape-on .main.player-open`），
     *    底部 Tab 也 display:none —— 没有任何其他元素依赖这两个变量。
     *    退出横屏时 resize 事件会重跑本函数，竖屏值自动恢复（见文件末的监听）。 */
    const landscape = window.innerWidth > window.innerHeight;
    if (landscape) {
      root.style.setProperty('--sat', '0px');
      root.style.setProperty('--sab', '0px');
      return;
    }

    // 竖屏：仅在 env() 返回 0（或不可用）时兜底，避免覆盖真机真实 inset
    if (readPx('--sat') <= 0) {
      root.style.setProperty('--sat', `${SAT_FALLBACK}px`);
    }
    // 底部手势条 styles.css 已有 max(...,18px) 兜底，这里再补一层，避免个别机型被裁掉
    if (readPx('--sab') <= 0) {
      root.style.setProperty('--sab', '18px');
    }
  };

  apply();
  // 旋转、窗口尺寸、软键盘都会改变可视区域，变化后重算
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);
  const vv = (window as any).visualViewport;
  if (vv && typeof vv.addEventListener === 'function') {
    vv.addEventListener('resize', apply);
  }
}
