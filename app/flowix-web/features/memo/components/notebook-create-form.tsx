import { canonicalDirectoryPath, isPathInDirectory } from '@/lib/path';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, Folder, Laptop, LoaderCircle, Plus, X } from 'lucide-react';
import { Button } from '@shared/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import type { ObsidianVaultRecord } from '@platform/tauri/client';
import { NotebookIcon } from '@features/memo/components/notebook-icon';
import { Input } from '@shared/ui/input';
import { NotebookIconPopover } from '@features/memo/components/notebook-icon-popover';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

export const NOTEBOOK_CREATE_PAGE_GUTTER_CLASS = 'px-[clamp(38px,6vw,96px)] max-[679px]:px-12';

export function NotebookAgentLibraryHint() {
  const { t } = useI18n();

  return (
    <aside className="mt-3 text-xs leading-5 text-[var(--muted-foreground)]">
      {t('notebook.create.agentLibraryHint')}
    </aside>
  );
}

export interface NotebookCreateFormProps {
  variant?: 'page' | 'dialog';
  title: string;
  formId: string;
  name: string;
  onNameChange: (name: string) => void;
  nameLabel: string;
  namePlaceholder?: string;
  pathLabel: string;
  pathLocationLabel?: string;
  emptyPathPrimaryPrompt?: string;
  emptyPathAlternativePrompt?: string;
  addFolderLabel?: string;
  importLabel?: string;
  importWorkBuddyProjectLabel?: string;
  importCodexProjectLabel?: string;
  onImportProject?: (source: 'workbuddy' | 'codex') => void;
  importObsidianVaultLabel?: string;
  obsidianVaults?: ObsidianVaultRecord[];
  obsidianVaultsLoading?: boolean;
  obsidianVaultsError?: boolean;
  onImportObsidianVaults?: () => void;
  onSelectObsidianVault?: (vault: ObsidianVaultRecord) => void;
  primaryFolderLabel?: string;
  setPrimaryFolderLabel?: string;
  removeFolderLabel?: string;
  selectedPaths?: string[];
  path: string;
  pathPlaceholder: string;
  directoryButtonLabel: string;
  onSelectDirectory: () => void;
  onRemoveDirectory?: (path: string) => void;
  onSetPrimaryDirectory?: (path: string) => void;
  icon: string | null;
  onIconChange: (icon: string | null) => void;
  disabled: boolean;
  onSubmit: () => void;
}

export interface NotebookCreateFooterProps {
  variant?: 'page' | 'dialog';
  formId: string;
  disabled: boolean;
  isBusy: boolean;
  submitLabel?: string;
  busyLabel?: string;
  cancelLabel?: string;
  onCancel?: () => void;
  leadingAction?: ReactNode;
}

export function NotebookCreateFooter({
  variant = 'page',
  formId,
  disabled,
  isBusy,
  submitLabel = '创建并开始使用',
  busyLabel = '正在进入',
  cancelLabel,
  onCancel,
  leadingAction,
}: NotebookCreateFooterProps) {
  return (
    <div className={cn(
      variant === 'dialog'
        ? 'flex w-full items-center gap-3 py-4'
        : 'sticky bottom-0 z-[2] mx-auto flex min-h-[62px] w-[min(100%,680px)] flex-[0_0_auto] items-center gap-[18px] border-t border-[var(--onboarding-line)] bg-[var(--frame-bg)] pt-[18px] max-[760px]:min-h-[58px] max-[760px]:pt-[14px]',
      leadingAction ? 'justify-between' : 'justify-end',
    )}>
      {leadingAction}
      <div className={cn(
        'flex items-center justify-end gap-3',
        leadingAction ? 'ml-auto max-[760px]:flex-1' : 'w-full',
      )}>
        {cancelLabel && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={isBusy}
            className="inline-flex h-[38px] min-h-[38px] items-center justify-center gap-2 rounded-[9px] border border-[var(--border)] bg-transparent px-[15px] text-sm font-medium text-[var(--onboarding-subtle)] hover:text-[var(--onboarding-ink)] disabled:opacity-50"
          >
            {cancelLabel}
          </button>
        )}
        <button
          type="submit"
          form={formId}
          className="inline-flex min-h-[38px] items-center justify-center gap-1 rounded-[9px] border border-[var(--brand)] bg-[var(--brand)] px-[15px] text-sm font-semibold text-[var(--primary-foreground)] shadow-[0_8px_18px_color-mix(in_oklch,var(--brand)_18%,transparent)] disabled:cursor-not-allowed disabled:opacity-[0.46] max-[760px]:flex-1"
          disabled={disabled || isBusy}
          aria-busy={isBusy}
        >
          {isBusy
            ? <><LoaderCircle size={17} className="flowix-spin" aria-hidden="true" /> {busyLabel}</>
            : <>{submitLabel} <ChevronRight size={14} className="-ml-1" aria-hidden="true" /></>}
        </button>
      </div>
    </div>
  );
}

