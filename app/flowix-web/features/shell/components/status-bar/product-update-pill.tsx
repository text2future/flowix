'use client';

import type { AppUpdaterState } from '@features/shell/hooks/use-app-updater';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

/** Compact signed-app-update CTA for the desktop status bar. */
export function ProductUpdatePill({ updater }: { updater: AppUpdaterState }) {
  const { t } = useI18n();
  const { status, update, installNow } = updater;

  async function handleClick() {
    if (!update || status === 'downloading' || status === 'installing') return;
    try {
      await installNow();
    } catch {
      toast.error(t('appUpdates.installFailed'));
    }
  }

  if (!update || !update.notify || status === 'error' || status === 'none' || status === 'idle' || status === 'checking') {
    return null;
  }

  const downloading = status === 'downloading';
  const installing = status === 'installing';
  const contentLength = updater.progress && 'contentLength' in updater.progress
    ? updater.progress.contentLength
    : undefined;
  const downloadedBytes = updater.progress && 'downloadedBytes' in updater.progress
    ? updater.progress.downloadedBytes
    : undefined;
  const percent = downloading && contentLength && contentLength > 0 && downloadedBytes != null
    ? Math.min(100, Math.max(0, Math.round((downloadedBytes / contentLength) * 100)))
    : null;
  const label = downloading
    ? percent == null
      ? t('appUpdates.statusDownloading')
      : t('appUpdates.statusDownloadingProgress').replace('{percent}', String(percent))
    : installing
      ? t('appUpdates.statusInstalling')
      : t('appUpdates.install');

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={downloading || installing}
      title={`${t('appUpdates.available')}: ${update.version}`}
      className={cn(
        'inline-flex h-[22px] items-center gap-0.5 rounded-md px-2',
        'text-xs leading-none text-[var(--primary)] hover:bg-[var(--muted)]',
        'disabled:cursor-wait',
      )}
      aria-label={label}
    >
      <UpdateProgressIcon percent={percent ?? (installing ? 100 : 0)} spinning={downloading && percent == null} />
      <span>{label}</span>
    </button>
  );
}

function UpdateProgressIcon({ percent, spinning }: { percent: number; spinning: boolean }) {
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.min(100, Math.max(0, percent)) / 100;

  return (
    <svg
      aria-hidden="true"
      className={`h-3.5 w-3.5 shrink-0${spinning ? ' animate-spin' : ''}`}
      viewBox="0 0 12 12"
    >
      <circle
        cx="6"
        cy="6"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="1.5"
      />
      <circle
        cx="6"
        cy="6"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - progress)}
        transform="rotate(-90 6 6)"
      />
    </svg>
  );
}
