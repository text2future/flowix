import { useEffect } from 'react';

import { useChatStore, installAgentChunkBridge } from '@features/agent/store/chat-store';

/**
 * Installs the agent stream bridge for windows that need live chat updates.
 *
 * This is mounted from the main-window effects layer, not from the preferences
 * window. The bridge itself is idempotent, so repeated mounts inside the same
 * WebView are safe.
 */
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

    installAgentChunkBridge();

    (async () => {
      try {
        await reconcileRunningRuns();
      } catch (err) {
        console.warn('[useAgentEvents] agent_running_threads failed:', err);
      }
    })();

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      void reconcileRunningRuns().catch((err) => {
        console.warn('[useAgentEvents] agent_running_threads failed:', err);
      });
    };
    const handleFocus = () => {
      void reconcileRunningRuns().catch((err) => {
        console.warn('[useAgentEvents] agent_running_threads failed:', err);
      });
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      disposed = true;
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      // Do not unlisten from the stream bridge here; it is module-level and
      // shared by this WebView for the lifetime of the process.
    };
  }, []);
}
