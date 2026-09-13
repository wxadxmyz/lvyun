// 安全区兜底（#8 上滑误触通知栏）
//
// 背景：App 已开启沉浸模式（MainActivity 里 enableEdgeToEdge()），WebView 内容会延伸到系统栏下方。
// 部分安卓 WebView 在沉浸式下 env(safe-area-inset-top) 返回 0，导致 styles.css 里的 --sat 变成 0px，
// 全屏播放器顶部内容直接贴到状态栏/通知栏热区，用户在顶部区域上滑时容易误触系统通知栏。
//
// 做法：只有当 env() 确实没给出值时才注入兜底（真机返回真实 inset 时不覆盖），
// 让 .fs-top 已有的 padding: calc(4px + var(--sat)) 生效，把内容从通知栏热区推下来。

const SAT_FALLBACK = 24; // 安卓状态栏常见高度（px），足够避开通知栏下拉手势区

function readPx(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

export function installSafeAreaFallback() {
  const root = document.documentElement;

  const apply = () => {
    // 仅在 env() 返回 0（或不可用）时兜底，避免覆盖真机真实 inset
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
