'use client';

import { Button } from '@shared/ui/button';

import { Input } from '@shared/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import {
  NotebookIcon,
  resolveNotebookIconId,
} from '@features/memo/components/notebook-icon';
import { NotebookIconPopover } from '@features/memo/components/notebook-icon-popover';
import {
  NotebookCreateFooter,
  NotebookCreateForm,
  NotebookAgentLibraryHint,
  NotebookStorageLocationList,
} from '@features/memo/components/notebook-create-form';
import {
  NOTEBOOK_FORM_DIALOG_CONTENT_CLASS,
  NOTEBOOK_FORM_DIALOG_BODY_CLASS,
  NOTEBOOK_FORM_DIALOG_TITLE_CLASS,
  NOTEBOOK_FORM_DIALOG_OVERLAY_CLASS,
} from '@features/memo/components/notebook-form-dialog-styles';
import type { Notebook } from '@features/memo/store/note-store';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { CloudNotebook, ObsidianVaultRecord } from '@platform/tauri/client';
import googleLogo from '@/assets/google.svg';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Cloud,
  CloudDownload,
  Laptop,
  Loader2,
} from 'lucide-react';
import { useExperimentalMode } from '@platform/tauri/use-experimental-mode';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import { isMac } from '@features/shortcuts';
import { OnboardingTitlebarMac } from '@features/onboarding/onboarding-titlebar-mac';

const NOTEBOOK_DIALOG_THEME_CLASS = '[--onboarding-ink:var(--foreground)] [--onboarding-subtle:var(--muted-foreground)] [--onboarding-panel:color-mix(in_oklch,var(--card)_96%,var(--background))] [--onboarding-line:color-mix(in_oklch,var(--border)_78%,transparent)] [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-[var(--ring)] [&_button:focus-visible]:outline-offset-[3px]';

interface NotebookDialogsProps {
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  newNotebookName: string;
  onNewNotebookNameChange: (name: string) => void;
  newNotebookPaths: string[];
  newNotebookIcon: string | null;
  onNewNotebookIconChange: (icon: string | null) => void;
  isCreatingNotebook: boolean;
  cloudSyncAvailable: boolean;
  createNotebookCloudSync: boolean;
  onCreateNotebookCloudSyncChange: (enabled: boolean) => void;
  onCreateNotebookCloudSyncUnavailable: () => void;
  createMode: 'create' | 'cloud';
  remoteNotebooks: CloudNotebook[];
  remoteNotebooksLoading: boolean;
  remoteNotebookSyncingId: string | null;
  obsidianVaults: ObsidianVaultRecord[];
  obsidianVaultsLoading: boolean;
  obsidianVaultsError: boolean;
  onOpenRemoteNotebooks: () => void;
  onOpenObsidianVaults: () => void;
  onBackToCreate: () => void;
  onSelectRemoteNotebook: (notebook: CloudNotebook) => void;
  onSelectObsidianVault: (vault: ObsidianVaultRecord) => void;
  onSelectDirectory: () => Promise<void>;
  onImportProjectDirectory: (source: 'workbuddy' | 'codex') => Promise<void>;
  onRemoveDirectory: (path: string) => void;
  onSetPrimaryDirectory: (path: string) => void;
  onConfirmCreate: () => void;
  onCancelCreate: () => void;
  editOpen: boolean;
  onEditOpenChange: (open: boolean) => void;
  editingNotebook: Notebook | null;
  editNotebookName: string;
  onEditNotebookNameChange: (name: string) => void;
  editNotebookIcon: string | null;
  onEditNotebookIconChange: (icon: string | null) => void;
  editNotebookCloudSync: boolean;
  onEditNotebookCloudSyncChange: (enabled: boolean) => void;
  onEditNotebookCloudSyncUnavailable: () => void;
  editSaving: boolean;
  editNotebookCloudSyncChanged: boolean;
  onConfirmEdit: () => void;
  onCancelEdit: () => void;
  editNotebookPaths: string[];
  onSelectEditDirectory: () => void;
  onRemoveEditDirectory: (path: string) => void;
  onSetPrimaryEditDirectory: (path: string) => void;
  editNotebookStorageChanged: boolean;
  editStorageStatus: 'loading' | 'ready' | 'error';
  onRetryEditStorage: () => void;
  loginOpen: boolean;
  onLoginOpenChange: (open: boolean) => void;
  googleSignInBusy: boolean;
  onGoogleSignIn: () => void;
}

