'use client';

import { PopupScrollArea } from '@shared/ui/popup-scroll-area';

import { ArrowCircleUpIcon } from '@phosphor-icons/react';
import type { AppUpdaterState } from '@features/shell/hooks/use-app-updater';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { Tooltip } from '@shared/ui/tooltip';
import type { RefObject } from 'react';

/** Status-bar action that installs the prepared app update. */
export function ProductUpdatePill({
  updater,
  anchor,
}: {
  updater: AppUpdaterState;
  anchor?: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  const { status, update } = updater;

  if (!update || !update.notify || (status !== 'ready' && status !== 'installing')) {
    return null;
  }

  const versionLabel = t('appUpdates.statusBarVersion', {
    version: update.version.replace(/^v/i, ''),
  });
  const statusBarLabel = t('appUpdates.statusBarLabel');
  const updateDescription = (
    <div className="block w-72 max-w-[calc(100vw-2rem)] space-y-1.5">
      <span className="block font-medium">{versionLabel}</span>
      {update.body && (
        <PopupScrollArea className="max-h-52" scrollerClassName="whitespace-pre-line text-[var(--muted-foreground)]">
          {update.body}
        </PopupScrollArea>
      )}
    </div>
  );
  const rightEdgeAnchor = anchor
    ? () => ({
        contextElement: anchor.current ?? undefined,
        getBoundingClientRect: () => {
          const statusBarRect = anchor.current?.getBoundingClientRect();
          const viewportRight = document.documentElement.clientWidth - 8;
          const right = Math.min(statusBarRect?.right ?? viewportRight, viewportRight);
          const top = statusBarRect?.top ?? window.innerHeight;
          return new DOMRect(right, top, 0, 0);
        },
      })
    : undefined;
  const isUpdating = status === 'installing';

  return (
    <Tooltip
      content={updateDescription}
      side="top"
      align="end"
      anchor={rightEdgeAnchor}
      positionMethod="fixed"
      sideOffset={8}
      className="flex-col items-start gap-0 rounded-xl border border-[var(--border)] bg-[var(--popover)] p-3 text-sm text-[var(--popover-foreground)] shadow-[0_0_16px_-3px_rgba(0,0,0,0.14)]"
    >
      <button
        type="button"
        onClick={() => {
          void updater.installNow().catch(() => {
            toast.error(t('appUpdates.installFailed'));
          });
        }}
        disabled={isUpdating}
        className="inline-flex h-[22px] items-center justify-center gap-1 rounded-md px-2 text-xs leading-none text-[var(--primary)] hover:bg-[var(--muted)]"
        aria-label={versionLabel}
      >
        {isUpdating
          ? <DownloadProgressIcon progress={updater.progress} />
          : <ArrowCircleUpIcon className="h-[18px] w-[18px]" weight="fill" aria-hidden="true" />}
        <span>{statusBarLabel}</span>
      </button>
    </Tooltip>
  );
}

function DownloadProgressIcon({ progress }: { progress: AppUpdaterState['progress'] }) {
  let hasProgress = false;
  let percent = 0;
  if (progress?.phase === 'progress' && progress.contentLength && progress.contentLength > 0) {
    hasProgress = true;
    percent = Math.min(1, Math.max(0, progress.downloadedBytes / progress.contentLength));
  }
  const radius = 9;
  const circumference = 2 * Math.PI * radius;

  return (
    <svg
      aria-hidden="true"
      className={`h-[18px] w-[18px] shrink-0${hasProgress ? '' : ' flowix-spin'}`}
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.24" strokeWidth="3" />
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="3"
        strokeDasharray={hasProgress ? circumference : `${circumference * 0.28} ${circumference * 0.72}`}
        strokeDashoffset={hasProgress ? circumference * (1 - percent) : 0}
        transform="rotate(-90 12 12)"
      />
    </svg>
  );
}
