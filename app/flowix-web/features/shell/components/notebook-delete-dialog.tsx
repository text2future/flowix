'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@shared/ui/dialog';
import { useI18n } from '@features/i18n';

interface NotebookDeleteDialogProps {
  /** When non-null, the dialog is open and confirming will delete this notebook. */
  target: { id: string; name: string } | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirmation dialog for deleting a notebook.
 *
 * The folder on disk is intentionally NOT removed (mirrors the in-place
 * behavior of the original inline dialog in `main-layout.tsx`); the description
 * line is the user-facing contract.
 */
export function NotebookDeleteDialog({ target, onCancel, onConfirm }: NotebookDeleteDialogProps) {
  const { t } = useI18n();
  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('notebook.delete.title')}</DialogTitle>
          <DialogDescription>{t('notebook.delete.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 px-3 text-sm rounded-lg hover:bg-[var(--muted)]"
          >
            {t('dialog.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-8 px-3 text-sm rounded-lg bg-[var(--destructive)] text-white hover:opacity-90"
          >
            {t('dialog.delete')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
