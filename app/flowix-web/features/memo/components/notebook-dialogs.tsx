'use client';

import { Input } from '@shared/ui/input';
import { Button } from '@shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import {
  getNotebookIconOption,
  NotebookIcon,
  NOTEBOOK_ICON_OPTIONS,
  type Notebook,
} from '@features/memo';
import { cn } from '@/lib/utils';
import { useI18n } from '@features/i18n';

interface NotebookDialogsProps {
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  newNotebookName: string;
  onNewNotebookNameChange: (name: string) => void;
  newNotebookPath: string;
  onNewNotebookPathChange: (path: string) => void;
  newNotebookIcon: string | null;
  onNewNotebookIconChange: (icon: string | null) => void;
  onSelectDirectory: () => Promise<void>;
  onConfirmCreate: () => void;
  onCancelCreate: () => void;
  editOpen: boolean;
  onEditOpenChange: (open: boolean) => void;
  editingNotebook: Notebook | null;
  editNotebookName: string;
  onEditNotebookNameChange: (name: string) => void;
  editNotebookIcon: string | null;
  onEditNotebookIconChange: (icon: string | null) => void;
  onConfirmEdit: () => void;
  onCancelEdit: () => void;
}

function NotebookIconPicker({
  value,
  notebookName,
  onChange,
}: {
  value: string | null;
  notebookName: string;
  onChange: (icon: string | null) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-[var(--muted-foreground)]">{t("notebook.iconLabel")}</div>
      <div className="max-h-[162px] overflow-y-auto pr-1 [scrollbar-gutter:stable]">
        <div className="grid grid-cols-8 gap-1.5">
          <button
            type="button"
            onClick={() => onChange(null)}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-md border transition-colors',
              value === null
                ? 'border-[var(--primary)] bg-[var(--accent)]'
                : 'border-[var(--border)] hover:bg-[var(--muted)]'
            )}
            aria-label={t("memo.notebook.letterIcon")}
            title={t("memo.notebook.letterIcon")}
          >
            <NotebookIcon
              name={notebookName}
              className="h-[26px] w-[26px] rounded-md bg-[var(--muted)] text-[12px] font-semibold text-[var(--secondary-foreground)]"
            />
          </button>
          {NOTEBOOK_ICON_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onChange(option.id)}
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-md border transition-colors',
                value === option.id
                  ? 'border-[var(--primary)] bg-[var(--accent)]'
                  : 'border-[var(--border)] hover:bg-[var(--muted)]'
              )}
              aria-label={option.label}
              title={option.label}
            >
              <NotebookIcon
                icon={option.id}
                className="h-[26px] w-[26px] rounded-md bg-[var(--muted)] text-[var(--muted-foreground)]"
                imageClassName="h-[72%] w-[72%]"
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function normalizeNotebookIconId(icon: string | null | undefined): string | null {
  return getNotebookIconOption(icon) ? icon! : null;
}

export function NotebookDialogs({
  createOpen,
  onCreateOpenChange,
  newNotebookName,
  onNewNotebookNameChange,
  newNotebookPath,
  onNewNotebookPathChange,
  newNotebookIcon,
  onNewNotebookIconChange,
  onSelectDirectory,
  onConfirmCreate,
  onCancelCreate,
  editOpen,
  onEditOpenChange,
  editingNotebook,
  editNotebookName,
  onEditNotebookNameChange,
  editNotebookIcon,
  onEditNotebookIconChange,
  onConfirmEdit,
  onCancelEdit,
}: NotebookDialogsProps) {
  const { t } = useI18n();
  return (
    <>
      <Dialog open={createOpen} onOpenChange={onCreateOpenChange}>
        <DialogContent className="w-[400px]">
          <DialogHeader>
            <DialogTitle>{t("notebook.create.title")}</DialogTitle>
          </DialogHeader>
          <div className="mt-1 space-y-3">
            <Input
              placeholder={t("notebook.create.namePlaceholder")}
              value={newNotebookName}
              onChange={(event) => onNewNotebookNameChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onConfirmCreate();
              }}
                autoFocus
            />
            <NotebookIconPicker
              value={newNotebookIcon}
              notebookName={newNotebookName}
              onChange={onNewNotebookIconChange}
            />
            <div className="flex gap-2">
              <Input
                placeholder={t("notebook.create.pathPlaceholder")}
                value={newNotebookPath}
                onChange={(event) => onNewNotebookPathChange(event.target.value)}
                onClick={() => {
                  void onSelectDirectory();
                }}
                className="flex-1 cursor-pointer"
                readOnly
              />
              <Button
                variant="outline"
                className="h-8"
                onClick={() => {
                  void onSelectDirectory();
                }}
              >
                {t("notebook.create.selectDirectory")}
              </Button>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancelCreate}
              className="h-8 px-3 text-sm rounded-lg hover:bg-[var(--muted)]"
            >
              {t("notebook.create.cancel")}
            </button>
            <button
              type="button"
              onClick={onConfirmCreate}
              className="h-8 px-3 text-sm rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
              disabled={!newNotebookName.trim() || !newNotebookPath.trim()}
            >
              {t("notebook.create.confirm")}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={onEditOpenChange}>
        <DialogContent className="w-[400px]">
          <DialogHeader>
            <DialogTitle>{t("notebook.edit.title")}</DialogTitle>
          </DialogHeader>
          <div className="mt-2 space-y-3">
            <Input
              placeholder={t("notebook.edit.namePlaceholder")}
              value={editNotebookName}
              onChange={(event) => onEditNotebookNameChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onConfirmEdit();
              }}
              autoFocus
            />
            <NotebookIconPicker
              value={editNotebookIcon}
              notebookName={editNotebookName}
              onChange={onEditNotebookIconChange}
            />
            <div className="space-y-2">
              <div className="text-xs font-medium text-[var(--muted-foreground)]">
                {t("notebook.edit.pathLabel")}
              </div>
              <div
                className="w-full truncate rounded-md border border-[var(--border)] bg-[var(--muted)] px-3 py-2 text-sm text-[var(--muted-foreground)] select-all"
                title={editingNotebook?.path ?? ''}
              >
                {editingNotebook?.path ?? ''}
              </div>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between gap-2">
            {editingNotebook ? (
              <button
                type="button"
                onClick={() => {
                  if (!editingNotebook) return;
                  const target = editingNotebook;
                  // 复用 main-layout 已有的 NotebookDeleteDialog:
                  // 先关掉当前弹窗, 再派发全局事件打开删除确认。
                  onCancelEdit();
                  window.dispatchEvent(
                    new CustomEvent<Notebook>('flowix:request-delete-notebook', { detail: target })
                  );
                }}
                className="h-8 px-3 text-sm rounded-lg bg-[var(--card)] text-[var(--foreground)] border border-[var(--border)] hover:bg-[var(--muted)] hover:text-[var(--destructive)]"
              >
                {t("notebook.edit.remove")}
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onCancelEdit}
                className="h-8 px-3 text-sm rounded-lg hover:bg-[var(--muted)]"
              >
                {t("notebook.edit.cancel")}
              </button>
              <button
                type="button"
                onClick={onConfirmEdit}
                className="h-8 px-3 text-sm rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
                disabled={
                  !editNotebookName.trim() ||
                  (editNotebookName.trim() === editingNotebook?.name &&
                    (editNotebookIcon ?? '') === (normalizeNotebookIconId(editingNotebook?.icon) ?? ''))
                }
              >
                {t("notebook.edit.confirm")}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
