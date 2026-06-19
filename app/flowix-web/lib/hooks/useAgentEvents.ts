// 后端 `agent-chunk` 事件总线的前端单订阅者 — 挂在 App.tsx 顶层, 让主
// 窗口和偏好设置窗口都同步 (与 `useMemoEvents` 同形)。 事件按
// `thread_id` 派发到 chat-store 的 `dispatchAgentChunk` action, store
// 负责按 thread_id 写入 `threadStates[tid]`, 不在这里做任何业务判断。
//
// 背景多 chat 并行: 一个 listener 永远在; 多个 thread 同时跑时, chunk
// 自带 `thread_id` 自然分流到对应 ThreadState, 互不串台。 listener
// 模块级单例 (在 `installAgentChunkBridge` 里做幂等保护), 重复挂载
// 安全 (e.g. StrictMode / HMR)。
//
// 启动时 `seedRunningThreads` 拉一次后端 `agent_running_threads`, 把
// 重启前 in-flight 的 thread 标 isLoading=true, 让 UI 在进程重启后
// 仍能看到后台运行状态 (后端 `cancel_flags` 在重启时清空, 这里只是
// 恢复 in-memory store 视觉一致; 真源是 SQLite 磁盘上的 in-progress
// 工具行, 已经被 lib.rs::clear_all_loading 兜底归零, 所以即便后端
// in-flight 全没了 UI 也不会展示虚假状态 ── 顶多几条 `startedAt` 残留
// 不显示, 后续 chunk 不来, 圆点不会误导用户)。

import { useEffect } from 'react';

import { agent } from '../tauri/client';
import { useChatStore, installAgentChunkBridge } from '../store/chat-store';

export function useAgentEvents(): void {
  useEffect(() => {
    let disposed = false;

    // 启动单例 listener ── 把 chunk 派发到 store。 该函数内部对
    // listenToAgentStream 做幂等保护 (检查 streamUnlisten 不空就跳过
    // 注册), 所以两窗口同时调 installAgentChunkBridge 也只挂一次。
    installAgentChunkBridge();

    // 启动时拉一次 in-flight thread 集合, seed 到 store。 fire-and-forget,
    // 失败仅 console.warn, 不影响首屏渲染。
    (async () => {
      try {
        const running = await agent.runningThreads();
        if (!disposed) {
          useChatStore.getState().seedRunningThreads(running);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[useAgentEvents] agent_running_threads failed:', err);
      }
    })();

    return () => {
      disposed = true;
      // 不在这里 unlisten ── listener 是模块级单例, 跨组件 / 跨窗口
      // 共享; 组件 unmount (e.g. 路由切到 preferences 视图) 不该把
      // 主窗口的 listener 也卸了。 进程退出时由 Tauri 自己清理。
    };
  }, []);
}
