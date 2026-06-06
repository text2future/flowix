'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../../components/ui/dialog';

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
  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>确认是否删除</DialogTitle>
          <DialogDescription>删除时不会移除存储文件夹</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 px-3 text-sm rounded-lg hover:bg-[var(--muted)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-8 px-3 text-sm rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90"
          >
            删除
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
