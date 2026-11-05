/**
 * 前端事件总线 — 统一收口 `@tauri-apps/api/event` 的 `listen<T>(name, cb)`。
 *
 * 后端事件经此适配层共享 Tauri listener。业务层可独立订阅同名事件，
 * 底层仅保留一个 listener，并在最后一个订阅者离开时释放。
 *
 * 设计:
 * - `subscribe<T>(event, handler): UnlistenFn` — 同名事件只挂 1 个 Tauri
 *   底层 listener, 内部维护 `Map<event, Set<handler>>`, 多 handler 共享
 *   同一份 listener。 handler 退出时调 UnlistenFn 从 set 删除, set 空了
 *   才真正 unlisten Tauri。
 * - 重复 `subscribe` 同名 → 沿用现有 Tauri listener, 仅在 set 加 handler。
 *   StrictMode 双挂 / HMR 重载 / 多个组件订阅同一 channel 全都安全。
 * - 底层注册失败时指数退避重试; `onListenerReady` 在首次成功及恢复后通知
 *   订阅者执行 snapshot reconciliation。
 * - registration generation 隔离过期异步结果, 防止快速卸载/重挂留下重复
 *   native listener。
 * - `subscribeOnce` — 触发一次自动 unsub。
 * - 单例状态模块级, 跨 hook 共享 (跟原 client.ts 设计一致)。 进程退出
 *   Tauri 自动清理, 这里不提供 `shutdown`。
 *
 * 应用层的 memo-event 桥接、open-target 监听和客户端事件适配都通过
 * `subscribe` 管理生命周期；外部文档 watcher 还会在领域层合并文件 lease，
 * 再把事件分发到该文件的各个视图。
 *
 * 类型安全: handler 入参是 `event.payload` (T), 生命周期通知通过类型化的
 * SubscribeOptions 暴露。
 */

import { listen, type Event, type UnlistenFn } from '@tauri-apps/api/event';
import { createLogger } from '@/lib/logger';

// 重导出 UnlistenFn 类型, 让消费者不必直接 import @tauri-apps/api/event
export type { UnlistenFn } from '@tauri-apps/api/event';

/** Make the Tauri unlisten handle safe across racing component cleanup paths. */
export function onceUnlisten(unlisten: UnlistenFn): UnlistenFn {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    unlisten();
  };
}

/** 模块级 listener 索引 — key 是事件名 (Tauri 字符串), value 是该事件的所有 handler。 */
const handlers = new Map<string, Set<(payload: unknown) => void>>();
const listenerReadyHandlers = new Map<string, Set<() => void>>();

/** 模块级 Tauri unlisten 句柄 — 每个 event 1 份, set 空了才真卸。 */
const tauriUnlistens = new Map<string, UnlistenFn>();
const listenerGenerations = new Map<string, number>();
const retryTimers = new Map<string, number>();
const retryAttempts = new Map<string, number>();
const LISTENER_RETRY_BASE_DELAY_MS = 1000;
const LISTENER_RETRY_MAX_DELAY_MS = 30_000;
const logger = createLogger('event-bus');

/** 错误日志聚合: 防止某个 handler 异常影响其他 handler。 */
function logHandlerError(event: string, err: unknown): void {
  logger.warn(`handler for "${event}" threw`, { error: String(err) });
}

function notifyListenerReady(event: string): void {
  for (const handler of [...(listenerReadyHandlers.get(event) ?? [])]) {
    try {
      handler();
    } catch (err) {
      logHandlerError(`${event}:ready`, err);
    }
  }
}

function nextListenerGeneration(event: string): number {
  const generation = (listenerGenerations.get(event) ?? 0) + 1;
  listenerGenerations.set(event, generation);
  return generation;
}

function clearRetryTimer(event: string): void {
  const timer = retryTimers.get(event);
  if (timer === undefined) return;
  window.clearTimeout(timer);
  retryTimers.delete(event);
}

function resetRetryState(event: string): void {
  clearRetryTimer(event);
  retryAttempts.delete(event);
}

function scheduleListenerRetry(event: string): void {
  if (!handlers.has(event) || retryTimers.has(event)) return;
  const attempt = retryAttempts.get(event) ?? 0;
  const delay = Math.min(
    LISTENER_RETRY_BASE_DELAY_MS * (2 ** attempt),
    LISTENER_RETRY_MAX_DELAY_MS,
  );
  retryAttempts.set(event, attempt + 1);
  const timer = window.setTimeout(() => {
    retryTimers.delete(event);
    ensureTauriListener(event);
  }, delay);
  retryTimers.set(event, timer);
}

