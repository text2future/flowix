import { useEffect } from 'react';
import { useAppUpdaterStore, type AppUpdaterState } from '@features/shell/store/app-updater-store';
import { runStartupStage3Task, waitForStartupStage3 } from '@/lib/startup-stage3';

export type { AppUpdaterStatus, AppUpdaterState } from '@features/shell/store/app-updater-store';

interface UseAppUpdaterOptions {
  autoCheck?: boolean;
  enabled?: boolean;
  delayMs?: number;
}

export function useAppUpdater({
  autoCheck = false,
  enabled = true,
  delayMs = 3_600,
}: UseAppUpdaterOptions = {}): AppUpdaterState {
  const updater = useAppUpdaterStore();
  const checkNow = updater.checkNow;

  useEffect(() => {
    if (!autoCheck || !enabled) return;
    let cancelled = false;
    let timer: number | undefined;
    void waitForStartupStage3().then(() => {
      if (cancelled) return;
      timer = window.setTimeout(() => {
        if (cancelled) return;
        void runStartupStage3Task('app-update-auto-check', async () => {
          if (cancelled || useAppUpdaterStore.getState().checkStarted) return;
          try {
            await checkNow();
          } catch {
            // Automatic check failures stay silent.
          }
        });
      }, delayMs);
    });
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [autoCheck, enabled, delayMs, checkNow]);

  return updater;
}
