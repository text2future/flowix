'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  CircleCheck,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  LoaderCircle,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import { AgentIcon } from '@features/agent/components/agent-icon';
import { getAgentType } from '@/lib/agent-types';
import type { AgentTypeKey } from '@/types/agent';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { UpdateProgress } from '@shared/ui/update-progress';
import { NotebookIconPopover } from '@features/memo/components/notebook-icon-popover';
import {
  dialogs,
  notebooks,
  type NotebookRecord,
} from '@platform/tauri/client';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import { useAgentAccessStore } from '@features/agent/store/agent-access-store';
import { resolveNotebookAgentFiles } from '@/lib/agent-access-defaults';
import { useMemoStore } from '@features/memo/store/memo-store';
import { createNotebookRegistration, notebookRepository } from '@features/memo/services';
import { useI18n } from '@/lib/i18n';
import { notebookCreateErrorMessage } from '@platform/tauri/errors';
import type { DshRuntimeInstallerState } from '@features/preferences/public/system-api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import { isMac } from '@features/shortcuts';
import { openUrl } from '@platform/tauri/opener';
import {
  initializeNotebookTemplate,
  useNotebookTemplates,
} from './notebook-templates';
import { NotebookTemplateIcon } from './notebook-template-icon';
import { OnboardingTitlebarMac } from './onboarding-titlebar-mac';

const DEFAULT_BOOK_FOLDER = 'My Notebook';
const DEFAULT_NOTEBOOK_NAME = 'My Notebook';
const MOCK_EMPTY_AGENT_ENVIRONMENT = import.meta.env.DEV
  && import.meta.env.VITE_FLOWIX_MOCK_EMPTY_AGENTS === 'true';
const CODEX_VERSION_TOO_LOW_CODE = 'version-too-low';
const CODEX_VERSION_TOO_LOW_REASON = 'codex-version-too-low';
const CODEX_DOCS_URL = 'https://learn.chatgpt.com/docs/codex/cli';
const AGENT_KEYS: readonly AgentTypeKey[] = [
  'codex',
  'deepseek-harness',
  'claude',
  'opencode',
];

type OnboardingStep = 0 | 1 | 2;

function defaultFolderNameForNotebook(name: string): string {
  const trimmed = name.trim();
  return !trimmed || trimmed === DEFAULT_NOTEBOOK_NAME ? DEFAULT_BOOK_FOLDER : trimmed;
}

interface OnboardingScreenProps {
  dshInstaller: DshRuntimeInstallerState;
  onFinish(notebook: NotebookRecord, options: { startImport: boolean }): Promise<void>;
}

function comparablePath(path: string): string {
  return path.trim().replace(/[\\/]+$/, '').toLowerCase();
}

function agentStatusLabel(
  typeKey: AgentTypeKey,
  status: { available?: boolean; installed?: boolean; reasonCode?: string | null; reason?: string | null } | undefined,
  isChecking: boolean,
  dshInstaller: DshRuntimeInstallerState,
): string {
  if (
    typeKey === 'codex'
    && (status?.reasonCode === CODEX_VERSION_TOO_LOW_CODE || status?.reason === CODEX_VERSION_TOO_LOW_REASON)
  ) return '版本过低';
  if (typeKey === 'deepseek-harness' && dshInstaller.busy) return '正在安装内置版';
  if (isChecking && !status) return '正在检查';
  if (status?.available) return '已连接';
  if (status?.installed) return '已安装 · 待配置';
  return status?.reason || '未检测到';
}

