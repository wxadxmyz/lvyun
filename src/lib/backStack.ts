// v2.3.11 #4：全局返回键栈式调度（移植自慕海 v3.5.0 src/lib/backStack.ts）
//
// 旧架构的病根：MusicApp 里一条扁平的 if-else 单槽链，每个浮层状态各占一格。
// 问题在于 `settingsSub` 是**单个 string | null，不带层级信息** —— 进入设置子页后，
// 子页内部再开的扫码 / 编辑源 / 二级确认等更深状态活在子组件里，父容器完全看不见，
// 于是返回时只能执行 setSettingsSub(null)，直接从第三层跳回第一层。
// 更糟的是 __onAndroidBack 与 onBackButton 是两份复制粘贴的逻辑，已经开始漂移。
//
// 新架构：返回键从栈顶逐层询问，谁消费谁拦截（handler 返回 true），
// 栈空才放行（false → 调用方走外层分级或交系统退出）。组件挂载 push、卸载 pop，
// 互不感知 prev，新增任意层级只要一行 useEffect，天然不会断链。

export type BackHandler = () => boolean; // true = 本次返回已被消费（拦截）；false = 不处理，继续问下一层

interface StackEntry {
  id: number;
  handler: BackHandler;
}

const stack: StackEntry[] = [];
let seq = 0;

/** 挂载时压栈；返回退栈函数（放在 useEffect 的 cleanup 里） */
export function pushBackHandler(handler: BackHandler): () => void {
  const id = ++seq;
  stack.push({ id, handler });
  return () => popBackHandler(id);
}

export function popBackHandler(id: number): void {
  const i = stack.findIndex((e) => e.id === id);
  if (i >= 0) stack.splice(i, 1);
}

/** 返回键统一入口：从栈顶逐层询问。返回 true=已消费（拦截），false=栈全不处理（放行） */
export function dispatchBack(): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    try {
      if (stack[i].handler()) return true;
    } catch {
      // 抛异常的 handler 视为失效，弹出后继续问下一层，避免整条返回链卡死
      stack.splice(i, 1);
    }
  }
  return false;
}

/** 调试用：当前栈深 */
export function backStackDepth(): number {
  return stack.length;
}
