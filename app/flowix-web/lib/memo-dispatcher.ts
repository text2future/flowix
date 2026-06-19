/**
 * `MemoEvent` 应用层分发器 — 中央 router + filter-声明式订阅。
 *
 * 本模块是副作用模块: 顶层 `subscribe('memo-event', ...)` + 4 个
 * `memoDispatcher.subscribe(...)` 在模块加载时一次性执行, 把后端
 * `memo-event` Tauri 通道和应用层 4 个 handler (3 个 memo-store +
 * 1 个 reload) 串联起来。 业务代码不需要直接调本模块, 只需要在
 * App 启动时 import 一次触发注册即可 (见 App.tsx 的 `useMemoEvents`)。
 *
 * 跟 `lib/event-dispatcher.ts` 的关系:
 * - `event-bus.ts` (Tauri 适配层)  → `memoDispatcher.dispatch`
 *   - 监听 Tauri 'memo-event' 通道, 把 payload 转发给 dispatcher
 * - `memoDispatcher` (应用层)  → handler
 *   - 4 个 handler 按 filter 分发 (kind / source / 路径匹配)
 *
 * 单一订阅点保证:
 * - 同一 webview 内只有一个 memoDispatcher 实例 (模块级单例)
 * - 即使 App.tsx 在 StrictMode 双挂 / HMR 重载, 也只挂 1 个 Tauri listener
 *   (event-bus 自动去重) + 1 个 dispatch 桥接
 *
 * Phase 1: filter-based 派发。 每个 handler 显式声明 filter, 不再
 *          需要中央 switch。 4 个 handler 拆分到独立函数, 加新 handler
 *          只调 `memoDispatcher.subscribe(...)`。
 *
 * Phase 2: 上 dedup middleware (`createMemoDedupMiddleware`), 合并
 *          短窗口内同 id 的连续事件 (last-write-wins), 减少 rerender。
 */

import { subscribe } from './tauri/event-bus';
import { EventDispatcher, type DispatcherMiddleware } from './event-dispatcher';
import { joinNotebookMemoPath } from './path';
import { useDocumentStore } from './store/document-store';
import { useMemoStore } from './store/memo-store';
import { createMemoDedupMiddleware } from './memo-dispatcher-dedup';
import type { MemoEvent } from '../types/memo';

/**
 * 全局 memoDispatcher 单例 (per-webview)。 各 webview (主窗口 / 偏好
 * 窗口) 各自持有一份独立实例, 通过 Tauri 事件总线收到的 payload
 * 各自独立 dispatch — 互不串台。
 */
export const memoDispatcher = new EventDispatcher<MemoEvent>();

// ---- 模块级: 单一 Tauri 订阅 → dispatcher 入口 -------------------------------
//
// 用模块级 let 守门: 即使本模块被多次 import (HMR / StrictMode 双挂),
// 也只挂 1 个 Tauri listener。 event-bus 的 `subscribe` 自身也能去重,
// 但每次 subscribe 会增加 1 个 handler, 每次 dispatch 会被调用多次 ──
// 这里手动守门更直白。
let memoEventBridgeInstalled = false;

function installMemoEventBridge(): void {
  if (memoEventBridgeInstalled) return;
  memoEventBridgeInstalled = true;
  subscribe<MemoEvent>('memo-event', (payload) => {
    // DEBUG: 打印后端 emit 到前端的所有 memo-event (dedup 之前的原始事件)。
    // 排查"外部修改"提示链路时, 用这个日志看 fs_watcher 是否真的发了
    // `updated` + `source=external_tool` 事件, 路径是否匹配当前文档。
    // eslint-disable-next-line no-console
    console.log('[memo-event] raw <- tauri', {
      at: new Date().toISOString(),
      kind: payload.kind,
      source: payload.kind === 'deleted' ? null : payload.source,
      id: payload.kind === 'deleted' ? payload.id : payload.memo.id,
      path: payload.kind === 'created' ? payload.memo.filename : payload.path,
    });
    memoDispatcher.dispatch(payload);
  });
}

// 顶层立即执行 — 任何 import 本文件的模块都会触发注册。
installMemoEventBridge();

// ---- Phase 2: dedup middleware ----------------------------------------------
//
// 装在最外层 (dispatch 入口) — 后续 filter / log 等 middleware 看到的是
// dedup 后的"最终事件", 不是中间事件。 这是有意的, 减少下游 rerender。
// 守门防止多次 install (StrictMode / HMR 重复 import 不会重复挂 middleware)。
let memoDedupInstalled = false;
function installMemoDedup(): void {
  if (memoDedupInstalled) return;
  memoDedupInstalled = true;
  memoDispatcher.use(createMemoDedupMiddleware({ delay: 50 }));
}
installMemoDedup();

// ---- 4 个 memo-store 派发 handler --------------------------------------------
//
// 每个 handler 用 filter 声明自己关心的 kind, 不再需要中央 switch。
// 顺序无所谓 (filter 互斥), 注册顺序作为处理优先级保留供未来 middleware
// (e.g. coalesce / collapse) 决定。

memoDispatcher.subscribe(
  (event) => {
    if (event.kind !== 'created') return;
    const memoStore = useMemoStore.getState();
    memoStore.handleMemoCreated(event.memo, { select: event.source === 'external_tool' });
    if (event.source === 'external_tool') {
      const notebook = memoStore.selectedNotebook;
      const path = notebook?.path ? joinNotebookMemoPath(notebook.path, event.memo.filename) : event.memo.filename;
      void useDocumentStore.getState().openMemoDocument({
        memoId: event.memo.id,
        path,
        notebookId: notebook?.id ?? null,
        notebookPath: notebook?.path ?? null,
      });
    }
  },
  (event) => event.kind === 'created',
);

memoDispatcher.subscribe(
  (event) => {
    if (event.kind !== 'updated') return;
    useMemoStore.getState().handleMemoUpdated(event.memo);
    useDocumentStore.getState().replaceActiveMemoPath(event.id, event.path);
  },
  (event) => event.kind === 'updated',
);

memoDispatcher.subscribe(
  (event) => {
    if (event.kind !== 'deleted') return;
    useMemoStore.getState().handleMemoDeleted(event.id);
  },
  (event) => event.kind === 'deleted',
);

// ---- 跨订阅者注册接口 -------------------------------------------------------
//
// 给 `useExternalDocumentChangeWatch` 等需要"按 kind + source + path
// 自定义"的 hook 用: 它们走 `memoDispatcher.subscribe(...)` 注册自己
// 的 handler, 不再直接监听 Tauri 通道, 跟 4 个 memo-store handler 共享
// 同一份 dedup / filter / log 中间件。
//
// 这正是 Phase 1 的核心收益: 把双订阅从"event-bus 层并列"统一到
// "memoDispatcher 层声明式 filter"。

/**
 * 给 `useExternalDocumentChangeWatch` 等外部组件使用的注册接口。
 * 等价于 `memoDispatcher.subscribe` 但带命名空间前缀, 阅读时一眼看出
 * "这是 reload 类 handler, 不是 memo-store 类"。
 */
export function registerMemoEventHandler(
  handler: (event: MemoEvent) => void,
  filter?: (event: MemoEvent) => boolean,
): () => void {
  return memoDispatcher.subscribe(handler, filter);
}

/**
 * 给 Phase 2 middleware 安装接口。 上层 (测试 / 配置) 调
 * `installMemoMiddleware(...)` 把 dedup 装上, 不需要直接 import
 * `EventDispatcher` 类。
 */
export function installMemoMiddleware(middleware: DispatcherMiddleware<MemoEvent>): void {
  memoDispatcher.use(middleware);
}
