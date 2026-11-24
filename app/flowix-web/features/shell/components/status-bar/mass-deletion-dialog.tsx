'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@shared/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { cloud } from '@/platform/tauri/client/cloud';

interface MassDeletionDialogProps {
  notebookId: string | null | undefined;
  /** Paths whose local copies would be deleted (the cloud already deleted them). */
  localCount: number;
  /** Paths whose cloud copies would be deleted (they are gone from this device). */
  remoteCount: number;
}

/**
 * The one place a bulk deletion asks for a decision.
 *
 * A pass cannot tell a deliberate "delete this folder" from a scan or a listing
 * that lost half the notebook, so anything that large waits here: nothing is
 * deleted on either side until the user answers. Both answers are cheap — no
 * data has moved yet — which is why the engine defers instead of guessing.
 */
export function MassDeletionDialog({ notebookId, localCount, remoteCount }: MassDeletionDialogProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  // The batch the user already dismissed. Keyed by counts so a *different*
  // batch (more files, or the other direction) asks again instead of inheriting
  // the answer to a question it never saw.
  const [dismissed, setDismissed] = useState<string | null>(null);

  const total = localCount + remoteCount;
  const signature = `${notebookId ?? ''}:${localCount}:${remoteCount}`;
  const open = Boolean(notebookId) && total > 0 && dismissed !== signature;

  // A finished pass replaces the counts; keeping the old signature would hide
  // the dialog for a batch that is now a different one.
  const lastSignature = useRef(signature);
  useEffect(() => {
    if (lastSignature.current !== signature) {
      lastSignature.current = signature;
      setDismissed(null);
    }
  }, [signature]);

  const resolve = useCallback(
    async (restore: boolean) => {
      if (!notebookId) return;
      setBusy(true);
      try {
        await cloud.resolveMassDeletion(notebookId, restore);
        setDismissed(signature);
      } catch (error) {
        // `CLOUD_MASS_DELETION_GONE` means another pass resolved the batch while
        // this dialog was open: closing it is the right answer, not an error.
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('CLOUD_MASS_DELETION_GONE')) {
          toast.error(message);
        }
        setDismissed(signature);
      } finally {
        setBusy(false);
      }
    },
    [notebookId, signature],
  );

  if (!open) return null;

  const body = localCount > 0 && remoteCount > 0
    ? t('cloudSync.massDeletion.bodyBoth', { count: total })
    : localCount > 0
      ? t('cloudSync.massDeletion.bodyLocal', { count: localCount })
      : t('cloudSync.massDeletion.bodyRemote', { count: remoteCount });

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) setDismissed(signature); }}>
      <DialogContent className="max-w-md">
        <DialogTitle>{t('cloudSync.massDeletion.title')}</DialogTitle>
        <DialogDescription className="pt-2">{body}</DialogDescription>
        <p className="pt-3 text-xs text-[var(--destructive)]">
          {t('cloudSync.massDeletion.warning')}
        </p>
        <div className="flex justify-end gap-2 pt-5">
          <Button variant="outline" disabled={busy} onClick={() => void resolve(true)}>
            {t('cloudSync.massDeletion.restore')}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void resolve(false)}>
            {t('cloudSync.massDeletion.confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
