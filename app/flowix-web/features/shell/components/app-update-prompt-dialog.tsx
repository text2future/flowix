'use client';

import type { AppUpdate } from '@platform/tauri/client/updater';
import { Button } from '@shared/ui/button';
import { DialogFooter } from '@shared/ui/dialog-footer';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import { useI18n } from '@/lib/i18n';

export interface AppUpdatePromptDialogProps {
  open: boolean;
  update: AppUpdate | null;
  onOpenChange: (open: boolean) => void;
  onDownload: () => void;
}

export function AppUpdatePromptDialog({
  open,
  update,
  onOpenChange,
  onDownload,
}: AppUpdatePromptDialogProps) {
  const { t } = useI18n();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px]">
        {update && (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('appUpdates.available', { version: update.version.replace(/^v/i, '') })}
              </DialogTitle>
              {update.body && (
                <DialogDescription className="max-h-[60vh] overflow-y-auto whitespace-pre-line leading-6">
                  {update.body}
                </DialogDescription>
              )}
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t('appUpdates.abandon')}
              </Button>
              <Button type="button" onClick={onDownload}>
                {t('appUpdates.download')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
