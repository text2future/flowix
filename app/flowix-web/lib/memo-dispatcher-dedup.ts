/**
 * `memoDispatcher` dedup middleware — 同 id 短窗口内合并, last-write-wins。
 *
 * 背景:
 * - 后端 fs_watcher 在 FSEvents 双触发 / 编辑器 debounce save 期间
 *   可能短时间内对同一条 memo emit 多个 `updated` 事件。
 * - Agent 工具链 (read_memo → edit_memo → read_memo) 也可能短时间内
 *   多次更新同一条 memo。
 * - 没有 dedup 时, 前端 `handleMemoUpdated` 会连续跑 N 次
 *   `upsertSortedMemo` → N 次 `set()` → N 次 React rerender。
 *   `useExternalDocumentChangeWatch` 也会跑 N 次 `reloadDocument` →
 *   N 次 IPC + N 次 `applyLoadedContent`。
 *
 * 设计:
 * - 按 `getKey(event)` 拿到同一 memo 的 key (MemoEvent 统一走 `id` 或
 *   新建 memo 的 `memo.id`)。
 * - 同 key 在 `delay` 窗口内有新事件 → 清掉旧 timer, 用新事件覆盖
 *   pending, 重启 timer。
 * - timer 到期 → 把最后一次事件 `next()` 给下游, 清掉 pending entry。
 * - 不同 key 互不影响 (按 key 分桶)。
 * - 无 key 的事件 (理论上 MemoEvent 三种 kind 都有 key) 立即 next,
 *   不走 dedup。
 *
 * 注意: deleted 事件也走同一 key — 短窗口内 created → updated → deleted
 * 会合并成最后的 deleted, 符合"用户最终状态"的语义。
 *
 * delay 取值:
 * - 50ms — 后端 fs_watcher 150ms 防抖 + 编辑器典型 100-300ms save
 *   debounce 期间能稳定收敛 2-5 个事件。 短到 UI 看起来即时。
 * - 不要超过 200ms — 跨过这个阈值用户能感知到"列表反应慢"。
 *
 * middleware 顺序: 必须挂在最外层 (dispatch 入口处)。 后续如果加
 * filter / log 等 middleware, 它们看到的是 dedup 后的"最终事件", 不
 * 是中间事件。 这是有意的 ── filter 只关心最终状态, log 也只关心
 * 真正派发的事件。
 */

import type { DispatcherMiddleware } from '@/lib/event-dispatcher';
import type { MemoEvent } from '@/types/memo';

/**
 * 取 MemoEvent 的 dedup key。 三种 kind 都能拿到 memo id:
 * - created → e.memo.id
 * - updated → e.id
 * - deleted → e.id
 *
 * 返回 `undefined` 表示此事件不参与 dedup (立即 next)。
 */
function memoEventKey(event: MemoEvent): string | undefined {
  if (event.kind === 'created') return event.memo.id;
  if (event.kind === 'updated') return event.id;
  if (event.kind === 'deleted') return event.id;
  return undefined;
}

/**
 * 创建一个 dedup middleware 实例, 同 key 在 `delay` ms 内合并为最后一次。
 *
 * 用法 (在应用启动早期调一次):
 *
 *   import { installMemoMiddleware } from '@/lib/memo-dispatcher';
 *   import { createMemoDedupMiddleware } from '@/lib/memo-dispatcher-dedup';
 *
 *   installMemoMiddleware(createMemoDedupMiddleware({ delay: 50 }));
 */
export interface CreateMemoDedupMiddlewareOptions {
  /** 合并窗口, 默认 50ms。 */
  delay?: number;
  /** 自定义 key 提取, 默认按 MemoEvent 的 memo id。 */
  getKey?: (event: MemoEvent) => string | undefined;
}

export function createMemoDedupMiddleware(
  options: CreateMemoDedupMiddlewareOptions = {},
): DispatcherMiddleware<MemoEvent> {
  const delay = options.delay ?? 50;
  const getKey = options.getKey ?? memoEventKey;
  // key → [最后事件, timer 句柄]
  const pending = new Map<string, [MemoEvent, ReturnType<typeof setTimeout>]>();

  return (next) => (event) => {
    const key = getKey(event);
    if (!key) {
      // 无 key (理论上不会发生, 但兜底) — 立即派发。
      next(event);
      return;
    }

    if (event.kind !== 'updated') {
      const existing = pending.get(key);
      if (existing) {
        clearTimeout(existing[1]);
        pending.delete(key);
      }
      next(event);
      return;
    }

    const existing = pending.get(key);
    if (existing) {
      // 同 key 已 pending → 清旧 timer, 用新事件覆盖。
      clearTimeout(existing[1]);
    }

    const timer = setTimeout(() => {
      const slot = pending.get(key);
      if (!slot) return;
      pending.delete(key);
      next(slot[0]);
    }, delay);
    pending.set(key, [event, timer]);
  };
}
