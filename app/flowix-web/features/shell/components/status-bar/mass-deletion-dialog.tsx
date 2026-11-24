'use client';

import { useCallback, useReducer, useState } from 'react';

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
 * Answers already given or closed, per notebook.
 *
 * Outside the component on purpose: the status bar re-renders and this dialog
 * unmounts whenever the notebook selection changes, and a question the user
 * closed must not come back because of that. Session storage rather than a
 * module-level map so a reload keeps the answer — still the same stretch of
 * work — while a new window starts clean.
 */
const ANSWER_KEY = 'flowix.mass-deletion.answered';

function readAnswer(notebookId: string): string | null {
  try {
    return window.sessionStorage.getItem(`${ANSWER_KEY}:${notebookId}`);
  } catch {
    return null;
  }
}

function writeAnswer(notebookId: string, signature: string) {
  try {
    window.sessionStorage.setItem(`${ANSWER_KEY}:${notebookId}`, signature);
  } catch {
    // A blocked storage only costs a repeat prompt: the answer itself already
    // reached the backend.
  }
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
  // Signature of the batch, so a *different* one (more files, or the other
  // direction) asks again instead of inheriting the answer to a question it
  // never saw.
  const signature = `${localCount}:${remoteCount}`;
  const [, bumpRevision] = useReducer((value: number) => value + 1, 0);

  const total = localCount + remoteCount;
  const answered = notebookId ? readAnswer(notebookId) === signature : false;
  const open = Boolean(notebookId) && total > 0 && !answered;

  const remember = useCallback(() => {
    if (!notebookId) return;
    writeAnswer(notebookId, signature);
    bumpRevision();
  }, [notebookId, signature]);

  const resolve = useCallback(
    async (restore: boolean) => {
      if (!notebookId) return;
      setBusy(true);
      try {
        await cloud.resolveMassDeletion(notebookId, restore);
      } catch (error) {
        // `CLOUD_MASS_DELETION_GONE` means another pass resolved the batch while
        // this dialog was open: closing it is the right answer, not an error.
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('CLOUD_MASS_DELETION_GONE')) {
          toast.error(message);
        }
      } finally {
        setBusy(false);
        remember();
      }
    },
    [notebookId, remember],
  );

  if (!open) return null;

  const body = localCount > 0 && remoteCount > 0
    ? t('cloudSync.massDeletion.bodyBoth', { count: total })
    : localCount > 0
      ? t('cloudSync.massDeletion.bodyLocal', { count: localCount })
      : t('cloudSync.massDeletion.bodyRemote', { count: remoteCount });
  // "Undo" means something different in each direction, and the surprising half
  // is that it moves data: the local copies go back up, or come back down.
  const restoreHint = localCount > 0 && remoteCount > 0
    ? t('cloudSync.massDeletion.restoreHintBoth')
    : localCount > 0
      ? t('cloudSync.massDeletion.restoreHintLocal')
      : t('cloudSync.massDeletion.restoreHintRemote');

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) remember(); }}>
      <DialogContent className="max-w-md">
        <DialogTitle>{t('cloudSync.massDeletion.title')}</DialogTitle>
        <DialogDescription className="pt-2">{body}</DialogDescription>
        <p className="pt-3 text-xs text-[var(--destructive)]">
          {t('cloudSync.massDeletion.warning')}
        </p>
        <p className="pt-1 text-xs text-[var(--muted-foreground)]">{restoreHint}</p>
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
