import { useEffect, useState } from 'react';
import { ArrowUp, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '@/lib/i18n';
import { Button } from '@shared/ui/button';
import { DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { UpdateProgress } from '@shared/ui/update-progress';
import { FloatingPrompt } from '@features/shell/components/floating-prompt';
import type { AppUpdaterState } from '@features/shell/public/system-api';

export function AppUpdatePrompt({ updater }: { updater: AppUpdaterState }) {
  const { t } = useI18n();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [installError, setInstallError] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const update = updater.update;
  const isDownloading = updater.status === 'downloading';
  const isInstalling = updater.status === 'installing';
  const isUpdating = isDownloading || isInstalling;

  useEffect(() => {
    if (update?.version && update.version !== dismissedVersion) setInstallError(false);
  }, [dismissedVersion, update?.version]);

  if (!update || !update.notify || (updater.status !== 'available' && !isUpdating) || update.version === dismissedVersion) {
    return null;
  }

  const handleInstall = async () => {
    setInstallError(false);
    try {
      await updater.installNow();
    } catch {
      setInstallError(true);
    }
  };

  const handleCancel = async () => {
    if (isCancelling) return;
    setIsCancelling(true);
    try {
      if (isUpdating) await updater.cancelNow();
      setDismissedVersion(update.version);
    } finally {
      setIsCancelling(false);
    }
  };

  const downloadPercent = updater.progress?.phase === 'progress' && updater.progress.contentLength
    ? Math.min(100, Math.round((updater.progress.downloadedBytes / updater.progress.contentLength) * 100))
    : null;

  return (
    <FloatingPrompt open onClose={() => void handleCancel()} className="p-0">
      <div className="px-5 py-5 text-left">
        <DialogHeader className="mb-0">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[color-mix(in_oklch,var(--primary)_12%,transparent)] text-[var(--primary)]">
            <ArrowUp className="h-7 w-7" aria-hidden="true" />
          </div>
          <DialogTitle className="mt-3 text-base">
            {t('appUpdates.available')} v{update.version.replace(/^v/i, '')}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-1 max-h-48 overflow-y-auto text-xs leading-5 text-[var(--muted-foreground)]">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
              ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-5">{children}</ul>,
              ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-5">{children}</ol>,
              li: ({ children }) => <li className="pl-0.5">{children}</li>,
            }}
          >
            {update.body || t('appUpdates.description')}
          </ReactMarkdown>
        </div>
        {isUpdating && updater.progress && (
          <UpdateProgress
            className="mt-5"
            value={{
              percent: downloadPercent,
              downloadedBytes: updater.progress.phase === 'progress' ? updater.progress.downloadedBytes : undefined,
              totalBytes: updater.progress.phase === 'progress' ? updater.progress.contentLength : undefined,
            }}
            label={t(isDownloading ? 'appUpdates.downloading' : 'appUpdates.installing')}
          />
        )}
        {installError && <p className="mt-3 text-xs text-[var(--destructive)]">{t('appUpdates.installFailed')}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => void handleCancel()} disabled={isCancelling}>
            {t('dialog.cancel')}
          </Button>
          <Button type="button" onClick={() => void handleInstall()} disabled={isUpdating}>
            {isUpdating && <Loader2 className="h-4 w-4 animate-spin" />}
            {isDownloading ? t('appUpdates.downloading') : isInstalling ? t('appUpdates.installing') : t('appUpdates.install')}
          </Button>
        </div>
      </div>
    </FloatingPrompt>
  );
}
