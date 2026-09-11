import { useCallback, useEffect, useState } from 'react';
import { boot, dshIntegration, type DshDownloadProgress } from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import { useAppUpdatePreferences } from '@features/preferences/public/app-api';
import {
  useDshRuntimeInstaller,
  type DshRuntimeInstallerState,
} from '@features/preferences/public/system-api';
import {
  useAppUpdater,
  type AppUpdaterState,
} from '@features/shell/public/system-api';
import { createLogger } from '@/lib/logger';

const logger = createLogger('main-window-system-controller');

function isActiveDshDownload(progress: DshDownloadProgress | null): boolean {
  return progress?.phase === 'checking'
    || progress?.phase === 'downloading'
    || progress?.phase === 'downloaded'
    || progress?.phase === 'installing';
}

export interface MainWindowSystemController {
  dshDownload: DshDownloadProgress | null;
  dshInstallPromptOpen: boolean;
  updater: AppUpdaterState;
  dshInstaller: DshRuntimeInstallerState;
  closeDshInstallPrompt(): void;
  markDshIntroDisplayed(): void;
  completeDshInstallPrompt(): void;
}

export function useMainWindowSystemController(): MainWindowSystemController {
  const [dshDownload, setDshDownload] = useState<DshDownloadProgress | null>(null);
  const [dshInstallPromptOpen, setDshInstallPromptOpen] = useState(false);
  const updatePreferences = useAppUpdatePreferences();
  const updater = useAppUpdater({
    autoCheck: !updatePreferences.loading,
    enabled: updatePreferences.enabled,
  });
  const dshInstaller = useDshRuntimeInstaller();

  useEffect(() => {
    const applyProgress = (progress: DshDownloadProgress) => {
      setDshDownload(isActiveDshDownload(progress) ? progress : null);
    };
    const unsubscribe = subscribe<DshDownloadProgress>('dsh-download-progress', applyProgress);
    void dshIntegration.downloadStatus()
      .then((progress) => {
        if (progress) applyProgress(progress);
      })
      .catch(() => {
        // Preferences remains the detailed recovery surface.
      });
    return unsubscribe;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void boot.getFeatures().then((features) => {
      if (!cancelled && !features.isIntroductDisplayed) setDshInstallPromptOpen(true);
    }).catch(() => {
      // Do not show onboarding when its durable state cannot be read.
    });
    return () => { cancelled = true; };
  }, []);

  const markDshIntroDisplayed = useCallback(() => {
    void boot.setIntroDisplayed().catch((error) => {
      logger.warn('persist DSH intro display state failed', { error });
    });
  }, []);

  const closeDshInstallPrompt = useCallback(() => {
    markDshIntroDisplayed();
    setDshInstallPromptOpen(false);
  }, [markDshIntroDisplayed]);

  return {
    dshDownload,
    dshInstallPromptOpen,
    updater,
    dshInstaller,
    closeDshInstallPrompt,
    markDshIntroDisplayed,
    completeDshInstallPrompt: () => setDshInstallPromptOpen(false),
  };
}
