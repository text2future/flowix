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
// 启动时 reconcile 一次后端 `agent_running_threads`: 后端快照是运行态
// 真源。它既能补齐漏掉的 stream_start, 也能清掉本地残留的 running 标记,
// 并同步 Agent conversation instances 给状态栏 / memo 列表消费。

import { useEffect } from 'react';

import { useChatStore, installAgentChunkBridge } from '@features/agent/store/chat-store';

export function useAgentEvents(): void {
  useEffect(() => {
    let disposed = false;
    let lastReconcileAt = 0;

    const reconcileRunningRuns = async () => {
      if (disposed) return;
      const now = Date.now();
      if (now - lastReconcileAt < 1000) return;
      lastReconcileAt = now;
      await useChatStore.getState().reconcileRunningRuns();
    };

    // 启动单例 listener ── 把 chunk 派发到 store。 该函数内部对
    // listenToAgentStream 做幂等保护 (检查 streamUnlisten 不空就跳过
    // 注册), 所以两窗口同时调 installAgentChunkBridge 也只挂一次。
    installAgentChunkBridge();

    // 启动时拉一次 in-flight thread 集合, seed 到 store。 fire-and-forget,
    // 失败仅 console.warn, 不影响首屏渲染。
    (async () => {
      try {
        await reconcileRunningRuns();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[useAgentEvents] agent_running_threads failed:', err);
      }
    })();

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      void reconcileRunningRuns().catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[useAgentEvents] agent_running_threads failed:', err);
      });
    };
    const handleFocus = () => {
      void reconcileRunningRuns().catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[useAgentEvents] agent_running_threads failed:', err);
      });
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      disposed = true;
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      // 不在这里 unlisten ── listener 是模块级单例, 跨组件 / 跨窗口
      // 共享; 组件 unmount (e.g. 路由切到 preferences 视图) 不该把
      // 主窗口的 listener 也卸了。 进程退出时由 Tauri 自己清理。
    };
  }, []);
}