function StepRail({ step, onStepChange }: { step: OnboardingStep; onStepChange: (step: OnboardingStep) => void }) {
  const items = [
    { title: '创建笔记本' },
    { title: '接入 Agent' },
    { title: '授权仓库' },
  ] as const;

  return (
    <nav className="flowix-onboarding__rail" aria-label="新用户引导步骤">
      {items.map((item, index) => {
        const itemStep = index as OnboardingStep;
        const completed = itemStep < step;
        const active = itemStep === step;
        return (
          <button
            key={item.title}
            type="button"
            className={cn('flowix-onboarding__rail-item', active && 'is-active', completed && 'is-complete')}
            onClick={() => itemStep <= step && onStepChange(itemStep)}
            aria-current={active ? 'step' : undefined}
            disabled={itemStep > step}
          >
            <span className="flowix-onboarding__rail-copy">
              <strong>{item.title}</strong>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function AgentRows({
  dshInstaller,
}: {
  dshInstaller: DshRuntimeInstallerState;
}) {
  const runtimeStatusByType = useAgentRuntimeStore((state) => state.statusByType);
  const runtimeIsChecking = useAgentRuntimeStore((state) => state.isChecking);
  const refresh = useAgentRuntimeStore((state) => state.refresh);
  const [isRedetecting, setIsRedetecting] = useState(false);
  const statusByType = MOCK_EMPTY_AGENT_ENVIRONMENT ? {} : runtimeStatusByType;
  const isChecking = MOCK_EMPTY_AGENT_ENVIRONMENT ? false : runtimeIsChecking;
  const dshInstalled = Boolean(
    !MOCK_EMPTY_AGENT_ENVIRONMENT
      && (dshInstaller.status?.installed || statusByType['deepseek-harness']?.installed),
  );
  const hasAvailableAgent = AGENT_KEYS.some((typeKey) => {
    if (typeKey === 'deepseek-harness') return dshInstalled;
    return Boolean(statusByType[typeKey]?.available);
  });
  const visibleAgentKeys = hasAvailableAgent
    ? AGENT_KEYS.filter((typeKey) => (
      typeKey === 'deepseek-harness'
      || Boolean(statusByType[typeKey]?.available)
      || (
        typeKey === 'codex'
        && (statusByType[typeKey]?.reasonCode === CODEX_VERSION_TOO_LOW_CODE
          || statusByType[typeKey]?.reason === CODEX_VERSION_TOO_LOW_REASON)
      )
    ))
    : AGENT_KEYS.filter((typeKey) => typeKey === 'codex' || typeKey === 'deepseek-harness');

  const handleInstallDsh = async () => {
    await dshInstaller.install();
    await refresh({ force: true });
  };

  const handleRedetect = async () => {
    if (isRedetecting) return;
    const startedAt = Date.now();
    setIsRedetecting(true);
    try {
      await refresh({ force: true });
    } finally {
      const remaining = Math.max(0, 1000 - (Date.now() - startedAt));
      await new Promise<void>((resolve) => setTimeout(resolve, remaining));
      setIsRedetecting(false);
    }
  };

  return (
    <div className="flowix-onboarding__agent-area">
      <div className="flowix-onboarding__agent-section-title">
        {hasAvailableAgent ? '已找到以下本地 AI 可用。' : '未找到本地 AI，推荐安装以下任一'}
      </div>
      <div className="flowix-onboarding__agent-list">
        {visibleAgentKeys.map((typeKey) => {
        const type = getAgentType(typeKey);
        const status = statusByType[typeKey];
        const codexVersionTooLow = typeKey === 'codex'
          && (status?.reasonCode === CODEX_VERSION_TOO_LOW_CODE || status?.reason === CODEX_VERSION_TOO_LOW_REASON);
        const installed = typeKey === 'deepseek-harness'
          ? dshInstalled
          : !codexVersionTooLow && Boolean(status?.installed ?? status?.available);
        return (
          <div className={cn('flowix-onboarding__agent-row', installed && 'is-installed')} key={typeKey}>
            <span className="flowix-onboarding__agent-icon">
              <AgentIcon typeKey={typeKey} alt={type.name} className="h-7 w-7 object-contain" />
            </span>
            <span className="flowix-onboarding__agent-copy">
              <strong>{type.name}</strong>
            </span>
            <div className="flowix-onboarding__agent-footer">
              {typeKey === 'deepseek-harness' && dshInstaller.busy && dshInstaller.progress && (
                <UpdateProgress
                  className="flowix-onboarding__agent-progress"
                  value={dshInstaller.progress}
                  label={dshInstaller.progress.phase === 'installing' ? '正在安装' : '正在下载'}
                />
              )}
              {typeKey === 'deepseek-harness' && !dshInstalled && !dshInstaller.busy && (
                <button type="button" className="flowix-onboarding__mini-action" onClick={() => void handleInstallDsh()}>
                  安装（80+MB）
                </button>
              )}
              {typeKey === 'deepseek-harness' && dshInstaller.busy && !dshInstaller.progress && (
                <LoaderCircle size={16} className="animate-spin text-[var(--brand)]" aria-label="安装中" />
              )}
              {typeKey === 'codex' && (!status?.installed || codexVersionTooLow) && (
                <button
                  type="button"
                  className="flowix-onboarding__mini-action flowix-onboarding__mini-action--secondary"
                  onClick={() => void openUrl(CODEX_DOCS_URL)}
                >
                  安装引导
                </button>
              )}
              <span className={cn('flowix-onboarding__agent-status', installed && 'is-ready')}>
                {installed ? <CircleCheck size={15} aria-hidden="true" /> : <span className="flowix-onboarding__status-dot" />}
                {agentStatusLabel(typeKey, status, isChecking, dshInstaller)}
              </span>
            </div>
          </div>
        );
      })}
      <div className="flowix-onboarding__agent-footnote">
        <button
          type="button"
          className="flowix-onboarding__text-action"
          onClick={() => void handleRedetect()}
          disabled={isRedetecting}
        >
          {isRedetecting
            ? <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
            : <RefreshCw size={13} aria-hidden="true" />}
          {isRedetecting ? '检测中' : '重新检测'}
        </button>
      </div>
      {dshInstaller.error && (
        <div className="flowix-onboarding__inline-error" role="alert">
          <CircleAlert size={15} aria-hidden="true" /> {dshInstaller.error}
        </div>
      )}
      </div>
    </div>
  );
}

export function OnboardingScreen({ dshInstaller, onFinish }: OnboardingScreenProps) {
  const { t } = useI18n();
  const {
    templates: notebookTemplates,
    status: notebookTemplateStatus,
    retry: retryNotebookTemplates,
  } = useNotebookTemplates();
  const [step, setStep] = useState<OnboardingStep>(0);
  const [defaultPath, setDefaultPath] = useState<string | null>(null);
  const [notebookName, setNotebookName] = useState(DEFAULT_NOTEBOOK_NAME);
  const [notebookPath, setNotebookPath] = useState<string | null>(null);
  const [notebookIcon, setNotebookIcon] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [templatesPerPage, setTemplatesPerPage] = useState(3);
  const [templatePage, setTemplatePage] = useState(0);
  const [createdNotebook, setCreatedNotebook] = useState<NotebookRecord | null>(null);
  const [shouldStartImport, setShouldStartImport] = useState(false);
  const [isCreatingNotebook, setIsCreatingNotebook] = useState(false);
  const [isAddingRepository, setIsAddingRepository] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statusByType = useAgentRuntimeStore((state) => state.statusByType);
  const refreshAgentRuntime = useAgentRuntimeStore((state) => state.refresh);
  const accessConfig = useAgentAccessStore((state) => state.config);
  const notebookConfigs = useAgentAccessStore((state) => state.notebookConfigs);
  const addFolderFromPicker = useAgentAccessStore((state) => state.addFolderFromPicker);
  const setDefaultFiles = useAgentAccessStore((state) => state.setDefaultFiles);
  const loadAgentAccess = useAgentAccessStore((state) => state.loadInitial);

  useEffect(() => {
    void refreshAgentRuntime({ force: true });
    void loadAgentAccess();
  }, [loadAgentAccess, refreshAgentRuntime]);

  useEffect(() => {
    const updateTemplatesPerPage = () => {
      setTemplatesPerPage(window.innerWidth < 760 ? 1 : 3);
    };
    updateTemplatesPerPage();
    window.addEventListener('resize', updateTemplatesPerPage);
    return () => window.removeEventListener('resize', updateTemplatesPerPage);
  }, []);

  useEffect(() => {
    if (step !== 0 || notebookPath) {
      return;
    }
    setDefaultPath(null);
    void notebooks.getDefaultPath(defaultFolderNameForNotebook(notebookName))
      .then(setDefaultPath)
      .catch(() => {
        // The fallback keeps the setup form useful in browser/dev shells.
      });
  }, [notebookName, notebookPath, step]);

  const dshInstalled = Boolean(
    !MOCK_EMPTY_AGENT_ENVIRONMENT
      && (dshInstaller.status?.installed || statusByType['deepseek-harness']?.installed),
  );
  const effectiveStatusByType = MOCK_EMPTY_AGENT_ENVIRONMENT ? {} : statusByType;
  const hasAvailableLocalAgent = ['codex', 'claude', 'opencode'].some(
    (typeKey) => effectiveStatusByType[typeKey as AgentTypeKey]?.available,
  );
  const canContinueWithAgent = dshInstalled || hasAvailableLocalAgent;
  const templatePages = useMemo(() => {
    const pages: Array<Array<(typeof notebookTemplates)[number]>> = [];
    for (let index = 0; index < notebookTemplates.length; index += templatesPerPage) {
      pages.push([...notebookTemplates.slice(index, index + templatesPerPage)]);
    }
    return pages;
  }, [notebookTemplates, templatesPerPage]);
  const activeTemplatePage = Math.max(0, Math.min(templatePage, templatePages.length - 1));

  const selectedRepositories = useMemo(() => {
    if (!createdNotebook) return [];
    const local = notebookConfigs[createdNotebook.id];
    const paths = local?.addDirs.filter((directory) => directory.enabled).map((directory) => directory.path) ?? [];
    return paths.map((path) => {
      const entry = accessConfig.entries.find((item) => comparablePath(item.path) === comparablePath(path));
      return { path, name: entry?.name ?? path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path };
    });
  }, [accessConfig.entries, createdNotebook, notebookConfigs]);

  const selectNotebookDirectory = useCallback(async () => {
    const path = await dialogs.selectDirectory();
    if (path) {
      setNotebookPath(path);
      setError(null);
    }
  }, []);

  const createNotebook = useCallback(async () => {
    const name = notebookName.trim();
    if (!name) return;
    setIsCreatingNotebook(true);
    setError(null);
    try {
      const registration = await createNotebookRegistration({
        name,
        path: notebookPath ?? undefined,
        icon: notebookIcon,
      });
      const notebook = registration.notebook;
      if (selectedTemplateId) {
        try {
          await initializeNotebookTemplate(notebook.id, selectedTemplateId, registration.created);
        } catch (value) {
          console.error('[Onboarding] Failed to initialize notebook template:', value);
          setError(notebookCreateErrorMessage(value, t));
          return;
        }
      }
      setDefaultPath(notebook.path);
      const latest = await notebookRepository.list();
      useMemoStore.getState().setNotebooks(latest);
      setCreatedNotebook(notebook);
      setShouldStartImport(registration.needsImport);
      await loadAgentAccess();
      setStep(1);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setIsCreatingNotebook(false);
    }
  }, [loadAgentAccess, notebookIcon, notebookName, notebookPath, selectedTemplateId, t]);

  const addRepository = useCallback(async () => {
    if (!createdNotebook) return;
    setIsAddingRepository(true);
    setError(null);
    try {
      const result = await addFolderFromPicker();
      if (!result.ok) {
        if (result.code !== 'not-selected') toast.error(result.code === 'already-tracked' ? '这个仓库已经添加过了' : '仓库授权失败，请重试');
        return;
      }
      const latest = useAgentAccessStore.getState();
      const currentFiles = resolveNotebookAgentFiles(latest.config, latest.notebookConfigs, createdNotebook.id);
      const nextFolders = Array.from(new Set([...(currentFiles?.folders ?? []), result.entry.path]));
      const saved = await setDefaultFiles(createdNotebook.id, {
        folders: nextFolders,
        notebooks: currentFiles?.notebooks ?? [],
      });
      if (!saved) throw new Error('仓库授权没有保存成功');
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setIsAddingRepository(false);
    }
  }, [addFolderFromPicker, createdNotebook, setDefaultFiles]);

  const removeRepository = useCallback(async (path: string) => {
    if (!createdNotebook) return;
    const local = useAgentAccessStore.getState().notebookConfigs[createdNotebook.id];
    const nextFolders = (local?.addDirs ?? [])
      .filter((directory) => directory.enabled && comparablePath(directory.path) !== comparablePath(path))
      .map((directory) => directory.path);
    await setDefaultFiles(createdNotebook.id, { folders: nextFolders, notebooks: [] });
  }, [createdNotebook, setDefaultFiles]);

  const finish = useCallback(async () => {
    if (!createdNotebook) return;
    setIsFinishing(true);
    setError(null);
    try {
      await onFinish(createdNotebook, { startImport: shouldStartImport });
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setIsFinishing(false);
    }
  }, [createdNotebook, onFinish, shouldStartImport]);

  return (
    <div
      className="flowix-onboarding"
      role="dialog"
      aria-modal="true"
      aria-labelledby={step === 0 ? 'flowix-onboarding-notebook-title' : step === 1 ? 'flowix-onboarding-title' : 'flowix-onboarding-access-title'}
    >
      {isMac() && <OnboardingTitlebarMac />}
      <WindowsTitlebarControls />
      <main className="flowix-onboarding__main">
        <StepRail step={step} onStepChange={setStep} />

        <div className="flowix-onboarding__content">
          {step === 0 && (
            <section className="flowix-onboarding__section" aria-labelledby="flowix-onboarding-notebook-title">
              <div className="flowix-onboarding__section-heading flowix-onboarding__section-heading--setup">
                <h1 id="flowix-onboarding-notebook-title">创建你的第一个笔记本</h1>
                <p>你可以通过使用标签、属性等方式，轻松组织你的内容。每个笔记本也是独立的 Agent 工作空间，可安装技能、MCP、AI 插件和子 Agent。相关配置仅对当前笔记本生效。</p>
              </div>
              <form
                id="flowix-onboarding-notebook-form"
                className="flowix-onboarding__notebook-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createNotebook();
                }}
              >
                <div className="flowix-onboarding__form-field flowix-onboarding__name-field">
                  <label htmlFor="flowix-onboarding-notebook-name">笔记本名称</label>
                  <div className="flowix-onboarding__name-row">
                    <Input
                      id="flowix-onboarding-notebook-name"
                      value={notebookName}
                      onChange={(event) => setNotebookName(event.target.value)}
                      autoFocus
                      className="h-10"
                    />
                    <NotebookIconPopover
                      value={notebookIcon}
                      notebookName={notebookName}
                      onChange={setNotebookIcon}
                    />
                  </div>
                </div>
                <div className="flowix-onboarding__form-field">
                  <label htmlFor="flowix-onboarding-notebook-path">存储位置</label>
                  <div className="flowix-onboarding__path-field">
                    <Input
                      id="flowix-onboarding-notebook-path"
                      value={notebookPath ?? defaultPath ?? ''}
                      placeholder="文档 / flowix / My Notebook"
                      disabled
                      readOnly
                      className="h-10 min-w-0"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="h-10 shrink-0"
                      onClick={() => void selectNotebookDirectory()}
                    >
                      选择目录
                    </Button>
                  </div>
                </div>
                <div className="flowix-onboarding__form-field flowix-onboarding__template-field">
                  <div className="flowix-onboarding__template-label-row">
                    <span id="flowix-onboarding-template-label">从以下场景新建</span>
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
                    <div className="flowix-onboarding__inline-error" role="alert">
                      <CircleAlert size={15} aria-hidden="true" />
                      <span>{t('notebook.template.loadFailed')}</span>
                      <Button type="button" variant="outline" size="sm" className="h-7" onClick={retryNotebookTemplates}>
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
                    aria-labelledby="flowix-onboarding-template-label"
                  >
                    <div
                      className="flowix-onboarding__template-track"
                      style={{ transform: `translateX(-${activeTemplatePage * 100}%)` }}
                    >
                      {templatePages.map((templates, pageIndex) => (
                        <div className="flowix-onboarding__template-page" key={`template-page-${pageIndex}`}>
                          {templates.map((template) => {
                            const templateIndex = notebookTemplates.findIndex((item) => item.id === template.id);
                            const selected = template.id === selectedTemplateId;
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
                                  setSelectedTemplateId((current) => current === template.id ? null : template.id);
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
            </section>
          )}

          {step === 1 && (
            <section className="flowix-onboarding__section" aria-labelledby="flowix-onboarding-title">
              <div className="flowix-onboarding__section-heading flowix-onboarding__section-heading--setup">
                <h1 id="flowix-onboarding-title">请配置 AI 环境</h1>
                <p>Flowix 以文档为核心，让 AI 更自然地融入您的创作与工作流程。您可以直接连接本机已安装的 Agent，也可以一键安装 DeepSeek Harness，快速开始使用。</p>
              </div>
              <AgentRows
                dshInstaller={dshInstaller}
              />
            </section>
          )}

          {step === 2 && createdNotebook && (
            <section className="flowix-onboarding__section" aria-labelledby="flowix-onboarding-access-title">
              <div className="flowix-onboarding__section-heading flowix-onboarding__section-heading--setup">
                <h1 id="flowix-onboarding-access-title">继续为 AI 添加可访问的位置</h1>
                <p>你可以在这里添加更多仓库，供 AI 在工作时查阅参考资料或参与项目代码。已配置的笔记本会自动作为 AI 的工作空间（cwd），无需重复添加。</p>
              </div>
              <div className="flowix-onboarding__repo-area">
                <div className="flowix-onboarding__repo-header">
                  <div><strong>可访问文件夹位置</strong><span>允许 Agent 在对话中查看、读取和修改以下文件夹中的内容。</span></div>
                </div>
                <div className="flowix-onboarding__repo-picker">
                  <Button type="button" variant="outline" className="h-10" onClick={() => void addRepository()} disabled={isAddingRepository}>
                    {isAddingRepository ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />} 添加 本地资料 或 代码仓库
                  </Button>
                </div>
                {selectedRepositories.length > 0 && (
                  <div className="flowix-onboarding__repo-list">
                    {selectedRepositories.map((repo) => (
                      <div className="flowix-onboarding__repo-row" key={repo.path}>
                        <span className="flowix-onboarding__repo-folder"><FolderOpen size={17} aria-hidden="true" /></span>
                        <span><strong>{repo.name}</strong><small>{repo.path}</small></span>
                        <button type="button" className="flowix-onboarding__remove-repo" aria-label={`移除 ${repo.name}`} onClick={() => void removeRepository(repo.path)}><X size={15} aria-hidden="true" /></button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {error && (
            <div className="flowix-onboarding__error" role="alert"><CircleAlert size={15} aria-hidden="true" /> {error}</div>
          )}
        </div>

        <div className="flowix-onboarding__actions">
          {step === 0 && (
            <>
              <button
                type="submit"
                form="flowix-onboarding-notebook-form"
                className="flowix-onboarding__primary-action"
                disabled={isCreatingNotebook || !notebookName.trim() || (!notebookPath && !defaultPath)}
              >
                {isCreatingNotebook ? <><LoaderCircle size={17} className="animate-spin" aria-hidden="true" /> 正在创建</> : <>创建我的笔记本 <ArrowRight size={17} aria-hidden="true" /></>}
              </button>
            </>
          )}

          {step === 1 && (
            <>
              <button type="button" className="flowix-onboarding__back-action" onClick={() => setStep(0)}>
                <ArrowLeft size={16} aria-hidden="true" /> 返回
              </button>
              <button type="button" className="flowix-onboarding__skip-action" onClick={() => void finish()} disabled={isFinishing}>
                跳过 AI 配置
              </button>
              <button
                type="button"
                className="flowix-onboarding__primary-action"
                disabled={!canContinueWithAgent || dshInstaller.busy}
                onClick={() => setStep(2)}
              >
                下一步 <ArrowRight size={17} aria-hidden="true" />
              </button>
            </>
          )}

          {step === 2 && createdNotebook && (
            <>
              <button type="button" className="flowix-onboarding__back-action" onClick={() => setStep(1)} disabled={isFinishing}>
                <ArrowLeft size={16} aria-hidden="true" /> 返回
              </button>
              <button type="button" className="flowix-onboarding__primary-action" onClick={() => void finish()} disabled={isFinishing}>
                {isFinishing ? <><LoaderCircle size={17} className="animate-spin" /> 正在进入</> : <>开始使用</>}
              </button>
            </>
          )}
        </div>

      </main>
    </div>
  );
}