function normalizeNotebookIconId(icon: string | null | undefined): string {
  return resolveNotebookIconId(icon);
}

function NotebookStorageLocationSelector({
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
    <DropdownMenu disabled={disabled}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t('notebook.edit.pathLabel')}
          className="inline-flex shrink-0 items-center gap-0.5 rounded-md text-sm font-normal text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {checked ? (
            <Cloud className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Laptop className="h-4 w-4" aria-hidden="true" />
          )}
          {checked
            ? t('notebook.cloudSync.locationLabel')
            : t('notebook.create.pathLocationDevice')}
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-[144px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <DropdownMenuItem
          onClick={() => onChange(false)}
          className="flex h-8 items-center justify-between gap-3 rounded-lg px-2 text-sm hover:bg-[var(--muted)]"
        >
          <span className="inline-flex items-center gap-2">
            <Laptop className="h-4 w-4" aria-hidden="true" />
            {t('notebook.create.pathLocationDevice')}
          </span>
          {!checked && <Check className="h-4 w-4" aria-hidden="true" />}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            if (available) onChange(true);
            else onUnavailableClick?.();
          }}
          title={available ? undefined : t('notebook.cloudSync.unavailable')}
          className="flex h-8 items-center justify-between gap-3 rounded-lg px-2 text-sm hover:bg-[var(--muted)]"
        >
          <span className="inline-flex items-center gap-2">
            <Cloud className="h-4 w-4" aria-hidden="true" />
            {t('notebook.cloudSync.locationLabel')}
          </span>
          {checked && <Check className="h-4 w-4" aria-hidden="true" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function NotebookDialogs({
  createOpen,
  onCreateOpenChange,
  newNotebookName,
  onNewNotebookNameChange,
  newNotebookPaths,
  newNotebookIcon,
  onNewNotebookIconChange,
  isCreatingNotebook,
  cloudSyncAvailable,
  createNotebookCloudSync,
  onCreateNotebookCloudSyncChange,
  onCreateNotebookCloudSyncUnavailable,
  createMode,
  remoteNotebooks,
  remoteNotebooksLoading,
  remoteNotebookSyncingId,
  obsidianVaults,
  obsidianVaultsLoading,
  obsidianVaultsError,
  onOpenObsidianVaults,
  onBackToCreate,
  onSelectRemoteNotebook,
  onSelectObsidianVault,
  onSelectDirectory,
  onImportProjectDirectory,
  onRemoveDirectory,
  onSetPrimaryDirectory,
  onConfirmCreate,
  onCancelCreate,
  editOpen,
  onEditOpenChange,
  editingNotebook,
  editNotebookName,
  onEditNotebookNameChange,
  editNotebookIcon,
  onEditNotebookIconChange,
  editNotebookCloudSync,
  onEditNotebookCloudSyncChange,
  onEditNotebookCloudSyncUnavailable,
  editSaving,
  editNotebookCloudSyncChanged,
  onConfirmEdit,
  onCancelEdit,
  editNotebookPaths,
  onSelectEditDirectory,
  onRemoveEditDirectory,
  onSetPrimaryEditDirectory,
  editNotebookStorageChanged,
  editStorageStatus,
  onRetryEditStorage,
  loginOpen,
  onLoginOpenChange,
  googleSignInBusy,
  onGoogleSignIn,
}: NotebookDialogsProps) {
  const { t } = useI18n();
  const experimental = useExperimentalMode();

  return (
    <>
      <Dialog open={createOpen} onOpenChange={onCreateOpenChange}>
        <DialogContent
          closeDisabled={isCreatingNotebook}
          overlayClassName={createMode === 'create' ? NOTEBOOK_FORM_DIALOG_OVERLAY_CLASS : undefined}
          aria-busy={isCreatingNotebook}
          aria-labelledby={createMode === 'create'
            ? 'flowix-create-notebook-form-title'
            : undefined}
          className={cn(
            createMode === 'create'
              ? NOTEBOOK_FORM_DIALOG_CONTENT_CLASS
              : '!fixed !inset-0 !z-[130] !flex !h-dvh !max-h-none !w-full !max-w-none !flex-col !overflow-hidden !rounded-none !bg-[var(--frame-bg)] !p-0 !text-[var(--foreground)] !shadow-none',
            NOTEBOOK_DIALOG_THEME_CLASS,
          )}
        >
          {createMode !== 'create' && isMac() && <OnboardingTitlebarMac />}
          {createMode !== 'create' && <WindowsTitlebarControls reserveSpace />}
          <main className={cn(
            createMode === 'create'
              ? NOTEBOOK_FORM_DIALOG_BODY_CLASS
              : 'relative z-[1] flex min-h-0 w-full flex-1 flex-col overflow-hidden p-0',
          )}>
            <div className={cn(
              createMode === 'create'
                ? 'mx-auto w-full'
                : 'mx-auto flex min-h-0 w-full flex-1 flex-col overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-w-[780px] pb-[104px]',
            )}>
              <section className={cn(
                'w-full',
                createMode === 'create' ? '' : 'py-[clamp(11px,1.33vw,16px)] pb-4',
              )}>
                {createMode === 'cloud' ? (
                  <>
                    <div className="max-w-full">
                      <button
                        type="button"
                        onClick={onBackToCreate}
                        className="mb-[15px] inline-flex items-center gap-[7px] p-0 text-xs text-[var(--onboarding-subtle)] hover:text-[var(--onboarding-ink)]"
                        aria-label={t('notebook.cloudImport.back')}
                        title={t('notebook.cloudImport.back')}
                      >
                        <ArrowLeft className="h-4 w-4" />
                        {t('notebook.cloudImport.back')}
                      </button>
                      <h1 className="text-[clamp(23px,3.33vw,44px)] font-light leading-[0.98] tracking-[-0.065em] text-[var(--onboarding-ink)]">{t('notebook.cloudImport.title')}</h1>
                    </div>
                    <div className="mt-[22px] w-full max-w-[780px]">
                      {remoteNotebooksLoading ? (
                        <div className="flex min-h-[180px] items-center justify-center gap-2 text-sm text-[var(--muted-foreground)]">
                          <Loader2 className="h-4 w-4 flowix-spin" />
                          {t('notebook.cloudImport.loading')}
                        </div>
                      ) : remoteNotebooks.length === 0 ? (
                        <div className="flex min-h-[180px] items-center justify-center text-sm text-[var(--muted-foreground)]">
                          {t('notebook.cloudImport.empty')}
                        </div>
                      ) : (
                        <div className="max-h-[min(55vh,560px)] space-y-2 overflow-y-auto pr-1">
                          {remoteNotebooks.map((notebook) => {
                            const syncing = remoteNotebookSyncingId === notebook.id;
                            return (
                              <div
                                key={notebook.id}
                                className="flex w-full items-center gap-3 rounded-lg border border-[var(--border)] px-3 py-2.5"
                              >
                                <NotebookIcon
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
                                  <Button
                                    type="button"
                                    disabled={remoteNotebookSyncingId !== null}
                                    onClick={() => onSelectRemoteNotebook(notebook)}
                                    variant="default" className="shrink-0 gap-1.5"
                                  >
                                    {syncing ? (
                                      <Loader2 className="h-4 w-4 flowix-spin" />
                                    ) : (
                                      <CloudDownload className="h-4 w-4" />
                                    )}
                                    {t('notebook.cloudImport.sync')}
                                  </Button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <NotebookCreateForm
                    variant="dialog"
                    title="新建笔记本"
                    formId="flowix-create-notebook-form"
                    name={newNotebookName}
                    onNameChange={onNewNotebookNameChange}
                    nameLabel={t('notebook.create.namePlaceholder')}
                    namePlaceholder={t('notebook.nameInputPlaceholder')}
                    pathLabel={t('notebook.create.pathLabel')}
                    pathLocationLabel={t('notebook.create.pathLocationDevice')}
                    pathLocationControl={(
                      <NotebookStorageLocationSelector
                        checked={createNotebookCloudSync}
                        available={cloudSyncAvailable}
                        disabled={isCreatingNotebook}
                        onChange={onCreateNotebookCloudSyncChange}
                        onUnavailableClick={onCreateNotebookCloudSyncUnavailable}
                      />
                    )}
                    emptyPathPrimaryPrompt={t('notebook.create.emptyPathPrimaryPrompt')}
                    emptyPathAlternativePrompt={t('notebook.create.emptyPathAlternativePrompt')}
                    addFolderLabel={t('notebook.create.addFolder')}
                    importLabel={t('notebook.create.readAiSpace')}
                    importWorkBuddyProjectLabel={t('notebook.create.importWorkBuddyProject')}
                    importCodexProjectLabel={t('notebook.create.importCodexProject')}
                    onImportProject={(source) => void onImportProjectDirectory(source)}
                    importObsidianVaultLabel={t('notebook.create.importObsidianVaults')}
                    obsidianVaults={obsidianVaults}
                    obsidianVaultsLoading={obsidianVaultsLoading}
                    obsidianVaultsError={obsidianVaultsError}
                    onImportObsidianVaults={onOpenObsidianVaults}
                    onSelectObsidianVault={onSelectObsidianVault}
                    primaryFolderLabel={t('notebook.create.primaryFolder')}
                    setPrimaryFolderLabel={t('notebook.create.setPrimaryFolder')}
                    removeFolderLabel={t('notebook.create.removeFolder')}
                    selectedPaths={newNotebookPaths}
                    path={newNotebookPaths[0] ?? ''}
                    pathPlaceholder={t('notebook.create.pathPlaceholder')}
                    directoryButtonLabel={t('notebook.create.selectDirectory')}
                    onSelectDirectory={() => void onSelectDirectory()}
                    onRemoveDirectory={onRemoveDirectory}
                    onSetPrimaryDirectory={onSetPrimaryDirectory}
                    icon={newNotebookIcon}
                    onIconChange={onNewNotebookIconChange}
                    disabled={isCreatingNotebook}
                    onSubmit={onConfirmCreate}
                  />
                )}
              </section>
            </div>
            {createMode === 'create' && <NotebookAgentLibraryHint />}
            {createMode === 'create' ? (
              <NotebookCreateFooter
                variant="dialog"
                submitTone="brand"
                formId="flowix-create-notebook-form"
                disabled={!newNotebookName.trim()}
                isBusy={isCreatingNotebook}
                cancelLabel={t('notebook.create.cancel')}
                onCancel={onCancelCreate}
              />
            ) : (
              <div className="absolute bottom-0 left-0 z-[4] m-0 flex min-h-20 w-full items-center justify-end border-t border-[var(--onboarding-line)] bg-[var(--frame-bg)] px-[clamp(28px,6vw,96px)] pb-[calc(16px+env(safe-area-inset-bottom))] max-[600px]:flex-wrap max-[600px]:gap-2 max-[600px]:px-5 max-[600px]:pb-[calc(12px+env(safe-area-inset-bottom))] pt-4">
                <div className="mx-auto flex w-full max-w-[780px] items-center justify-end gap-2">
                  <Button
                    type="button"
                    onClick={onCancelCreate}
                    disabled={isCreatingNotebook}
                    variant="outline" className="gap-2"
                  >
                    {t('notebook.create.cancel')}
                  </Button>
                </div>
              </div>
            )}
          </main>
        </DialogContent>
      </Dialog>
      <Dialog open={editOpen} onOpenChange={onEditOpenChange}>
        <DialogContent
          overlayClassName={NOTEBOOK_FORM_DIALOG_OVERLAY_CLASS}
          aria-busy={editSaving}
          aria-labelledby="flowix-edit-notebook-form-title"
          className={cn(NOTEBOOK_FORM_DIALOG_CONTENT_CLASS, NOTEBOOK_DIALOG_THEME_CLASS)}
        >
          <main className={NOTEBOOK_FORM_DIALOG_BODY_CLASS}>
            <section className="w-full">
              <h1
                id="flowix-edit-notebook-form-title"
                className={NOTEBOOK_FORM_DIALOG_TITLE_CLASS}
              >
                {t('notebook.edit.title')}
              </h1>
              <form
                id="flowix-edit-notebook-form"
                className="grid w-full grid-cols-1 items-start gap-y-4 p-0"
                onSubmit={(event) => {
                  event.preventDefault();
                  onConfirmEdit();
                }}
              >
                <div className="grid min-w-0 content-start gap-4">
                  <div className="grid min-w-0 gap-1">
                    <label className="text-sm font-normal text-[var(--foreground)]" htmlFor="flowix-edit-notebook-name">
                      {t('notebook.edit.namePlaceholder')}
                    </label>
                    <div className="relative min-w-0">
                      <Input
                        id="flowix-edit-notebook-name"
                        placeholder={t('notebook.nameInputPlaceholder')}
                        value={editNotebookName}
                        disabled={editSaving}
                        onChange={(event) => onEditNotebookNameChange(event.target.value)}
                        autoFocus
                        className="pl-10"
                      />
                      <div className="absolute left-1 top-1 z-10 h-8 w-8">
                        <NotebookIconPopover
                          value={editNotebookIcon}
                          onChange={onEditNotebookIconChange}
                          disabled={editSaving}
                          variant="inline"
                        />
                      </div>
                    </div>
                  </div>
                  {editStorageStatus !== 'ready' && (
                    <div role={editStorageStatus === 'error' ? 'alert' : 'status'} className="flex items-center justify-between gap-2 text-sm text-[var(--muted-foreground)]">
                      <span>{t(editStorageStatus === 'error' ? 'notebook.edit.storageLoadFailed' : 'notebook.edit.storageLoading')}</span>
                      {editStorageStatus === 'error' && <button type="button" onClick={onRetryEditStorage} className="rounded-md border border-[var(--border)] px-2 py-1">{t('error.retry')}</button>}
                    </div>
                  )}
                  <NotebookStorageLocationList
                    label={t('notebook.edit.pathLabel')}
                    locationLabel={experimental ? undefined : t('notebook.create.pathLocationDevice')}
                    locationControl={experimental ? (
                      <NotebookStorageLocationSelector
                        checked={editNotebookCloudSync}
                        available={cloudSyncAvailable}
                        disabled={editSaving}
                        onChange={onEditNotebookCloudSyncChange}
                        onUnavailableClick={onEditNotebookCloudSyncUnavailable}
                      />
                    ) : undefined}
                    paths={editNotebookPaths}
                    primaryFolderLabel={t('notebook.create.primaryFolder')}
                    setPrimaryFolderLabel={t('notebook.create.setPrimaryFolder')}
                    removeFolderLabel={t('notebook.create.removeFolder')}
                    addFolderLabel={t('notebook.create.addFolder')}
                    disabled={editSaving || editStorageStatus !== 'ready'}
                    minimumPaths={1}
                    primarySwitchRoot={editingNotebook?.path}
                    primarySwitchBlockedLabel={t('notebook.edit.primaryOverlap')}
                    onSelectDirectory={onSelectEditDirectory}
                    onRemoveDirectory={onRemoveEditDirectory}
                    onSetPrimaryDirectory={onSetPrimaryEditDirectory}
                  />
                </div>
              </form>
            </section>
            <NotebookAgentLibraryHint />
            <NotebookCreateFooter
              variant="dialog"
              submitTone="brand"
              formId="flowix-edit-notebook-form"
              disabled={
                editStorageStatus !== 'ready' ||
                !editNotebookName.trim() ||
                (editNotebookName.trim() === editingNotebook?.name &&
                  (editNotebookIcon ?? '') === normalizeNotebookIconId(editingNotebook?.icon) &&
                  !editNotebookCloudSyncChanged &&
                  !editNotebookStorageChanged)
              }
              isBusy={editSaving}
              submitLabel={t('notebook.edit.confirm')}
              busyLabel={t('notebook.edit.saving')}
              cancelLabel={t('notebook.edit.cancel')}
              onCancel={onCancelEdit}
            />
          </main>
        </DialogContent>
      </Dialog>
      <Dialog open={loginOpen} onOpenChange={onLoginOpenChange}>
        <DialogContent className="w-[min(92vw,400px)] rounded-2xl p-6">
          <div className="space-y-5">
            <DialogHeader className="mb-0 space-y-2 text-left">
              <DialogTitle className="text-lg font-semibold tracking-tight">{t('notebook.cloudLogin.title')}</DialogTitle>
              <DialogDescription className="text-sm leading-relaxed">{t('notebook.cloudLogin.description')}</DialogDescription>
            </DialogHeader>
            <Button
              type="button"
              variant="outline"
              className="flex h-10 w-full gap-2 rounded-lg bg-[var(--card)] text-[var(--foreground)]"
              disabled={googleSignInBusy}
              onClick={onGoogleSignIn}
            >
              <img src={googleLogo} alt="" aria-hidden="true" className="h-4 w-4 object-contain" />
              {googleSignInBusy ? t('preferences.cloud.loggingIn') : t('notebook.cloudLogin.googleSignIn')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