function ensureTauriListener(event: string): void {
  if (!handlers.has(event) || tauriUnlistens.has(event)) return;

  const generation = nextListenerGeneration(event);
  tauriUnlistens.set(event, PLACEHOLDER_UNLISTEN);
  void listen<unknown>(event, (e: Event<unknown>) => {
    const live = handlers.get(event);
    if (!live) return;
    // Copy before dispatch so a handler can unsubscribe safely.
    for (const handler of [...live]) {
      try {
        handler(e.payload);
      } catch (err) {
        logHandlerError(event, err);
      }
    }
    })
    .then((unlisten) => {
      const stop = onceUnlisten(unlisten);
      if (listenerGenerations.get(event) !== generation) {
        stop();
        return;
      }
      resetRetryState(event);
      // All handlers may have unsubscribed while listen() was pending.
      if (!handlers.has(event)) {
        stop();
        tauriUnlistens.delete(event);
        return;
      }
      tauriUnlistens.set(event, stop);
      notifyListenerReady(event);
    })
    .catch((err: unknown) => {
      if (listenerGenerations.get(event) !== generation) return;
      if (tauriUnlistens.get(event) === PLACEHOLDER_UNLISTEN) {
        tauriUnlistens.delete(event);
      }
      // Keep the logical subscription alive. A transient capability/startup
      // failure must not strand a Webview without live events for its entire
      // lifetime.
      scheduleListenerRetry(event);
      logger.warn(`failed to listen for "${event}"`, { error: String(err) });
    });
}

export interface SubscribeOptions {
  /** Called whenever the underlying Tauri listener becomes ready, including after recovery. */
  onListenerReady?: () => void;
}

/**
 * 订阅后端事件 `event`。 返回 UnlistenFn, 调它从订阅集合里删除 handler;
 * 若该事件已无 handler, 同时 unlisten 底层 Tauri listener。
 *
 * handler 抛错被捕获并 warn, 不影响同一事件下其他 handler, 也不影响底层
 * Tauri listener (UnlistenFn 不会被吃掉)。
 */
export function subscribe<T>(
  event: string,
  handler: (payload: T) => void,
  options?: SubscribeOptions,
): UnlistenFn {
  let set = handlers.get(event);

  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }

  // 用 unknown 中转, 跟 Tauri 内部 typed listen<T> 走的是同一闭包。
  const wrapped = handler as unknown as (payload: unknown) => void;
  set.add(wrapped);
  const readyHandler = options?.onListenerReady;
  if (readyHandler) {
    let readySet = listenerReadyHandlers.get(event);
    if (!readySet) {
      readySet = new Set();
      listenerReadyHandlers.set(event, readySet);
    }
    readySet.add(readyHandler);
  }

  const existingUnlisten = tauriUnlistens.get(event);
  ensureTauriListener(event);
  if (readyHandler && existingUnlisten && existingUnlisten !== PLACEHOLDER_UNLISTEN) {
    queueMicrotask(() => {
      if (listenerReadyHandlers.get(event)?.has(readyHandler)) readyHandler();
    });
  }

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    const s = handlers.get(event);
    if (!s) return;
    s.delete(wrapped);
    if (readyHandler) {
      const readySet = listenerReadyHandlers.get(event);
      readySet?.delete(readyHandler);
      if (readySet?.size === 0) listenerReadyHandlers.delete(event);
    }
    if (s.size === 0) {
      handlers.delete(event);
      listenerReadyHandlers.delete(event);
      resetRetryState(event);
      nextListenerGeneration(event);
      const u = tauriUnlistens.get(event);
      tauriUnlistens.delete(event);
      if (u && u !== PLACEHOLDER_UNLISTEN) {
        u();
      }
      // listen() 还没 resolve 时, 上面 .then 会看到 handlers.has(event) === false
      // 并 self-cleanup (见 listen().then 块)。
    }
  };
}

// 占位 unlisten, 在 listen() promise 还没 resolve 期间充当 Map value。
// 真 unlisten 拿到后会被替换 (见 .then)。
const PLACEHOLDER_UNLISTEN: UnlistenFn = () => {
  /* placeholder */
};
