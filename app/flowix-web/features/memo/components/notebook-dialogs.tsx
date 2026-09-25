'use client';

import { useEffect, useMemo, useState } from 'react';
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
import { NotebookIconPopover } from '@features/memo/components/notebook-icon-popover';
import { NotebookIconPicker } from '@features/memo/components/notebook-icon-picker';
import type { Notebook } from '@features/memo/store/memo-store';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { CloudNotebook } from '@platform/tauri/client';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  Loader2,
} from 'lucide-react';
import { useExperimentalMode } from '@platform/tauri/use-experimental-mode';
import { Textarea } from '@shared/ui/textarea';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import { isMac } from '@features/shortcuts';
import { OnboardingTitlebarMac } from '@features/onboarding/onboarding-titlebar-mac';
import { useNotebookTemplates } from '@features/onboarding/notebook-templates';
import { NotebookTemplateIcon } from '@features/onboarding/notebook-template-icon';

interface NotebookDialogsProps {
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  newNotebookName: string;
  onNewNotebookNameChange: (name: string) => void;
  newNotebookPath: string;
  newNotebookDefaultPath: string;
  newNotebookIcon: string | null;
  onNewNotebookIconChange: (icon: string | null) => void;
  newNotebookTemplateId: string | null;
  onNewNotebookTemplateIdChange: (templateId: string | null) => void;
  isCreatingNotebook: boolean;
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
  newNotebookIcon,
  onNewNotebookIconChange,
  newNotebookTemplateId,
  onNewNotebookTemplateIdChange,
  isCreatingNotebook,
  cloudSyncAvailable,
  createMode,
  remoteNotebooks,
  remoteNotebooksLoading,
  remoteNotebookSyncingId,
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
  const {
    templates: notebookTemplates,
    status: notebookTemplateStatus,
    retry: retryNotebookTemplates,
  } = useNotebookTemplates(createOpen && createMode === 'create');
  const [templatesPerPage, setTemplatesPerPage] = useState(6);
  const [templatePage, setTemplatePage] = useState(0);

  useEffect(() => {
    const updateTemplatesPerPage = () => setTemplatesPerPage(window.innerWidth < 760 ? 2 : 6);
    updateTemplatesPerPage();
    window.addEventListener('resize', updateTemplatesPerPage);
    return () => window.removeEventListener('resize', updateTemplatesPerPage);
  }, []);

  const templatePages = useMemo(() => {
    const pages: Array<Array<(typeof notebookTemplates)[number]>> = [];
    for (let index = 0; index < notebookTemplates.length; index += templatesPerPage) {
      pages.push([...notebookTemplates.slice(index, index + templatesPerPage)]);
    }
    return pages;
  }, [notebookTemplates, templatesPerPage]);
  const activeTemplatePage = Math.max(0, Math.min(templatePage, templatePages.length - 1));