export interface NotebookStorageLocationListProps {
  label: string;
  locationLabel?: string;
  locationControl?: ReactNode;
  paths: string[];
  primaryFolderLabel: string;
  setPrimaryFolderLabel: string;
  removeFolderLabel: string;
  addFolderLabel: string;
  disabled: boolean;
  minimumPaths?: number;
  primarySwitchRoot?: string;
  primarySwitchBlockedLabel?: string;
  onSelectDirectory: () => void;
  onRemoveDirectory: (path: string) => void;
  onSetPrimaryDirectory: (path: string) => void;
}

export function NotebookStorageLocationList({
  label,
  locationLabel,
  locationControl,
  paths,
  primaryFolderLabel,
  setPrimaryFolderLabel,
  removeFolderLabel,
  addFolderLabel,
  disabled,
  minimumPaths = 0,
  primarySwitchRoot,
  primarySwitchBlockedLabel,
  onSelectDirectory,
  onRemoveDirectory,
  onSetPrimaryDirectory,
}: NotebookStorageLocationListProps) {
  // The first path identifies the primary location; keep presentation order independent.
  const [displayPaths, setDisplayPaths] = useState(paths);
  const nextDisplayPaths = [
    ...displayPaths.filter((path) => paths.includes(path)),
    ...paths.filter((path) => !displayPaths.includes(path)),
  ];
  if (nextDisplayPaths.length !== displayPaths.length
    || nextDisplayPaths.some((path, index) => path !== displayPaths[index])) {
    setDisplayPaths(nextDisplayPaths);
  }

  const isPrimarySwitchBlocked = (path: string) => Boolean(primarySwitchRoot
    && canonicalDirectoryPath(path) !== canonicalDirectoryPath(primarySwitchRoot)
    && (isPathInDirectory(path, primarySwitchRoot) || isPathInDirectory(primarySwitchRoot, path)));
  return (
    <div className="grid min-w-0 gap-1">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="text-sm font-normal text-[var(--foreground)]">{label}</div>
        {locationControl ?? (locationLabel && (
          <span className="inline-flex shrink-0 items-center gap-1 text-sm font-normal text-[var(--muted-foreground)]">
            <Laptop className="h-4 w-4" aria-hidden="true" />
            {locationLabel}
          </span>
        ))}
      </div>
      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]">
        {nextDisplayPaths.map((folderPath, index) => {
          const primaryBlocked = isPrimarySwitchBlocked(folderPath);
          const removalBlocked = folderPath === paths[0] && paths.length > 1 && isPrimarySwitchBlocked(paths[1]);
          const folderName = folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folderPath;
          return (
            <div
              key={folderPath}
              className={cn(
                'group/storage-location flex h-12 items-center gap-2 px-3',
                index > 0 && 'border-t border-[var(--border)]',
              )}
            >
              <Folder className="h-4 w-4 shrink-0 text-[var(--foreground)]" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--foreground)]" title={folderPath}>
                {folderName}
              </span>
              {folderPath === paths[0] ? (
                <span className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 py-0.5 text-xs leading-5 text-[var(--muted-foreground)]">
                  {primaryFolderLabel}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onSetPrimaryDirectory(folderPath)}
                  disabled={disabled || primaryBlocked}
                  title={primaryBlocked ? primarySwitchBlockedLabel : undefined}
                  className="pointer-events-none shrink-0 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 py-0.5 text-xs leading-5 text-[var(--muted-foreground)] opacity-0 transition-[color,background-color,opacity] group-hover/storage-location:pointer-events-auto group-hover/storage-location:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-0 disabled:group-hover/storage-location:opacity-60"
                >
                  {setPrimaryFolderLabel}
                </button>
              )}
              <button
                type="button"
                onClick={() => onRemoveDirectory(folderPath)}
                disabled={disabled || paths.length <= minimumPaths || removalBlocked}
                aria-label={`${removeFolderLabel}: ${folderName}`}
                title={removalBlocked ? primarySwitchBlockedLabel : removeFolderLabel}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={onSelectDirectory}
          disabled={disabled}
          className="flex h-12 w-full items-center gap-1 border-t border-[var(--border)] px-3 text-sm text-[var(--muted-foreground)] hover:bg-[var(--muted)] disabled:opacity-50"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />{addFolderLabel}
        </button>
      </div>
      {paths.some(isPrimarySwitchBlocked) && (
        <p className="text-xs leading-5 text-[var(--muted-foreground)]">{primarySwitchBlockedLabel}</p>
      )}
    </div>
  );
}

