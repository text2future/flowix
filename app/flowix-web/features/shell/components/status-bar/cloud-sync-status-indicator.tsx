'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { Tooltip } from '@shared/ui/tooltip';
import { SyncCloudIcon } from '@shared/icons/sync-cloud-icon';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { cloudSyncFailureKey } from './cloud-sync-error';
import { useCloudSyncIndicator } from './use-cloud-sync-indicator';

interface CloudSyncStatusIndicatorProps {
  notebookId: string;
}

/** Keep the last content mounted until its opacity transition finishes. */
function FadingStatus({ active, children, fallback }: { active: boolean; children: ReactNode; fallback: ReactNode }) {
  const [present, setPresent] = useState(active);
  const [visible, setVisible] = useState(false);
  const lastFallback = useRef(fallback);
  if (active) lastFallback.current = fallback;

  useEffect(() => {
    if (active) {
      setPresent(true);
      const frame = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(frame);
    }
    // Sync can briefly report no transfer between consecutive passes. Keep the
    // icon visible through that gap so one operation does not flash repeatedly.
    const fadeTimer = setTimeout(() => setVisible(false), 300);
    const removeTimer = setTimeout(() => setPresent(false), 600);
    return () => { clearTimeout(fadeTimer); clearTimeout(removeTimer); };
  }, [active]);

  if (!present && !active) return null;
  return (
    <div className={`flex items-center gap-0.5 text-[var(--muted-foreground)] transition-opacity duration-300 motion-reduce:transition-none ${visible ? 'opacity-100' : 'opacity-0'} ${active ? '' : 'pointer-events-none'}`}
      aria-hidden={!active || undefined} inert={!active || undefined}>
      {active ? children : lastFallback.current}
    </div>
  );
}

/** Cloud sync status displayed beside the product icon in the list title bar. */
export function CloudSyncStatusIndicator({ notebookId }: CloudSyncStatusIndicatorProps) {
  const { t } = useI18n();
  const { enabled, promptOpen, setPromptOpen, enabling, retrying, enableSync,
    handleUseLocally, transferDirection, degradedSync, failedSync, retrySync } = useCloudSyncIndicator(notebookId);

  const active = enabled === false || !!transferDirection || !!failedSync || !!degradedSync;
  const fallback = (
    <>
      {enabled === false && <SyncCloudIcon variant="off" className="mx-0.5 h-[18px] w-[18px] opacity-60" />}
      {transferDirection && <SyncCloudIcon variant="cloud" className="mx-0.5 h-[18px] w-[18px] opacity-60" />}
      {failedSync && <SyncCloudIcon variant="alert" className="mx-0.5 h-[18px] w-[18px] opacity-60" />}
      {degradedSync && <SyncCloudIcon variant="alert" className="mx-0.5 h-[18px] w-[18px] text-[var(--warning)] opacity-60" />}
    </>
  );

  return (
    <div className="flex h-6 shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]">
      <FadingStatus key={notebookId} active={active} fallback={fallback}>
        {enabled === false && (
          <Tooltip side="bottom" content={t('cloudSync.disabled.title')}>
            <button type="button" onClick={() => setPromptOpen(true)}
              className="inline-flex h-[22px] items-center px-0.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              aria-label={t('cloudSync.disabled.title')}>
              <SyncCloudIcon variant="off" className="h-[18px] w-[18px] opacity-60" />
            </button>
          </Tooltip>

        )}
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
            <SyncCloudIcon variant="cloud" className="h-[18px] w-[18px] opacity-60" />
          </div>
        </Tooltip>
      )}
      {failedSync && (
        <Popover>
          <span className="sr-only" role="status" aria-live="polite">{t('cloudSync.failed.title')}</span>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex h-[22px] items-center px-0.5 text-xs leading-none text-[var(--muted-foreground)]"
              aria-label={t('cloudSync.failed.title')}
              title={t('cloudSync.failed.title')}
            >
              <SyncCloudIcon variant="alert" className="h-[18px] w-[18px] shrink-0 opacity-60" />
            </button>
          </PopoverTrigger>
          <PopoverContent side="bottom" align="start" className="w-64 max-w-[calc(100vw-2rem)] rounded-xl border-[var(--border-popup)] p-3 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]" aria-label={t('cloudSync.failed.title')}>
            <div className="space-y-1.5">
              <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">{t(cloudSyncFailureKey(failedSync?.lastError ?? ''))}</p>
              <Button size="sm" variant="outline" className="rounded-lg" disabled={retrying} onClick={() => void retrySync()}>
                {t(retrying ? 'cloudSync.failed.retrying' : 'cloudSync.failed.retry')}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
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
            <SyncCloudIcon variant="alert" className="h-[18px] w-[18px] shrink-0 opacity-60" />
          </div>
        </Tooltip>
      )}
      </FadingStatus>
      <Dialog open={promptOpen} onOpenChange={setPromptOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('cloudSync.disabled.prompt')}</DialogTitle>
                <DialogDescription>{t('cloudSync.disabled.description')}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" disabled={enabling} onClick={() => void handleUseLocally()}>{t('cloudSync.disabled.local')}</Button>
                <Button disabled={enabling} onClick={() => void enableSync()}>{t('cloudSync.disabled.enable')}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
    </div>
  );
}
