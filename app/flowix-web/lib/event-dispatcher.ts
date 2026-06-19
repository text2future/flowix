/**
 * 通用事件分发器 — 给应用层事件 (如 `MemoEvent`) 一个中央路由。
 *
 * 背景: 项目里 `useMemoEvents.ts` 早期是 "hook 集中分发 (kind switch)"
 * 形态 — 单订阅点, 内部 switch 派发到 memo-store 的 handleMemo* action,
 * 已经有中央化的雏形。但有 3 个缺陷:
 *
 * 1. 双订阅绕过中央路由 — `useExternalDocumentChangeWatch` 直接 subscribe
 *    Tauri 'memo-event', 跟 useMemoEvents 并列, 不走中央 switch。未来
 *    第 3 个订阅者会继续散开。
 * 2. 同 id 快速连续事件不合并 — N 次 set() 触发 N 次 rerender。 这是
 *    后端 fs_watcher FSEvents 双触发 / 编辑器 debounce save 期间的常态。
 * 3. source 字段闲置 — 6 种 source 前端仅用 `user_edit` 做一次排除,
 *    handler 想拿上下文得自己实现。
 *
 * 本模块提供 (Phase 1 启用, Phase 2 增强):
 *
 * - `subscribe(handler, filter?)` — 每个 handler 就近声明自己关心的
 *   kind / source / path, filter 在 dispatcher 内统一执行, 跨订阅者
 *   一致。
 * - `dispatch(event)` — 同步派发到所有匹配 filter 的 handler, handler
 *   抛错被捕获不影响其他。
 * - `use(middleware)` — koa-style middleware 链, 可包装 dispatch 实现
 *   dedup / coalesce / log。当前 (Phase 2) 上一个 dedup middleware。
 *
 * 不替代 `lib/tauri/event-bus.ts`: 那个是 Tauri `listen` 适配层
 * (多 handler 共享 1 个 Tauri listener), 这个是应用层语义层 (filter +
 * middleware + 分发策略)。两者职责正交, 一般用法是
 * event-bus.subscribe(tauri event) → dispatcher.dispatch(payload)。
 *
 * 使用范式 (MemoEvent 场景):
 *
 *   // lib/memo-dispatcher.ts (side-effect module)
 *   import { memoDispatcher } from './event-dispatcher';
 *   subscribe<MemoEvent>('memo-event', (e) => memoDispatcher.dispatch(e));
 *
 *   memoDispatcher.subscribe(
 *     (e) => useMemoStore.getState().handleMemoUpdated(e.memo),
 *     (e) => e.kind === 'updated',
 *   );
 *
 * 注意: dispatcher 是模块级单例, 多个 webview (主窗口 / 偏好窗口) 各持
 * 一份独立实例, 互不影响。 这是预期行为 — 偏好窗口没有 document-pane,
 * 它的 reload handler 就根本不订阅, 不需要跨 webview 协调 dispatcher。
 */

export type DispatcherMiddleware<T> = (next: DispatchFn<T>) => DispatchFn<T>;
export type DispatchFn<T> = (event: T) => void;
export type EventFilter<T> = (event: T) => boolean;
export type EventHandler<T> = (event: T) => void;
export type Unsubscribe = () => void;

interface Subscription<T> {
  readonly filter?: EventFilter<T>;
  readonly handler: EventHandler<T>;
}

/**
 * 应用层事件分发器。 单例 (通常模块级 export), 同步派发, handler
 * 抛错被捕获不中断其他 handler。
 */
export class EventDispatcher<T> {
  private readonly subs = new Set<Subscription<T>>();
  private dispatchFn: DispatchFn<T>;

  constructor() {
    // 初始 dispatch 直接走到 _rawDispatch; middleware 在 .use() 里包装。
    this.dispatchFn = (event: T) => this.rawDispatch(event);
  }

  /**
   * 包装 dispatch 路径。 多次 `.use(mw)` 按注册顺序叠加 — 最先注册的
   * middleware 最先拿到事件 (洋葱模型外层)。
   *
   * Phase 2 用法:
   *
   *   dispatcher.use(dedupMiddleware({ getKey: memoKey, delay: 50 }));
   */
  use(middleware: DispatcherMiddleware<T>): void {
    this.dispatchFn = middleware(this.dispatchFn);
  }

  /**
   * 同步派发事件。 先经过 middleware 链, 最终走到所有 filter 匹配的
   * handler。 handler 抛错被 `console.warn` 捕获, 不影响其他 handler。
   */
  dispatch(event: T): void {
    this.dispatchFn(event);
  }

  /**
   * 订阅事件。 `filter` 可选 — 不传则 handler 接收所有事件。
   *
   * 返回的 `unsubscribe()` 调用后立即生效; 内部拷贝迭代, handler 内
   * 主动 unsub 不会影响本次 dispatch。
   */
  subscribe(handler: EventHandler<T>, filter?: EventFilter<T>): Unsubscribe {
    const sub: Subscription<T> = filter ? { handler, filter } : { handler };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }

  /**
   * 调试 / 测试用: 当前订阅数 (含 filter)。
   */
  size(): number {
    return this.subs.size;
  }

  private rawDispatch(event: T): void {
    // 拷贝避免 handler 内部 unsub 干扰本次迭代
    for (const sub of [...this.subs]) {
      if (sub.filter && !sub.filter(event)) continue;
      try {
        sub.handler(event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[event-dispatcher] handler threw:', err);
      }
    }
  }
}