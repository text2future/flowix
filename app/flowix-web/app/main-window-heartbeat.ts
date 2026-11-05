import { windows } from '@platform/tauri/client';

/** Four missed beats is the native stall threshold (8s), so keep them in sync. */
export const HEARTBEAT_INTERVAL_MS = 2000;

type HeartbeatTarget = Pick<typeof windows, 'reportUiHeartbeat'>;

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

/**
 * Renderer liveness probe, diagnostics only.
 *
 * The native side records `window.renderer.stalled` when a visible, restored
 * window stops reporting. Nothing is retried, reloaded or recovered here: the
 * probe must never influence what the user sees. Beats stop while the window is
 * hidden so a minimized app is not reported as stalled.
 */
export function mountMainWindowHeartbeat(
  target: HeartbeatTarget = windows,
): () => void {
  if (!isTauriRuntime()) return () => {};
  let timer: ReturnType<typeof setInterval> | undefined;

  const report = (hidden: boolean) => {
    void target.reportUiHeartbeat(hidden).catch(() => {});
  };
  const stop = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const start = () => {
    stop();
    report(false);
    timer = setInterval(() => report(false), HEARTBEAT_INTERVAL_MS);
  };
  const handleVisibility = () => {
    // The final hidden beat tells the native side this silence is expected.
    if (document.visibilityState === 'visible') start();
    else {
      stop();
      report(true);
    }
  };

  if (document.visibilityState === 'visible') start();
  document.addEventListener('visibilitychange', handleVisibility);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', handleVisibility);
  };
}
