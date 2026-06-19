/**
 * 跨窗口单订阅者 — 监听后端 `flowix:open-target` 事件, 由 App.tsx 顶层挂。
 *
 * 设计:
 *   - 单 listener, 模块级 singleton unlisten (跟 `listenToAgentStream` /
 *     `listenToUserConfigChanges` 同形, 避免 React StrictMode 双挂
 *     堆 listener)。
 *   - 两个 webview (主窗口 / 偏好窗口) 各自挂自己的 listener 实例, 但
 *     **只有主窗口真正打开** — preferences 窗口只用来配置, 不持有 memo-list
 *     状态, 收到后 no-op。
 *   - document-store 的 enqueueTransition 已经做串行化, 同一时刻多次深链
 *     触发自动按序处理 (新值覆盖旧 session, 不重叠)。
 */

import { subscribe, type UnlistenFn } from '../tauri/event-bus';

import { openNoteByTarget } from './opener';
import { FLOWIX_OPEN_TARGET_EVENT, type ResolvedOpenTarget } from './types';

// 单 listener 起着作用 — App.tsx 顶层调 mount, 窗口卸载调 unmount。
// 严格说应该以单个 UnlistenFn 走 useEffect cleanup (同 useMemoEvents),
// 但为了少动 App.tsx, 保留现有 mount/unmount 类 API。 同一窗口
// 多次 mount 会让旧 UnlistenFn 走 unmount, 随后重挂 (同原 listen + unlisten
// 模式)。
let currentUnlisten: UnlistenFn | null = null;

/**
 * 在主窗口 (非 preferences) 才有意义 — 偏好窗口收到事件后 no-op。
 */
function isMainWindow(): boolean {
  return !window.location.hash.startsWith('#preferences');
}

/**
 * App.tsx 顶层调用。 挂全局单订阅者 (event-bus 里同一事件
 * 只挂一份 Tauri listener, 不会堆积)。 HMR / StrictMode 双挂场景下,
// 重复挂载会先 unlisten 旧的再重挂。
 */
export function mountOpenTargetListener(): void {
  if (currentUnlisten) {
    currentUnlisten();
    currentUnlisten = null;
  }
  currentUnlisten = subscribe<ResolvedOpenTarget>(FLOWIX_OPEN_TARGET_EVENT, (payload) => {
    if (!isMainWindow()) return;
    void openNoteByTarget(payload).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[openByTarget] listener open failed:', err);
    });
  });
}

export function unmountOpenTargetListener(): void {
  if (currentUnlisten) {
    currentUnlisten();
    currentUnlisten = null;
  }
}
