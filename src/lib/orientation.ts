/**
 * v2.4.2 #E：横屏真旋转。
 *
 * 背景：点「横屏播放」后，屏幕要真的转过去（系统级），而不是只把 CSS 层用竖屏视口铺满
 * （那只是「竖屏放大」）。这需要一个原生桥把方向指令发给 Android Activity。
 *
 * 原生侧由 .github/workflows/android.yml 注入的 MainActivity 提供
 * window.LvYunAndroid.setOrientation("landscape" | "portrait" | "sensor")。
 * 桥在 onWindowFocusChanged 里延后绑定，首帧几乎必然还没挂上，所以这里必须等桥 + 校验 + 重试。
 *
 * 对齐慕海 src/lib/orientation.ts 的踩坑经验：
 *  - 等桥：桥比首屏晚至多 20s 才绑上，轮询等待（单飞，避免旧轮询覆盖新指令）。
 *  - 校验：发完指令每 400ms 校验 innerWidth > innerHeight，没转就重发，共约 6s。
 *  - 代际 token：每次请求 ++verifyGen，作废之前所有校验链 —— 否则退出播放页后旧链
 *    每 400ms 把屏幕又翻回横屏。
 *  - 失败门控：onResult(false) 时调用方「不切横屏 UI」，彻底消灭「竖屏放大」假横屏。
 *  - 桌面 / 浏览器直接放行（没有系统旋转这回事，由 CSS 层接管）。
 */

const BRIDGE_WAIT_MS = 20000; // 桥最多晚 20s 绑上
const BRIDGE_POLL_MS = 100; // 等桥轮询间隔
const WAIT_HINT_AT_MS = 3000; // 等 3s 还没好就提示「连接中…」
const VERIFY_DELAY_MS = 400; // 校验间隔
const VERIFY_MAX_RETRY = 15; // 15 × 400ms ≈ 6s 重发窗口

type Ori = 'landscape' | 'portrait' | 'sensor';
type ToastFn = (msg: string) => void;

export interface OrientationOpts {
  /** 静默：退出横屏（portrait）时不弹提示 */
  silent?: boolean;
  /** 旋转结果回调：true=转成功（调用方可切横屏 UI），false=失败（调用方不切 UI） */
  onResult?: (ok: boolean) => void;
  /** 提示用 toast（连接中 / 失败）。不传则不提示 */
  toast?: ToastFn;
}

function isAndroidEnv(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /android/i.test(navigator.userAgent);
}

function bridgeReady(): boolean {
  try {
    const b = (window as any).LvYunAndroid;
    return !!(b && typeof b.setOrientation === 'function');
  } catch {
    return false;
  }
}

function callBridge(ori: Ori): boolean {
  try {
    const b = (window as any).LvYunAndroid;
    if (!b || typeof b.setOrientation !== 'function') return false;
    b.setOrientation(ori);
    return true;
  } catch {
    return false;
  }
}

function matches(ori: Ori): boolean {
  if (ori === 'landscape') return window.innerWidth > window.innerHeight;
  if (ori === 'portrait') return window.innerHeight >= window.innerWidth;
  return true; // sensor：任意方向都算成功
}

// 代际 token：每次请求 +1，作废之前所有未完成的校验链
let verifyGen = 0;
// 单飞：同一时刻只留一个等桥轮询
let pendingWait: number | undefined;
let pendingGen = 0;

function waitForBridge(myGen: number, onReady: () => void, opts: OrientationOpts): void {
  if (bridgeReady()) {
    onReady();
    return;
  }
  // 已有同代等待在飞，复用即可
  if (pendingWait !== undefined && pendingGen === myGen) return;

  const startedAt = Date.now();
  let hinted = false;
  pendingWait = window.setTimeout(function poll() {
    if (myGen !== verifyGen) {
      pendingWait = undefined;
      return; // 已有更新的方向请求，本链作废
    }
    if (bridgeReady()) {
      pendingWait = undefined;
      onReady();
      return;
    }
    if (!hinted && !opts.silent && Date.now() - startedAt >= WAIT_HINT_AT_MS) {
      hinted = true;
      opts.toast?.('旋转服务连接中…');
    }
    if (Date.now() - startedAt >= BRIDGE_WAIT_MS) {
      pendingWait = undefined;
      opts.toast?.('横屏切换失败，请稍后重试');
      opts.onResult?.(false);
      return;
    }
    pendingWait = window.setTimeout(poll, BRIDGE_POLL_MS);
  }, BRIDGE_POLL_MS);
  pendingGen = myGen;
}

function verifyAndRetry(ori: Ori, attempt: number, gen: number, opts: OrientationOpts): void {
  if (ori === 'sensor') {
    opts.onResult?.(true);
    return;
  }
  window.setTimeout(() => {
    if (gen !== verifyGen) return; // 已有更新的方向请求，本链作废，不再重发指令
    if (matches(ori)) {
      opts.onResult?.(true);
      return;
    }
    if (attempt < VERIFY_MAX_RETRY) {
      callBridge(ori); // 没转过去，重发指令
      verifyAndRetry(ori, attempt + 1, gen, opts);
    } else {
      if (!opts.silent) opts.toast?.('横屏切换失败，请在系统设置中允许屏幕旋转');
      opts.onResult?.(false);
    }
  }, VERIFY_DELAY_MS);
}

export function requestOrientation(ori: Ori, opts: OrientationOpts = {}): void {
  // 桌面 / 浏览器：没有系统级旋转，直接让 UI 接管（CSS 横屏层）
  if (!isAndroidEnv()) {
    opts.onResult?.(true);
    return;
  }

  const myGen = ++verifyGen; // 作废之前所有校验链
  const fire = () => {
    if (myGen !== verifyGen) return;
    if (!callBridge(ori)) {
      // 桥刚失联（极小概率），进入等桥流程
      waitForBridge(myGen, () => {
        if (myGen !== verifyGen) return;
        callBridge(ori);
        verifyAndRetry(ori, 1, myGen, opts);
      }, opts);
      return;
    }
    verifyAndRetry(ori, 1, myGen, opts);
  };

  // 桥可能还没绑上：先进等桥流程，绑上即发
  waitForBridge(myGen, () => {
    if (myGen !== verifyGen) return;
    callBridge(ori);
    verifyAndRetry(ori, 1, myGen, opts);
  }, opts);
}
