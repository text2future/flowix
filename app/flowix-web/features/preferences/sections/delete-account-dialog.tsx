'use client';

import { useEffect, useState } from 'react';

import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { cloud, type AccountDeletionState } from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { DialogFooter } from '@shared/ui/dialog-footer';
import { Input } from '@shared/ui/input';

interface DeleteAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The signed-in address. Retyping it is the confirmation. */
  email: string;
  onExport: () => void;
  exporting: boolean;
}

/**
 * Destructive account action.
 *
 * Two things make this more than a confirm box. First, the grace period and its
 * deadline come from the server, so the copy cannot drift away from what the
 * deletion actually does. Second, deleting signs the account out, which
 * unmounts the surrounding section — so the outcome has to be reported through
 * toasts instead of dialog state that disappears with it.
 */
export function DeleteAccountDialog({
  open,
  onOpenChange,
  email,
  onExport,
  exporting,
}: DeleteAccountDialogProps) {
  const { t } = useI18n();
  const [info, setInfo] = useState<AccountDeletionState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoadFailed(false);
    void cloud.accountDeletion().then((next) => {
      if (active) setInfo(next);
    }).catch(() => {
      if (active) setLoadFailed(true);
    });
    return () => { active = false; };
  }, [open]);

  useEffect(() => {
    if (open) return;
    setInfo(null);
    setLoadFailed(false);
    setConfirmEmail('');
    setError(null);
  }, [open]);

  // Case-insensitive because that is how the server compares it.
  const emailMatches = email !== '' && confirmEmail.trim().toLowerCase() === email.toLowerCase();

  const confirm = async () => {
    if (deleting || !emailMatches) return;
    setDeleting(true);
    setError(null);
    try {
      const outcome = await cloud.deleteAccount(confirmEmail.trim());
      toast.success(outcome.restorableUntil
        ? t('preferences.cloud.deletion.done', {
          date: new Date(outcome.restorableUntil).toLocaleDateString(),
        })
        : t('preferences.cloud.deletion.doneNoDeadline'));
      if (outcome.pendingSubscriptionCancellations.length > 0) {
        // The account is gone; a subscription still charging the user is the
        // one thing that must not be silently dropped.
        toast.error(t('preferences.cloud.deletion.pendingCancellations', {
          ids: outcome.pendingSubscriptionCancellations.join(', '),
        }));
      }
      onOpenChange(false);
    } catch (deleteError) {
      setError(friendlyErrorMessage(deleteError, t, 'preferences.cloud.deletion.loadFailed'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('preferences.cloud.deletion.title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-[var(--muted-foreground)]">
            {t('preferences.cloud.deletion.intro', { days: String(info?.graceDays ?? 30) })}
          </p>
          {info?.restorableUntil ? (
            <p className="font-mono text-xs text-[var(--foreground)]">
              {t('preferences.cloud.deletion.deadline', {
                date: new Date(info.restorableUntil).toLocaleString(),
              })}
            </p>
          ) : null}
          <p className="text-[var(--muted-foreground)]">
            {t('preferences.cloud.deletion.localNote')}
          </p>
          <div className="space-y-1.5">
            <label
              className="block text-xs text-[var(--muted-foreground)]"
              htmlFor="confirm-delete-email"
            >
              {t('preferences.cloud.deletion.emailLabel', { email })}
            </label>
            <Input
              id="confirm-delete-email"
              autoComplete="off"
              spellCheck={false}
              value={confirmEmail}
              placeholder={t('preferences.cloud.deletion.emailPlaceholder')}
              disabled={deleting || loadFailed}
              onChange={(event) => setConfirmEmail(event.target.value)}
            />
            {confirmEmail.trim() !== '' && !emailMatches ? (
              <p className="text-xs text-[var(--destructive)]">
                {t('preferences.cloud.deletion.mismatch')}
              </p>
            ) : null}
          </div>
          {loadFailed ? (
            <p className="text-xs text-[var(--destructive)]">
              {t('preferences.cloud.deletion.loadFailed')}
            </p>
          ) : null}
          {error ? (
            <p className="break-words text-xs text-[var(--destructive)]">{error}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={exporting} onClick={onExport}>
            {exporting ? t('preferences.cloud.exporting') : t('preferences.cloud.deletion.exportFirst')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={deleting}
            onClick={() => onOpenChange(false)}
          >
            {t('dialog.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={deleting || !emailMatches}
            onClick={() => void confirm()}
          >
            {deleting ? t('preferences.cloud.deletion.deleting') : t('preferences.cloud.deletion.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
