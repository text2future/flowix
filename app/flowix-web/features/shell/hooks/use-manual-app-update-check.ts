'use client';

import { useCallback, useState } from 'react';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { useAppUpdater } from './use-app-updater';

export interface UseManualAppUpdateCheckOptions {
  afterCheck?: () => Promise<void>;
}

export function useManualAppUpdateCheck({ afterCheck }: UseManualAppUpdateCheckOptions = {}) {
  const { t } = useI18n();
  const updater = useAppUpdater();
  const [promptOpen, setPromptOpen] = useState(false);

  const checkNow = useCallback(async () => {
    try {
      const update = await updater.checkNow();
      await afterCheck?.();
      if (update) setPromptOpen(true);
      else toast.info(t('preferences.general.productUpdates.none'));
    } catch {
      toast.error(t('preferences.general.productUpdates.failed'));
    }
  }, [afterCheck, t, updater.checkNow]);

  const downloadNow = useCallback(async () => {
    setPromptOpen(false);
    try {
      await updater.downloadNow();
    } catch {
      toast.error(t('appUpdates.downloadFailed'));
    }
  }, [t, updater.downloadNow]);

  return { updater, promptOpen, setPromptOpen, checkNow, downloadNow };
}