export function NotebookCreateForm({
  variant = 'page',
  title,
  formId,
  name,
  onNameChange,
  nameLabel,
  namePlaceholder,
  pathLabel,
  pathLocationLabel,
  emptyPathPrimaryPrompt,
  emptyPathAlternativePrompt,
  addFolderLabel,
  importLabel,
  importWorkBuddyProjectLabel,
  importCodexProjectLabel,
  onImportProject,
  importObsidianVaultLabel,
  obsidianVaults = [],
  obsidianVaultsLoading = false,
  obsidianVaultsError = false,
  onImportObsidianVaults,
  onSelectObsidianVault,
  primaryFolderLabel,
  setPrimaryFolderLabel,
  removeFolderLabel,
  selectedPaths,
  path,
  pathPlaceholder,
  directoryButtonLabel,
  onSelectDirectory,
  onRemoveDirectory,
  onSetPrimaryDirectory,
  icon,
  onIconChange,
  disabled,
  onSubmit,
}: NotebookCreateFormProps) {
  const { t } = useI18n();
  const isDialog = variant === 'dialog';
  const folders = isDialog ? selectedPaths ?? (path.trim() ? [path] : []) : [];
  const hasStorageLocationList = Boolean(
    isDialog && folders.length > 0 && primaryFolderLabel && setPrimaryFolderLabel && removeFolderLabel && addFolderLabel,
  );
  const [obsidianMenuOpen, setObsidianMenuOpen] = useState(false);

  return (
    <div className="w-full">
      <h1 id={`${formId}-title`} className={isDialog
        ? 'mt-4 mb-6 text-xl font-semibold leading-tight tracking-[-0.025em] text-[var(--onboarding-ink)]'
        : 'mb-10 text-4xl font-light leading-tight tracking-[-0.04em] text-[var(--onboarding-ink)] max-[760px]:text-3xl'}>
        {title}
      </h1>
      <form
        id={formId}
        className={isDialog
          ? 'grid w-full grid-cols-1 items-start gap-y-4 p-0'
          : 'mt-[22px] grid w-[min(100%,680px)] grid-cols-1 items-start gap-y-4 p-0'}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="grid min-w-0 content-start gap-4">
          <div className="grid min-w-0 gap-1">
            <label className="text-sm font-normal text-[var(--foreground)]" htmlFor={`${formId}-name`}>{nameLabel}</label>
            <div className="relative min-w-0">
              <Input
                id={`${formId}-name`}
                placeholder={namePlaceholder}
                value={name}
                onChange={(event) => onNameChange(event.target.value)}
                autoFocus
                className="h-10 bg-[var(--card)] pl-10"
                disabled={disabled}
              />
              <div className="absolute left-1 top-1 z-10 h-8 w-8">
                <NotebookIconPopover
                  value={icon}
                  onChange={onIconChange}
                  disabled={disabled}
                  variant="inline"
                />
              </div>
            </div>
          </div>
          <div className="grid min-w-0 gap-1">
            {!hasStorageLocationList && (
              <div className="flex min-w-0 items-center justify-between gap-3">
                {isDialog ? (
                  <div className="text-sm font-normal text-[var(--foreground)]">{pathLabel}</div>
                ) : (
                  <label className="text-sm font-normal text-[var(--foreground)]" htmlFor={`${formId}-path`}>{pathLabel}</label>
                )}
                {pathLocationLabel && (
                  <span className="inline-flex shrink-0 items-center gap-1 text-sm font-normal text-[var(--muted-foreground)]">
                    <Laptop className="h-4 w-4" aria-hidden="true" />
                    {pathLocationLabel}
                  </span>
                )}
              </div>
            )}
            {hasStorageLocationList ? (
              <NotebookStorageLocationList
                label={pathLabel}
                locationLabel={pathLocationLabel}
                paths={folders}
                primaryFolderLabel={primaryFolderLabel ?? ''}
                setPrimaryFolderLabel={setPrimaryFolderLabel ?? ''}
                removeFolderLabel={removeFolderLabel ?? ''}
                addFolderLabel={addFolderLabel ?? ''}
                disabled={disabled}
                onSelectDirectory={onSelectDirectory}
                onRemoveDirectory={(folderPath) => onRemoveDirectory?.(folderPath)}
                onSetPrimaryDirectory={(folderPath) => onSetPrimaryDirectory?.(folderPath)}
              />
            ) : isDialog && folders.length === 0 && emptyPathPrimaryPrompt && emptyPathAlternativePrompt && addFolderLabel ? (
              <div className="flex min-h-[160px] flex-col items-center justify-center rounded-2xl border border-[var(--border)] bg-[color-mix(in_oklch,var(--muted)_30%,transparent)]">
                <div className="mb-3 inline-flex items-center gap-1 text-sm font-normal">
                  <span className="text-[var(--foreground)]">
                    {emptyPathPrimaryPrompt}{' '}{emptyPathAlternativePrompt}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onSelectDirectory}
                    disabled={disabled}
                    className="inline-flex h-7 w-fit items-center gap-0.5 rounded-lg bg-[var(--muted)] px-2 text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    {addFolderLabel}
                  </button>
                  {importLabel && ((importWorkBuddyProjectLabel && importCodexProjectLabel && onImportProject) || (importObsidianVaultLabel && onImportObsidianVaults)) && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          disabled={disabled}
                          className="inline-flex h-7 w-fit items-center gap-0.5 rounded-lg bg-[var(--muted)] px-2 text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {importLabel}
                          <ChevronDown className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" sideOffset={6} className="min-w-[180px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                        {importWorkBuddyProjectLabel && importCodexProjectLabel && onImportProject && (
                          <>
                            <DropdownMenuItem
                              onClick={() => onImportProject('workbuddy')}
                              disabled={disabled}
                              className="flex h-8 items-center rounded-lg px-2 text-sm hover:bg-[var(--muted)]"
                            >
                              {importWorkBuddyProjectLabel}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => onImportProject('codex')}
                              disabled={disabled}
                              className="flex h-8 items-center rounded-lg px-2 text-sm hover:bg-[var(--muted)]"
                            >
                              {importCodexProjectLabel}
                            </DropdownMenuItem>
                          </>
                        )}
                        {importObsidianVaultLabel && onImportObsidianVaults && (
                          <DropdownMenu
                            open={obsidianMenuOpen}
                            onOpenChange={(open) => {
                              setObsidianMenuOpen(open);
                              if (open) onImportObsidianVaults();
                            }}
                          >
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                disabled={disabled}
                                className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                <span>{importObsidianVaultLabel}</span>
                                <ChevronRight className="h-4 w-4" aria-hidden="true" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              align="start"
                              side="right"
                              sideOffset={6}
                              keepParentMenuOpen
                              className="min-w-[300px] max-w-[min(420px,90vw)] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
                            >
                              {obsidianVaultsLoading ? (
                                <div className="flex items-center gap-2 px-3 py-3 text-sm text-[var(--muted-foreground)]">
                                  <LoaderCircle className="h-4 w-4 flowix-spin" aria-hidden="true" />
                                  {t('notebook.obsidianImport.loading')}
                                </div>
                              ) : obsidianVaultsError ? (
                                <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm text-[var(--muted-foreground)]">
                                  <span>{t('notebook.obsidianImport.loadFailed')}</span>
                                  <button
                                    type="button"
                                    onClick={onImportObsidianVaults}
                                    className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1 text-[var(--foreground)] hover:bg-[var(--muted)]"
                                  >
                                    {t('notebook.obsidianImport.retry')}
                                  </button>
                                </div>
                              ) : obsidianVaults.length === 0 ? (
                                <div className="px-3 py-3 text-sm text-[var(--muted-foreground)]">
                                  {t('notebook.obsidianImport.empty')}
                                </div>
                              ) : (
                                obsidianVaults.map((vault) => (
                                  <DropdownMenuItem
                                    key={vault.path}
                                    disabled={disabled}
                                    onClick={() => onSelectObsidianVault?.(vault)}
                                    title={`${vault.name} — ${vault.path}`}
                                    className="flex h-9 items-center gap-2 rounded-lg px-2 text-left hover:bg-[var(--muted)]"
                                  >
                                    <NotebookIcon
                                      className="h-6 w-6 shrink-0 rounded-md bg-[var(--muted)] text-[10px] font-semibold"
                                    />
                                    <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                                      <span className="max-w-[40%] shrink-0 truncate">{vault.name}</span>
                                      <span className="min-w-0 flex-1 truncate text-xs text-[var(--muted-foreground)]">{vault.path}</span>
                                    </span>
                                  </DropdownMenuItem>
                                ))
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <Input
                  id={`${formId}-path`}
                  value={path}
                  placeholder={pathPlaceholder}
                  disabled
                  readOnly
                  className="h-10 min-w-0 bg-[var(--card)]"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 shrink-0 bg-[var(--card)]"
                  onClick={onSelectDirectory}
                  disabled={disabled}
                >
                  {directoryButtonLabel}
                </Button>
              </div>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
