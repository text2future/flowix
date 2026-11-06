'use client';

import { Button } from '@shared/ui/button';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@shared/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { useState } from 'react';
import { FlowixCheckbox } from '@shared/ui/flowix-checkbox';
import { cn } from '@/lib/utils';
import {
  NOTEBOOK_FORM_DIALOG_BODY_CLASS,
  NOTEBOOK_FORM_DIALOG_CONTENT_CLASS,
  NOTEBOOK_FORM_DIALOG_OVERLAY_CLASS,
  NOTEBOOK_DELETE_DIALOG_WIDTH_CLASS,
  NOTEBOOK_FORM_DIALOG_HEADING_CLASS,
} from '@features/memo/public/notebook-dialog-api';

interface NotebookDeleteDialogProps {
  /** When non-null, the dialog is open and confirming will delete this notebook. */
  target: { id: string; name: string } | null;
  onCancel: () => void;
  onConfirm: (deleteLocalFiles: boolean) => void;
}

/**
 * Confirmation dialog for deleting a notebook.
 *
 * Local notebook files are kept unless the user explicitly checks the option.
 */
export function NotebookDeleteDialog({ target, onCancel, onConfirm }: NotebookDeleteDialogProps) {
  const { t } = useI18n();
  const [deleteLocalFiles, setDeleteLocalFiles] = useState(false);
  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        overlayClassName={NOTEBOOK_FORM_DIALOG_OVERLAY_CLASS}
        aria-labelledby="flowix-delete-notebook-title"
        className={cn(NOTEBOOK_FORM_DIALOG_CONTENT_CLASS, NOTEBOOK_DELETE_DIALOG_WIDTH_CLASS)}
      >
        <div className={NOTEBOOK_FORM_DIALOG_BODY_CLASS}>
          <DialogHeader className="mb-2">
            <DialogTitle id="flowix-delete-notebook-title" className={cn(NOTEBOOK_FORM_DIALOG_HEADING_CLASS, 'mb-2')}>
              {t('notebook.delete.title')}
            </DialogTitle>
            <DialogDescription>
              {t('notebook.delete.description', { name: target?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex w-full flex-wrap items-center gap-3 pt-4">
            <div className="flex min-w-0 flex-1 items-center gap-2 text-sm text-[var(--foreground)]">
              <FlowixCheckbox
                checked={deleteLocalFiles}
                aria-label={t('notebook.delete.deleteLocalFiles')}
                onCheckedChange={setDeleteLocalFiles}
              />
              <span className="cursor-pointer" onClick={() => setDeleteLocalFiles((checked) => !checked)}>{t('notebook.delete.deleteLocalFiles')}</span>
            </div>
            <div className="ml-auto flex shrink-0 justify-end gap-3">
              <Button
                type="button"
                onClick={onCancel}
                variant="outline" className="gap-2"
              >
                {t('dialog.cancel')}
              </Button>
              <Button
                type="button"
                onClick={() => onConfirm(deleteLocalFiles)}
                variant="destructive" className="gap-1"
              >
                {t('dialog.delete')}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
