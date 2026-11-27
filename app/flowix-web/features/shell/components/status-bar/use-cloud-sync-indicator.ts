'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { cloudSyncErrorMessage } from '@platform/tauri/errors';
import { cloud, listenToCloudStateChanges,
  listenToCloudStorageAccessChanges, listenToCloudSyncStatusChanges,
  type CloudSyncStatus } from '@platform/tauri/client';
import { openCloudLoginDialog } from '@features/preferences/public/cloud-login-dialog';
import { enableNotebookSync } from '@features/shell/services/enable-notebook-sync';
import { windows } from '@platform/tauri/client';
import { degradedSyncState, selectedNotebookSyncStatuses, stabilizeTransferPhase,
  updateNotebookSyncFailures } from './sync-degradation';

export function useCloudSyncIndicator(notebookId: string) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const currentNotebookId = useRef<string | null>(notebookId);
  currentNotebookId.current = notebookId;
  const enablingRef = useRef(false);
  useEffect(() => {
    currentNotebookId.current = notebookId;
    return () => {
      if (currentNotebookId.current === notebookId) currentNotebookId.current = null;
    };
  }, [notebookId]);
  const [syncStatuses, setSyncStatuses] = useState<Map<string, CloudSyncStatus>>(() => new Map());
  const [syncFailures, setSyncFailures] = useState<ReadonlyMap<string, CloudSyncStatus>>(
    () => new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    setEnabled(null);
    setEnabling(false);
    setPromptOpen(false);
    const refresh = () => {
      const current = ++generation;
      void cloud.getNotebookState(notebookId).then((state) => {
        if (!cancelled && current === generation) setEnabled(state?.enabled ?? false);
      }).catch((error) => console.warn('[CloudSync] Failed to load notebook state:', error));
    };
    refresh();
    const unlistenState = listenToCloudStateChanges(refresh);
    const unlistenStorage = listenToCloudStorageAccessChanges(refresh);
    return () => { cancelled = true; unlistenState(); unlistenStorage(); };
  }, [notebookId]);

  const enableSync = async () => {
    const targetId = notebookId;
    const isCurrent = () => currentNotebookId.current === targetId;
    if (!isCurrent() || enablingRef.current) return;
    enablingRef.current = true;
    setEnabling(true);
    try {
      const result = await enableNotebookSync(targetId, isCurrent);
      if (result === 'cancelled') return;
      if (result === 'login') {
        setPromptOpen(false);
        await openCloudLoginDialog(() => { if (isCurrent()) void enableSync(); });
        return;
      }
      if (result === 'storage') {
        setPromptOpen(false);
        await windows.openPreferences('cloudSync');
        return;
      }
      setEnabled(true);
      setPromptOpen(false);
      void cloud.syncNow(targetId).catch((error) => toast.error(cloudSyncErrorMessage(error, t)));
    } catch (error) {
      if (isCurrent()) toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      enablingRef.current = false;
      if (isCurrent()) setEnabling(false);
    }
  };

  const handleUseLocally = async () => {
    setEnabling(true);
    try {
      await cloud.setNotebookEnabled(notebookId, false);
      setPromptOpen(false);
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setEnabling(false);
    }
  };

  useEffect(() => {
    return listenToCloudSyncStatusChanges((status) => {
      setSyncFailures((previous) => updateNotebookSyncFailures(previous, status));
      setSyncStatuses((previous) => {
        const current = previous.get(status.notebookId);
        if (current && status.startedAt < current.startedAt) return previous;
        const next = new Map(previous);
        next.set(status.notebookId, stabilizeTransferPhase(current, status));
        return next;
      });
    });
  }, []);

  const currentSyncStatuses = selectedNotebookSyncStatuses(syncStatuses, notebookId);
  const transferDirection = currentSyncStatuses.find((status) =>
    status.state === 'syncing' && (status.phase === 'upload' || status.phase === 'download'),
  )?.phase as 'upload' | 'download' | undefined;
  // Successful passes can still be read-only or defer deletes, so display the
  // engine's health flags independently from the transfer state.
  const degradedSync = degradedSyncState(currentSyncStatuses);
  const failedSync = syncFailures.get(notebookId);

  const retrySync = async () => {
    setRetrying(true);
    try {
      await cloud.syncNow(notebookId);
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setRetrying(false);
    }
  };

  return { enabled, promptOpen, setPromptOpen, enabling, retrying, enableSync,
    handleUseLocally, transferDirection, degradedSync, failedSync, retrySync };
}
