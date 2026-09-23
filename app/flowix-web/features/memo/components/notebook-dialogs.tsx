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
} from '@features/memo/components/notebook-icon';
import { NotebookIconPicker } from '@features/memo/components/notebook-icon-picker';
import type { Notebook } from '@features/memo/store/memo-store';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { CloudNotebook } from '@platform/tauri/client';
import { ArrowLeft, Check, CloudDownload, Loader2 } from 'lucide-react';
import { useExperimentalMode } from '@platform/tauri/use-experimental-mode';
import { Textarea } from '@shared/ui/textarea';

interface NotebookDialogsProps {
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  newNotebookName: string;
  onNewNotebookNameChange: (name: string) => void;
  newNotebookPath: string;
  newNotebookDefaultPath: string;
  onNewNotebookPathChange: (path: string) => void;
  newNotebookIcon: string | null;
  onNewNotebookIconChange: (icon: string | null) => void;
  cloudSyncAvailable: boolean;
  createMode: 'create' | 'cloud';
  remoteNotebooks: CloudNotebook[];
  remoteNotebooksLoading: boolean;
  remoteNotebookSyncingId: string | null;
  onOpenRemoteNotebooks: () => void;
  onBackToCreate: () => void;
  onSelectRemoteNotebook: (notebook: CloudNotebook) => void;
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
  editNotebookDescription: string;
  onEditNotebookDescriptionChange: (description: string) => void;
  editNotebookDescriptionLoading: boolean;
  editNotebookDescriptionChanged: boolean;
  editNotebookCloudSync: boolean;
  onEditNotebookCloudSyncChange: (enabled: boolean) => void;
  onEditNotebookCloudSyncUnavailable: () => void;
  editSaving: boolean;
  editNotebookCloudSyncChanged: boolean;
  onConfirmEdit: () => void;
  onCancelEdit: () => void;
}

function normalizeNotebookIconId(icon: string | null | undefined): string | null {
  return getNotebookIconOption(icon) ? icon! : null;
}

function NotebookCloudSyncToggle({
  checked,
  available,
  disabled = false,
  onChange,
  onUnavailableClick,
}: {
  checked: boolean;
  available: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  onUnavailableClick?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm">{t('notebook.cloudSync.title')}</div>
        <div className="text-xs text-[var(--muted-foreground)]">
          {available
            ? t('notebook.cloudSync.description')
            : t('notebook.cloudSync.unavailable')}
        </div>
      </div>
      {!available && onUnavailableClick ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 rounded-lg"
          onClick={onUnavailableClick}
        >
          {t('preferences.cloud.login')}
        </Button>
      ) : (
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={t('notebook.cloudSync.title')}
          disabled={!available || disabled}
          onClick={() => onChange(!checked)}
          className={cn(
            'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            checked ? 'bg-[var(--primary)]' : 'bg-[var(--muted)]',
          )}
        >
          <span
            className={cn(
              'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
              checked ? 'translate-x-5' : 'translate-x-0',
            )}
          />
        </button>
      )}
    </div>
  );
}

