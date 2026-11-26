'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Tooltip } from '@shared/ui/tooltip';
import { CloudStatusIcon } from '@shared/icons/cloud-status-icon';
import {
  listenToCloudSyncStatusChanges,
  type CloudSyncStatus,
} from '@platform/tauri/client';
import {
  degradedSyncState,
  selectedNotebookSyncStatuses,
  stabilizeTransferPhase,
  updateNotebookSyncFailures,
} from './sync-degradation';

interface CloudSyncStatusIndicatorProps {
  notebookId: string;
}

/** Cloud sync status displayed beside the product icon in the list title bar. */
export function CloudSyncStatusIndicator({ notebookId }: CloudSyncStatusIndicatorProps) {
  const { t } = useI18n();
  const [syncStatuses, setSyncStatuses] = useState<Map<string, CloudSyncStatus>>(() => new Map());
  const [syncFailures, setSyncFailures] = useState<ReadonlyMap<string, CloudSyncStatus>>(
    () => new Map(),
  );

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

  if (!transferDirection && !failedSync && !degradedSync) return null;

  return (
    <div className="flex h-6 shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]">
      {transferDirection && (
        <Tooltip
          side="bottom"
          content={t(transferDirection === 'upload' ? 'shell.statusBar.uploading' : 'shell.statusBar.downloading')}
        >
          <div
            className="inline-flex h-[22px] items-center px-0.5 text-xs leading-none text-[var(--muted-foreground)]"
            role="status"
            aria-live="polite"
            aria-label={t(transferDirection === 'upload' ? 'shell.statusBar.uploading' : 'shell.statusBar.downloading')}
          >
            <CloudStatusIcon status={transferDirection} size={14} className="!opacity-100" />
          </div>
        </Tooltip>
      )}
      {failedSync && (
        <Tooltip
          side="bottom"
          content={(
            <span className="block max-w-[24rem] space-y-1">
              <span className="block font-medium">{t('cloudSync.failed.title')}</span>
              <span className="block">{t('cloudSync.failed.body')}</span>
              <code className="block whitespace-pre-wrap break-words text-[11px]">
                {failedSync.lastError}
              </code>
            </span>
          )}
        >
          <div
            className="inline-flex h-[22px] items-center px-0.5 text-xs leading-none text-[var(--destructive)]"
            role="status"
            aria-live="polite"
            aria-label={t('cloudSync.failed.title')}
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          </div>
        </Tooltip>
      )}
      {degradedSync && (
        <Tooltip
          side="bottom"
          content={(
            <span className="block max-w-[15rem] space-y-0.5">
              <span className="block font-medium">
                {degradedSync === 'readOnly'
                  ? t('cloudSync.readOnly.title')
                  : t('cloudSync.deletesPaused.title')}
              </span>
              <span className="block">
                {degradedSync === 'readOnly'
                  ? t('cloudSync.readOnly.body')
                  : t('cloudSync.deletesPaused.body')}
              </span>
            </span>
          )}
        >
          <div
            className="inline-flex h-[22px] items-center px-0.5 text-xs leading-none text-[var(--warning)]"
            role="status"
            aria-live="polite"
            aria-label={
              degradedSync === 'readOnly'
                ? t('cloudSync.readOnly.title')
                : t('cloudSync.deletesPaused.title')
            }
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          </div>
        </Tooltip>
      )}
    </div>
  );
}
