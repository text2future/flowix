/**
 * 前端事件总线 — 统一收口 `@tauri-apps/api/event` 的 `listen<T>(name, cb)`。
 *
 * 背景: 项目里后端发了多 channel 事件 (memo-event / agent-chunk /
 * user-config-changed / agent-access-changed / flowix:open-target), 此前
 * 每个 channel 自己写 "模块级 unlisten 单例 + 重复挂载短路" 样板
 * (client.ts 的 `streamUnlisten` / `userConfigUnlisten` / `agentAccessUnlisten`、
 * openByTarget/listener.ts 的 `unlisten`、useMemoEvents 的 `disposed` 互斥)。
 * 同形逻辑散在 4 处, 改一处就得手工同步 4 处。
 *
 * 设计:
 * - `subscribe<T>(event, handler): UnlistenFn` — 同名事件只挂 1 个 Tauri
 *   底层 listener, 内部维护 `Map<event, Set<handler>>`, 多 handler 共享
 *   同一份 listener。 handler 退出时调 UnlistenFn 从 set 删除, set 空了
 *   才真正 unlisten Tauri。
 * - 重复 `subscribe` 同名 → 沿用现有 Tauri listener, 仅在 set 加 handler。
 *   StrictMode 双挂 / HMR 重载 / 多个组件订阅同一 channel 全都安全。
 * - `subscribeOnce` — 触发一次自动 unsub。
 * - 单例状态模块级, 跨 hook 共享 (跟原 client.ts 设计一致)。 进程退出
 *   Tauri 自动清理, 这里不提供 `shutdown`。
 *
 * 迁移: client.ts 的 `listenToAgentStream` / `listenToUserConfigChanges` /
 * `listenToAgentAccessChanges` / `stopListeningTo*` 内部都改走本模块。
 * openByTarget/listener.ts 的 `mountOpenTargetListener` / `unmount` 也走
 * 同一接口。 useMemoEvents 用 `subscribe` 替换内联 `listen` + `disposed`
 * 样板, useEffect cleanup 直接调 unsubscribe。
 *
 * 类型安全: handler 入参是 `event.payload` (T), 不暴露 UnlistenFn 之外的
 * 任何 callback 形式。
 */

import { listen, type Event, type UnlistenFn } from '@tauri-apps/api/event';

// 重导出 UnlistenFn 类型, 让消费者不必直接 import @tauri-apps/api/event
export type { UnlistenFn } from '@tauri-apps/api/event';

/** 模块级 listener 索引 — key 是事件名 (Tauri 字符串), value 是该事件的所有 handler。 */
const handlers = new Map<string, Set<(payload: unknown) => void>>();

/** 模块级 Tauri unlisten 句柄 — 每个 event 1 份, set 空了才真卸。 */
const tauriUnlistens = new Map<string, UnlistenFn>();

/** 错误日志聚合: 防止某个 handler 异常影响其他 handler。 */
function logHandlerError(event: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`[event-bus] handler for "${event}" threw:`, err);
}

/**
 * 订阅后端事件 `event`。 返回 UnlistenFn, 调它从订阅集合里删除 handler;
 * 若该事件已无 handler, 同时 unlisten 底层 Tauri listener。
 *
 * handler 抛错被捕获并 warn, 不影响同一事件下其他 handler, 也不影响底层
 * Tauri listener (UnlistenFn 不会被吃掉)。
 */
export function subscribe<T>(event: string, handler: (payload: T) => void): UnlistenFn {
  let set = handlers.get(event);
  let tauriUnlisten = tauriUnlistens.get(event);

  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  if (!tauriUnlisten) {
    // 首次挂: 注册 Tauri listener, payload 转成 unknown 再分发, 让每个
    // handler 各自断言。 这里我们无法 await listen (接口要求同步返回
    // UnlistenFn), 内部用 .then 接住真实 unlisten。
    tauriUnlisten = PLACEHOLDER_UNLISTEN;
    tauriUnlistens.set(event, tauriUnlisten);
    void listen<unknown>(event, (e: Event<unknown>) => {
      const live = handlers.get(event);
      if (!live) return;
      // 拷贝避免 handler 内部 unsub 干扰迭代
      for (const h of [...live]) {
        try {
          h(e.payload);
        } catch (err) {
          logHandlerError(event, err);
        }
      }
    })
      .then((unlisten) => {
        // listen 期间若所有 handler 都被 unsub, 跳过挂载
        if (!handlers.has(event)) {
          unlisten();
          tauriUnlistens.delete(event);
          return;
        }
        tauriUnlistens.set(event, unlisten);
      })
      .catch((err: unknown) => {
        // Registration can fail when the webview is shutting down or when this
        // module is evaluated outside Tauri. Remove only our placeholder so a
        // later subscribe can retry instead of getting stuck permanently.
        if (tauriUnlistens.get(event) === PLACEHOLDER_UNLISTEN) {
          tauriUnlistens.delete(event);
        }
        // eslint-disable-next-line no-console
        console.warn(`[event-bus] failed to listen for "${event}":`, err);
      });
  }

  // 用 unknown 中转, 跟 Tauri 内部 typed listen<T> 走的是同一闭包。
  const wrapped = handler as unknown as (payload: unknown) => void;
  set.add(wrapped);

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    const s = handlers.get(event);
    if (!s) return;
    s.delete(wrapped);
    if (s.size === 0) {
      handlers.delete(event);
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

/**
 * 一次性订阅: handler 第一次被调用后自动 unsub。
 *
 * 实现: 内部 subscribe + 调一次就 unsub。 注意如果 handler 主动抛错,
 * 仍然算"已调用", 不会再触发 (跟原生 DOM once 一致)。
 */
export function subscribeOnce<T>(event: string, handler: (payload: T) => void): UnlistenFn {
  let unlisten: UnlistenFn | undefined;
  unlisten = subscribe<T>(event, (payload) => {
    if (unlisten) unlisten();
    handler(payload);
  });
  return unlisten!;
}

/**
 * 调试 / 测试用: 当前已挂 Tauri 事件数 (不等于 handler 总数)。
 */
export function subscribedEventCount(): number {
  return tauriUnlistens.size;
}

/**
 * 调试 / 测试用: 清空所有订阅 + unlisten 全部 Tauri 监听。 主要给单测
 * afterEach 用, 业务代码不要调。
 */
export function _resetForTests(): void {
  for (const u of tauriUnlistens.values()) {
    if (u !== PLACEHOLDER_UNLISTEN) u();
  }
  handlers.clear();
  tauriUnlistens.clear();
}

// 占位 unlisten, 在 listen() promise 还没 resolve 期间充当 Map value。
// 真 unlisten 拿到后会被替换 (见 .then)。
const PLACEHOLDER_UNLISTEN: UnlistenFn = () => {
  /* placeholder */
};