export function NotebookDialogs({
  createOpen,
  onCreateOpenChange,
  newNotebookName,
  onNewNotebookNameChange,
  newNotebookPath,
  newNotebookDefaultPath,
  onNewNotebookPathChange,
  newNotebookIcon,
  onNewNotebookIconChange,
  cloudSyncAvailable,
  createMode,
  remoteNotebooks,
  remoteNotebooksLoading,
  remoteNotebookSyncingId,
  onOpenRemoteNotebooks,
  onBackToCreate,
  onSelectRemoteNotebook,
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
  editNotebookDescription,
  onEditNotebookDescriptionChange,
  editNotebookDescriptionLoading,
  editNotebookDescriptionChanged,
  editNotebookCloudSync,
  onEditNotebookCloudSyncChange,
  onEditNotebookCloudSyncUnavailable,
  editSaving,
  editNotebookCloudSyncChanged,
  onConfirmEdit,
  onCancelEdit,
}: NotebookDialogsProps) {
  const { t } = useI18n();
  const experimental = useExperimentalMode();

  return (
    <>
      <Dialog open={createOpen} onOpenChange={onCreateOpenChange}>
        <DialogContent className="w-[400px]">
          <DialogHeader>
            {createMode === 'cloud' ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onBackToCreate}
                  className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--muted)]"
                  aria-label={t('notebook.cloudImport.back')}
                  title={t('notebook.cloudImport.back')}
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <DialogTitle>{t('notebook.cloudImport.title')}</DialogTitle>
              </div>
            ) : (
              <DialogTitle>{t("notebook.create.title")}</DialogTitle>
            )}
          </DialogHeader>
          {createMode === 'cloud' ? (
            <div className="mt-2 min-h-[180px]">
              {remoteNotebooksLoading ? (
                <div className="flex min-h-[180px] items-center justify-center gap-2 text-sm text-[var(--muted-foreground)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('notebook.cloudImport.loading')}
                </div>
              ) : remoteNotebooks.length === 0 ? (
                <div className="flex min-h-[180px] items-center justify-center text-sm text-[var(--muted-foreground)]">
                  {t('notebook.cloudImport.empty')}
                </div>
              ) : (
                <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
                  {remoteNotebooks.map((notebook) => {
                    const syncing = remoteNotebookSyncingId === notebook.id;
                    return (
                      <div
                        key={notebook.id}
                        className="flex w-full items-center gap-3 rounded-lg border border-[var(--border)] px-3 py-2.5"
                      >
                        <NotebookIcon
                          name={notebook.name}
                          icon={notebook.icon ?? undefined}
                          className="h-8 w-8 shrink-0 rounded-md bg-[var(--muted)] text-xs font-semibold"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm">{notebook.name}</span>
                        {notebook.synced ? (
                          <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--muted-foreground)]">
                            <Check className="h-3.5 w-3.5" />
                            {t('notebook.cloudImport.synced')}
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={remoteNotebookSyncingId !== null}
                            onClick={() => onSelectRemoteNotebook(notebook)}
                            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 text-sm text-[var(--primary-foreground)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {syncing ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <CloudDownload className="h-4 w-4" />
                            )}
                            {t('notebook.cloudImport.sync')}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="mt-2 space-y-3">
                <Input
                  placeholder={t("notebook.create.namePlaceholder")}
                  value={newNotebookName}
                  onChange={(event) => onNewNotebookNameChange(event.target.value)}
                  autoFocus
                  className="h-10"
                />
                <NotebookIconPicker
                  value={newNotebookIcon}
                  notebookName={newNotebookName}
                  onChange={onNewNotebookIconChange}
                />
                <div className="space-y-2">
                  <div className="text-sm font-semibold text-[var(--foreground)]">
                    {t("notebook.create.pathLabel")}
                  </div>
                  <div className="flex gap-2">
                    <Input
                      placeholder={t("notebook.create.pathPlaceholder")}
                      value={newNotebookPath || newNotebookDefaultPath}
                      onChange={(event) => onNewNotebookPathChange(event.target.value)}
                      onClick={() => {
                        void onSelectDirectory();
                      }}
                      className="h-10 flex-1 cursor-pointer"
                      readOnly
                    />
                    <Button
                      variant="outline"
                      className="h-10"
                      onClick={() => {
                        void onSelectDirectory();
                      }}
                    >
                      {t("notebook.create.selectDirectory")}
                    </Button>
                  </div>
                </div>
              </div>
              <div className={cn(
                'mt-4 flex items-center gap-2',
                experimental ? 'justify-between' : 'justify-end',
              )}>
                {experimental && (
                  <button
                    type="button"
                    onClick={onOpenRemoteNotebooks}
                    className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--foreground)] hover:bg-[var(--muted)]"
                  >
                    <CloudDownload className="h-4 w-4" />
                    {t('notebook.cloudImport.action')}
                  </button>
                )}
                <div className="flex items-center gap-2">
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
                    disabled={!newNotebookName.trim()}
                  >
                    {t("notebook.create.confirm")}
                  </button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={onEditOpenChange}>
        <DialogContent className="w-[760px] !max-w-[calc(100vw-2rem)]" aria-busy={editSaving}>
          <DialogHeader>
            <DialogTitle>{t("notebook.edit.title")}</DialogTitle>
          </DialogHeader>
          <div className="mt-2 grid grid-cols-1 gap-6 md:grid-cols-[2fr_3fr]">
            <div className="min-w-0 space-y-3">
              <Input
                placeholder={t("notebook.edit.namePlaceholder")}
                value={editNotebookName}
                disabled={editSaving}
                onChange={(event) => onEditNotebookNameChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onConfirmEdit();
                }}
                autoFocus
                className="h-10"
              />
              <NotebookIconPicker
                value={editNotebookIcon}
                notebookName={editNotebookName}
                onChange={onEditNotebookIconChange}
                disabled={editSaving}
              />
              <div className="space-y-2">
                <div className="text-sm font-semibold text-[var(--foreground)]">
                  {t("notebook.edit.pathLabel")}
                </div>
                <div
                  className="flex h-10 w-full items-center truncate rounded-lg border border-input bg-[var(--muted)] px-3 text-sm text-[var(--muted-foreground)] select-all"
                  title={editingNotebook?.path ?? ''}
                >
                  {editingNotebook?.path ?? ''}
                </div>
              </div>
              {experimental && (
                <NotebookCloudSyncToggle
                  checked={editNotebookCloudSync}
                  available={cloudSyncAvailable}
                  disabled={editSaving}
                  onChange={onEditNotebookCloudSyncChange}
                  onUnavailableClick={onEditNotebookCloudSyncUnavailable}
                />
              )}
            </div>
            <div className="min-w-0 flex h-full flex-col md:border-l md:border-[var(--border)] md:pl-6">
              <div className="flex items-center gap-1.5 pb-[0.35rem] pt-[0.35rem] text-sm font-semibold leading-[1.2] text-[var(--foreground)]">
                {t('notebook.edit.agents.title')}
              </div>
              <Textarea
                value={editNotebookDescription}
                disabled={editSaving || editNotebookDescriptionLoading}
                onChange={(event) => onEditNotebookDescriptionChange(event.target.value)}
                placeholder={t('notebook.edit.agents.placeholder')}
                className="h-full min-h-0 flex-1 resize-none"
              />
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between gap-2">
            {editingNotebook ? (
              <button
                type="button"
                disabled={editSaving}
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
                className="h-8 px-3 text-sm rounded-lg bg-[var(--card)] text-[var(--foreground)] border border-[var(--border)] hover:bg-transparent hover:border-[var(--destructive)] hover:text-[var(--destructive)]"
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
                disabled={editSaving}
                className="h-8 px-3 text-sm rounded-lg hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("notebook.edit.cancel")}
              </button>
              <button
                type="button"
                onClick={onConfirmEdit}
                className="h-8 px-3 text-sm rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
                disabled={
                  editSaving ||
                  editNotebookDescriptionLoading ||
                  !editNotebookName.trim() ||
                  (editNotebookName.trim() === editingNotebook?.name &&
                    (editNotebookIcon ?? '') === (normalizeNotebookIconId(editingNotebook?.icon) ?? '') &&
                    !editNotebookCloudSyncChanged &&
                    !editNotebookDescriptionChanged)
                }
              >
                {editSaving && <Loader2 className="mr-1.5 inline-block h-3.5 w-3.5 animate-spin" />}
                {editSaving ? t("notebook.edit.saving") : t("notebook.edit.confirm")}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
