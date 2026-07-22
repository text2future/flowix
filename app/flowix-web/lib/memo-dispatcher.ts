/**
 * `MemoEvent` 应用层分发器 — 中央 router + filter-声明式订阅。
 *
 * 本模块只负责把后端 `memo-event` Tauri 通道桥接到应用层 dispatcher，
 * 不注册任何窗口专属业务 handler。主窗口列表同步由
 * `app/main-window-effects.tsx` 注册，Tab 窗口的 memo adapter 只注册自身 tabs 的
 * handler，因此不同 Webview 不会加载彼此的状态副作用。
 *
 * 跟 `lib/event-dispatcher.ts` 的关系:
 * - `event-bus.ts` (Tauri 适配层)  → `memoDispatcher.dispatch`
 *   - 监听 Tauri 'memo-event' 通道, 把 payload 转发给 dispatcher
 * - `memoDispatcher` (应用层)  → 各窗口自行注册的 handler
 *
 * 单一订阅点保证:
 * - 同一 webview 内只有一个 memoDispatcher 实例 (模块级单例)
 * - 即使 app.tsx 在 StrictMode 双挂 / HMR 重载, 也只挂 1 个 Tauri listener
 *   (event-bus 自动去重) + 1 个 dispatch 桥接
 *
 * Phase 1: filter-based 派发。每个窗口的 handler 显式声明 filter。
 *
 * Phase 2: 上 dedup middleware (`createMemoDedupMiddleware`), 合并
 *          短窗口内同 id 的连续事件 (last-write-wins), 减少 rerender。
 */

import { subscribe } from '@platform/tauri/event-bus';
import { EventDispatcher, type DispatcherMiddleware } from '@/lib/event-dispatcher';
import { createMemoDedupMiddleware } from '@/lib/memo-dispatcher-dedup';
import type { MemoEvent } from '@/types/memo';

// Current windowing model: the main window and each tab-host window import
// this bridge independently. The preferences window intentionally does not.

/**
 * 全局 memoDispatcher 单例 (per-webview)。主窗口 / Tab 宿主窗口各自
 * 持有一份独立实例，通过 Tauri 事件总线收到的 payload 各自独立
 * dispatch，不共享订阅者。
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
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log('[memo-event] raw <- tauri', {
        at: new Date().toISOString(),
        kind: payload.kind,
        source: payload.kind === 'created' || payload.kind === 'updated' ? payload.source : null,
        id:
          payload.kind === 'updated' || payload.kind === 'deleted'
            ? payload.id
            : payload.kind === 'created'
              ? payload.memo.id
              : null,
        path:
          payload.kind === 'created'
            ? payload.memo.filename
            : payload.kind === 'updated' || payload.kind === 'deleted'
              ? payload.path
              : null,
        // tags_renamed / tags_deleted 是 metadata 事件, 顺手把 affected
        // memo 数打到日志, 排查"重命名 / 删除影响范围"时不用再看 IPC 抓包。
        affectedMemos:
          payload.kind === 'tags_renamed' || payload.kind === 'tags_deleted'
            ? payload.affectedMemoIds.length
            : null,
      });
    }
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

// ---- 跨订阅者注册接口 -------------------------------------------------------
//
// 给 `useExternalDocumentChangeWatch` 等需要"按 kind + source + path
// 自定义"的 hook 用: 它们走 `memoDispatcher.subscribe(...)` 注册自己
// 的 handler, 不再直接监听 Tauri 通道，并共享同一份 dedup / filter / log
// 中间件。
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
