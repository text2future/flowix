/**
 * 按 actionId 注册的"实例级"handler 栈。
 *
 * 解决的核心问题: action 在 actions.ts 是模块级单例, 但 run 逻辑常常依赖
 * 当前 mounted 的实例 (比如 "当前编辑器", "当前打开的弹窗")。一个全局 run
 * 函数没法知道现在是哪个实例。
 *
 * 解法: 组件 mount 时 pushHandler(id, fn), unmount 时调用返回的 pop 函数。
 * action.run 通过 invokeHandler(id) 触发栈顶 handler — 后注册的优先, 与
 * 组件挂载顺序一致 (后挂载的编辑器获得焦点是常见情况)。
 *
 * 为什么用栈而不是单个 slot: 嵌套场景下, 外层编辑器先 push, 内层后 push;
 * 内层 unmount 后, 外层自然恢复为栈顶。LIFO 语义符合 React 树的生命周期。
 *
 * 故意不做: 不做 Promise 协调 (handler 异步时不做取消/竞态控制), 不做去重
 * (同一 id 同一 handler 多次 push 会得到多个栈帧 — 这是 React StrictMode 下
 * 的预期行为, React 18+ 会在 dev 故意双调 effect)。
 */

type Handler = () => boolean | void;

const stacks = new Map<string, Handler[]>();

/**
 * Push 一个 handler 到指定 actionId 的栈顶, 返回 pop 函数。
 *
 * pop 函数幂等: 多次调用不会重复出栈 (防御 React StrictMode 双调 cleanup)。
 */
export function pushHandler(actionId: string, handler: Handler): () => void {
  const stack = stacks.get(actionId);
  if (stack) {
    stack.push(handler);
  } else {
    stacks.set(actionId, [handler]);
  }
  let popped = false;
  return () => {
    if (popped) return;
    popped = true;
    const s = stacks.get(actionId);
    if (!s) return;
    const idx = s.lastIndexOf(handler);
    if (idx >= 0) s.splice(idx, 1);
    if (s.length === 0) stacks.delete(actionId);
  };
}

/**
 * 调用栈顶 handler。
 *
 * 返回值:
 *  - `true`: 已处理 (handler 执行了动作, 或干脆没返回值 — 都视作已 claim 按键)
 *  - `false`: 拒绝处理。两种情况都会返回 false:
 *      a) 栈空 (没人注册 handler) — 通常发生在组件未挂载, e.g. 无编辑器时按 ⌘F
 *      b) handler 抛了异常
 *      c) handler 显式返回 false (用于"运行时不该 claim"的场景, e.g. 焦点在
 *         dialog 内的 input 里, 不应替用户确认)
 *
 * Provider 根据这个返回值决定是否 preventDefault。
 */
export function invokeHandler(actionId: string): boolean {
  const stack = stacks.get(actionId);
  if (!stack || stack.length === 0) return false;
  const top = stack[stack.length - 1];
  let result: boolean | void;
  try {
    result = top();
  } catch (err) {
    console.error(`[shortcuts] handler for "${actionId}" threw:`, err);
    return false;
  }
  return result !== false;
}

/** 测试 / HMR 用 — 业务代码不要调。 */
export function _clearHandlers(): void {
  stacks.clear();
}