  return (
    <>
      <Dialog open={createOpen} onOpenChange={onCreateOpenChange}>
        <DialogContent
          showCloseButton={false}
          aria-busy={isCreatingNotebook}
          className="flowix-notebook-create !fixed !inset-0 !h-dvh !max-h-none !w-full !max-w-none !rounded-none !bg-[var(--frame-bg)] !p-0 !shadow-none"
        >
          {isMac() && <OnboardingTitlebarMac />}
          <WindowsTitlebarControls reserveSpace />
          <main className="flowix-onboarding__main flowix-notebook-create__main">
            <div className="flowix-onboarding__content">
              <section className="flowix-onboarding__section">
                <div className="flowix-onboarding__section-heading flowix-onboarding__section-heading--setup">
                  {createMode === 'cloud' ? (
                    <>
                      <button
                        type="button"
                        onClick={onBackToCreate}
                        className="flowix-notebook-create__back"
                        aria-label={t('notebook.cloudImport.back')}
                        title={t('notebook.cloudImport.back')}
                      >
                        <ArrowLeft className="h-4 w-4" />
                        {t('notebook.cloudImport.back')}
                      </button>
                      <h1>{t('notebook.cloudImport.title')}</h1>
                    </>
                  ) : (
                    <h1>{t("notebook.create.title")}</h1>
                  )}
                  {createMode === 'create' && (
                    <p>你可以通过使用标签、属性等方式，轻松组织你的内容。每个笔记本也是独立的 Agent 工作空间，可安装技能、MCP、AI 插件和子 Agent。相关配置仅对当前笔记本生效。</p>
                  )}
                </div>
          {createMode === 'cloud' ? (
            <div className="flowix-notebook-create__cloud">
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
                <div className="max-h-[min(55vh,560px)] space-y-2 overflow-y-auto pr-1">
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
            <form
              id="flowix-create-notebook-form"
              className="flowix-onboarding__notebook-form"
              onSubmit={(event) => {
                event.preventDefault();
                onConfirmCreate();
              }}
            >
              <div className="flowix-onboarding__form-field">
                <label htmlFor="create-notebook-name">{t('notebook.create.namePlaceholder')}</label>
                <div className="flowix-onboarding__name-row">
                  <Input
                    id="create-notebook-name"
                    placeholder={t("notebook.create.namePlaceholder")}
                    value={newNotebookName}
                    onChange={(event) => onNewNotebookNameChange(event.target.value)}
                    autoFocus
                    className="h-10"
                  />
                  <NotebookIconPopover
                    value={newNotebookIcon}
                    notebookName={newNotebookName}
                    onChange={onNewNotebookIconChange}
                  />
                </div>
              </div>
              <div className="flowix-onboarding__form-field">
                <label htmlFor="create-notebook-path">{t("notebook.create.pathLabel")}</label>
                <div className="flowix-onboarding__path-field">
                  <Input
                    id="create-notebook-path"
                    placeholder={t("notebook.create.pathPlaceholder")}
                    value={newNotebookPath || newNotebookDefaultPath}
                    disabled
                    className="h-10 min-w-0"
                    readOnly
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 shrink-0"
                    onClick={() => void onSelectDirectory()}
                  >
                    {t("notebook.create.selectDirectory")}
                  </Button>
                </div>
              </div>
              <div className="flowix-onboarding__form-field flowix-onboarding__template-field">
                <div className="flowix-onboarding__template-label-row">
                  <span id="create-notebook-template-label">从以下场景新建（可选）</span>
                  {templatePages.length > 1 && (
                    <div className="flowix-onboarding__template-pagination" aria-label="模板分页">
                      <button
                        type="button"
                        className="flowix-onboarding__template-page-button"
                        aria-label="上一页模板"
                        disabled={activeTemplatePage === 0}
                        onClick={() => setTemplatePage((page) => Math.max(0, page - 1))}
                      >
                        <ChevronLeft size={15} aria-hidden="true" />
                      </button>
                      <span aria-live="polite">{activeTemplatePage + 1} / {templatePages.length}</span>
                      <button
                        type="button"
                        className="flowix-onboarding__template-page-button"
                        aria-label="下一页模板"
                        disabled={activeTemplatePage === templatePages.length - 1}
                        onClick={() => setTemplatePage((page) => Math.min(templatePages.length - 1, page + 1))}
                      >
                        <ChevronRight size={15} aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </div>
                {notebookTemplateStatus === 'loading' && (
                  <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
                    {t('notebook.template.loading')}
                  </p>
                )}
                {notebookTemplateStatus === 'error' && (
                  <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
                    <span>{t('notebook.template.loadFailed')}</span>
                    <Button type="button" variant="outline" size="sm" className="h-7 shrink-0" onClick={retryNotebookTemplates}>
                      {t('error.retry')}
                    </Button>
                  </div>
                )}
                {notebookTemplateStatus === 'ready' && notebookTemplates.length === 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">{t('notebook.template.empty')}</p>
                )}
                <div
                  className="flowix-onboarding__template-grid"
                  role="group"
                  aria-labelledby="create-notebook-template-label"
                >
                  <div
                    className="flowix-onboarding__template-track"
                    style={{ transform: `translateX(-${activeTemplatePage * 100}%)` }}
                  >
                    {templatePages.map((templates, pageIndex) => (
                      <div className="flowix-onboarding__template-page" key={`template-page-${pageIndex}`}>
                        {templates.map((template) => {
                          const templateIndex = notebookTemplates.findIndex((item) => item.id === template.id);
                          const selected = template.id === newNotebookTemplateId;
                          return (
                            <button
                              key={template.id}
                              type="button"
                              aria-pressed={selected}
                              className={cn(
                                'flowix-onboarding__template-option',
                                selected && 'is-selected',
                              )}
                              onClick={() => {
                                onNewNotebookTemplateIdChange((selected ? null : template.id));
                                setTemplatePage(Math.floor(templateIndex / templatesPerPage));
                              }}
                            >
                              <span className="flowix-onboarding__template-option-icon">
                                <NotebookTemplateIcon icon={template.icon} />
                              </span>
                              <span className="flowix-onboarding__template-option-copy">
                                <strong>{template.name}</strong>
                                <small>{template.description}</small>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </form>
          )}
              </section>
            </div>
            <div className="flowix-onboarding__actions">
              <div className="flowix-notebook-create__actions-end">
                <button
                  type="button"
                  onClick={onCancelCreate}
                  disabled={isCreatingNotebook}
                  className="flowix-onboarding__skip-action"
                >
                  {t("notebook.create.cancel")}
                </button>
                {createMode === 'create' && (
                  <button
                    type="submit"
                    form="flowix-create-notebook-form"
                    className="flowix-onboarding__primary-action"
                    disabled={isCreatingNotebook || !newNotebookName.trim()}
                    aria-busy={isCreatingNotebook}
                  >
                    {isCreatingNotebook ? (
                      <>
                        <Loader2 size={17} className="animate-spin" aria-hidden="true" />
                        {t("notebook.create.creating")}
                      </>
                    ) : (
                      <>
                        {t("notebook.create.confirm")}
                        <ArrowRight size={17} aria-hidden="true" />
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          </main>
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
