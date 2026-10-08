'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  CircleAlert,
  CircleCheck,
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
  deepseekHarness,
  dialogs,
  notebooks,
  type NotebookRecord,
} from '@platform/tauri/client';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import { useAgentAccessStore } from '@features/agent/store/agent-access-store';
import { resolveNotebookAgentFiles } from '@/lib/agent-access-defaults';
import { useNoteStore } from '@features/memo/store/note-store';
import { createNotebookRegistration, notebookRepository } from '@features/memo/services';
import { useI18n } from '@/lib/i18n';
import type { DshRuntimeInstallerState } from '@features/preferences/public/system-api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import { isMac } from '@features/shortcuts';
import { openUrl } from '@platform/tauri/opener';
import {
  AgentSection,
  type AgentSectionModelFormActions,
} from '@features/preferences/sections/agent';
import { useNotebookTemplates } from './notebook-templates';
import { NotebookTemplateCardPreview, NotebookTemplateEmptyCard, NotebookTemplatePicker } from './notebook-template-picker';
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

type OnboardingStep = 0 | 1 | 2 | 3;

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

function StepRail({
  step,
  onStepChange,
}: {
  step: OnboardingStep;
  onStepChange: (step: OnboardingStep) => void;
}) {
  const activeRailStep = step === 2 ? 1 : step;
  const items: Array<{ step: OnboardingStep; targetStep: OnboardingStep; title: string }> = [
    { step: 0, targetStep: 0, title: '创建笔记本' },
    { step: 1, targetStep: 1, title: '接入 Agent' },
    { step: 3, targetStep: 3, title: '授权仓库' },
  ];

  return (
    <nav
      className="mx-auto grid w-[min(100%,640px)] border-b border-[var(--onboarding-line)] pb-[14px]"
      aria-label="新用户引导步骤"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map((item) => {
        const completed = item.step < activeRailStep;
        const active = item.step === activeRailStep;
        return (
          <button
            key={item.title}
            type="button"
            className={cn(
              'flex w-full min-w-0 items-center justify-center gap-[9px] bg-transparent py-2 text-center text-[var(--onboarding-subtle)] opacity-[0.58] transition-[color,opacity] duration-[160ms] enabled:cursor-pointer enabled:hover:text-[var(--onboarding-ink)] enabled:hover:opacity-[0.82] max-[760px]:items-start max-[760px]:gap-[7px]',
              active && 'text-[var(--onboarding-ink)] opacity-[0.82]',
              completed && 'text-[var(--onboarding-subtle)] opacity-[0.68]',
            )}
            onClick={() => item.targetStep <= step && onStepChange(item.targetStep)}
            aria-current={active ? 'step' : undefined}
            disabled={item.targetStep > step}
          >
            <span className="grid">
              <strong className="text-xs font-medium tracking-[-0.01em] max-[760px]:text-[11px]">{item.title}</strong>
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
      <div className="mt-[42px] w-full">
      <div className="col-span-full text-sm font-semibold text-[var(--onboarding-ink)]">
        {hasAvailableAgent ? '已找到以下本地 AI 可用' : '未找到本地 AI，推荐安装以下任一'}
      </div>
      <div className="mt-[10px] grid w-[min(100%,720px)] grid-cols-4 gap-[10px] max-[760px]:grid-cols-2">
        {visibleAgentKeys.map((typeKey) => {
        const type = getAgentType(typeKey);
        const status = statusByType[typeKey];
        const codexVersionTooLow = typeKey === 'codex'
          && (status?.reasonCode === CODEX_VERSION_TOO_LOW_CODE || status?.reason === CODEX_VERSION_TOO_LOW_REASON);
        const installed = typeKey === 'deepseek-harness'
          ? dshInstalled
          : !codexVersionTooLow && Boolean(status?.installed ?? status?.available);
        return (
          <div className="flex min-h-[213px] min-w-0 flex-col items-center justify-start gap-[10px] rounded-[13px] border border-[var(--onboarding-line)] bg-[color-mix(in_oklch,var(--card)_48%,transparent)] px-[10px] pb-[15px] pt-[18px] text-center max-[760px]:min-h-[198px] max-[760px]:px-2 max-[760px]:pb-[13px] max-[760px]:pt-[15px]">
            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--onboarding-line)] bg-[color-mix(in_oklch,var(--card)_72%,transparent)]">
              <AgentIcon typeKey={typeKey} alt={type.name} className="h-7 w-7 object-contain" />
            </span>
            <span className="grid max-w-full min-w-0 gap-1">
              <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold tracking-[-0.02em] text-[var(--onboarding-ink)]">{type.name}</strong>
            </span>
            <div className="flex min-h-[52px] w-full flex-1 flex-col items-center justify-end gap-2">
              {typeKey === 'deepseek-harness' && dshInstaller.busy && dshInstaller.progress && (
                <UpdateProgress
                  className="w-[min(100%,148px)] text-left"
                  value={dshInstaller.progress}
                  label={dshInstaller.progress.phase === 'installing' ? '正在安装' : '正在下载'}
                />
              )}
              {typeKey === 'deepseek-harness' && !dshInstalled && !dshInstaller.busy && (
                <button type="button" className="inline-flex min-h-[27px] items-center gap-1.5 rounded-[7px] bg-[var(--brand)] px-2.5 text-[11px] font-semibold text-[var(--primary-foreground)] hover:bg-[color-mix(in_oklch,var(--brand)_82%,white)]" onClick={() => void handleInstallDsh()}>
                  安装（80+MB）
                </button>
              )}
              {typeKey === 'deepseek-harness' && dshInstaller.busy && !dshInstaller.progress && (
                <LoaderCircle size={16} className="animate-spin text-[var(--brand)]" aria-label="安装中" />
              )}
              {typeKey === 'codex' && (!status?.installed || codexVersionTooLow) && (
                <button
                  type="button"
                  className="inline-flex min-h-[27px] items-center gap-1.5 rounded-[7px] border border-[var(--onboarding-line)] bg-[color-mix(in_oklch,var(--card)_72%,transparent)] px-2.5 text-[11px] font-semibold text-[var(--onboarding-ink)] hover:bg-[color-mix(in_oklch,var(--card)_90%,transparent)]"
                  onClick={() => void openUrl(CODEX_DOCS_URL)}
                >
                  安装引导
                </button>
              )}
              <span className={cn('inline-flex max-w-full items-center justify-center gap-1.5 text-center text-[11px] leading-[1.35] text-[var(--onboarding-subtle)]', installed && 'text-[var(--success)]')}>
                {installed ? <CircleCheck size={15} aria-hidden="true" /> : <span className="h-1.5 w-1.5 rounded-full bg-[var(--onboarding-subtle)]" />}
                {agentStatusLabel(typeKey, status, isChecking, dshInstaller)}
              </span>
            </div>
          </div>
        );
      })}
      <div className="col-span-full flex items-center justify-start gap-3 pt-[15px] text-[11px] text-[var(--onboarding-subtle)]">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 bg-transparent p-0 text-[var(--onboarding-subtle)] transition-colors hover:text-[var(--onboarding-ink)] disabled:cursor-wait disabled:opacity-[0.68]"
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
        <div className="col-span-full flex items-start gap-[7px] text-xs leading-[1.5] text-[var(--destructive)]" role="alert">
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
  const [isTemplatePickerOpen, setIsTemplatePickerOpen] = useState(false);
  const [defaultPath, setDefaultPath] = useState<string | null>(null);
  const [notebookName, setNotebookName] = useState(DEFAULT_NOTEBOOK_NAME);
  const [notebookPath, setNotebookPath] = useState<string | null>(null);
  const [notebookIcon, setNotebookIcon] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [createdNotebook, setCreatedNotebook] = useState<NotebookRecord | null>(null);
  const [shouldStartImport, setShouldStartImport] = useState(false);
  const [dshModelListState, setDshModelListState] = useState<'unknown' | 'empty' | 'configured' | 'error'>('unknown');
  const [isCreatingNotebook, setIsCreatingNotebook] = useState(false);
  const [isAddingRepository, setIsAddingRepository] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const dshModelActionsRef = useRef<AgentSectionModelFormActions | null>(null);
  const [dshModelActionsReady, setDshModelActionsReady] = useState(false);
  const [dshModelAction, setDshModelAction] = useState<'save' | 'test' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const statusByType = useAgentRuntimeStore((state) => state.statusByType);
  const refreshAgentRuntime = useAgentRuntimeStore((state) => state.refresh);
  const accessConfig = useAgentAccessStore((state) => state.config);
  const notebookConfigs = useAgentAccessStore((state) => state.notebookConfigs);
  const addFolderFromPicker = useAgentAccessStore((state) => state.addFolderFromPicker);
  const setDefaultFiles = useAgentAccessStore((state) => state.setDefaultFiles);
  const loadAgentAccess = useAgentAccessStore((state) => state.loadInitial);

  const registerDshModelActions = useCallback((actions: AgentSectionModelFormActions | null) => {
    dshModelActionsRef.current = actions;
    setDshModelActionsReady(Boolean(actions));
  }, []);

  const saveDshModel = useCallback(async (): Promise<boolean> => {
    const actions = dshModelActionsRef.current;
    if (!actions || dshModelAction) return false;
    setDshModelAction('save');
    try {
      return await actions.save();
    } finally {
      setDshModelAction(null);
    }
  }, [dshModelAction]);

  const testDshModel = useCallback(async (): Promise<boolean> => {
    const actions = dshModelActionsRef.current;
    if (!actions || dshModelAction) return false;
    setDshModelAction('test');
    try {
      return await actions.test();
    } finally {
      setDshModelAction(null);
    }
  }, [dshModelAction]);

  const continueFromDshModel = useCallback(async () => {
    if (!(await testDshModel())) return;
    if (await saveDshModel()) {
      setDshModelListState('configured');
      setStep(3);
    }
  }, [saveDshModel, testDshModel]);

  useEffect(() => {
    void refreshAgentRuntime({ force: true });
    void loadAgentAccess();
  }, [loadAgentAccess, refreshAgentRuntime]);

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
  useEffect(() => {
    if (!dshInstalled) {
      setDshModelListState('unknown');
      return;
    }

    let cancelled = false;
    setDshModelListState('unknown');
    void deepseekHarness.list()
      .then((configs) => {
        if (cancelled) return;
        setDshModelListState(configs.some(({ model }) =>
          Boolean(model.model.trim() || model.models?.length),
        ) ? 'configured' : 'empty');
      })
      .catch(() => {
        // A failed listing is not proof that the model list is empty. Keep
        // the state distinct so the optional setup page is skipped.
        if (!cancelled) setDshModelListState('error');
      });
    return () => { cancelled = true; };
  }, [dshInstalled]);
  const showDshModelStep = dshInstalled && dshModelListState === 'empty';
  const effectiveStatusByType = MOCK_EMPTY_AGENT_ENVIRONMENT ? {} : statusByType;
  const hasAvailableLocalAgent = ['codex', 'claude', 'opencode'].some(
    (typeKey) => effectiveStatusByType[typeKey as AgentTypeKey]?.available,
  );
  const canContinueWithAgent = dshInstalled || hasAvailableLocalAgent;

  useEffect(() => {
    if (step === 2 && !showDshModelStep) setStep(3);
  }, [showDshModelStep, step]);
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
      let registration: Awaited<ReturnType<typeof createNotebookRegistration>>;
      try {
        registration = await createNotebookRegistration({
          name,
          path: notebookPath ?? undefined,
          icon: notebookIcon,
          templateId: selectedTemplateId,
          reuseExisting: true,
        });
      } catch (value) {
        if (
          !selectedTemplateId
          || !String(value).includes('NOTEBOOK_PRESET_OVERWRITE_CONFIRM_REQUIRED')
        ) {
          throw value;
        }
        if (!await notebookRepository.confirmPresetOverwrite(t('notebook.template.overwriteConfirm'))) return;
        registration = await createNotebookRegistration({
          name,
          path: notebookPath ?? undefined,
          icon: notebookIcon,
          templateId: selectedTemplateId,
          overwriteExisting: true,
          reuseExisting: true,
        });
      }
      const notebook = registration.notebook;
      if (registration.setupJob?.templateId) {
        setSelectedTemplateId(registration.setupJob.templateId);
      }
      setDefaultPath(notebook.path);
      const latest = await notebookRepository.list();
      useNoteStore.getState().setNotebooks(latest);
      setCreatedNotebook(notebook);
      setShouldStartImport(registration.needsImport && !registration.hasTemplateSetup);
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
      className="fixed inset-0 z-[220] flex flex-col overflow-hidden bg-[var(--frame-bg)] text-[var(--foreground)] [--onboarding-form-gap:22px] [--onboarding-ink:var(--foreground)] [--onboarding-subtle:var(--muted-foreground)] [--onboarding-panel:color-mix(in_oklch,var(--card)_96%,var(--background))] [--onboarding-line:color-mix(in_oklch,var(--border)_78%,transparent)] animate-[flowix-onboarding-in_520ms_cubic-bezier(0.16,1,0.3,1)_both] motion-reduce:animate-none max-[760px]:overflow-y-auto [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-[var(--ring)] [&_button:focus-visible]:outline-offset-[3px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby={step === 0
        ? 'flowix-onboarding-notebook-title'
        : step === 1
          ? 'flowix-onboarding-title'
          : step === 2
            ? 'flowix-onboarding-dsh-model-title'
            : 'flowix-onboarding-access-title'}
    >
      {isMac() && <OnboardingTitlebarMac />}
      <WindowsTitlebarControls reserveSpace />
      <main className="relative z-[1] flex min-h-0 w-full flex-1 flex-col px-[clamp(28px,6vw,96px)] pb-[clamp(22px,3vw,44px)] max-[760px]:px-5 max-[760px]:pb-[26px]">
        <StepRail
          step={step}
          onStepChange={setStep}
        />

        <div className="mx-auto flex min-h-0 w-[min(100%,780px)] flex-1 flex-col items-start justify-start overflow-y-auto overscroll-contain">
          {step === 0 && (
            <section className="w-full animate-[flowix-onboarding-section-in_500ms_ease-out_both] motion-reduce:animate-none py-[clamp(11px,1.33vw,16px)] pb-4" aria-labelledby="flowix-onboarding-notebook-title">
              <div className="max-w-full">
                <h1 className="text-[clamp(23px,3.33vw,44px)] font-light leading-[0.98] tracking-[-0.065em] text-[var(--onboarding-ink)]" id="flowix-onboarding-notebook-title">创建你的第一个笔记本</h1>
                <p className="mt-6 max-w-full text-sm leading-[1.72] text-[var(--onboarding-subtle)]">填写笔记本名称和存储位置，也可以选择一个场景模板开始使用。</p>
              </div>
              <form
                id="flowix-onboarding-notebook-form"
                className="mt-[22px] grid w-[min(100%,780px)] grid-cols-[minmax(0,1fr)_320px] items-start gap-x-[22px] gap-y-4 p-0 max-[760px]:grid-cols-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createNotebook();
                }}
              >
                <div className="grid min-w-0 content-start gap-4 pr-[38px] max-[760px]:pr-0">
                  <div className="grid min-w-0 gap-1">
                    <label className="text-sm font-semibold text-[var(--foreground)]" htmlFor="flowix-onboarding-notebook-name">笔记本名称</label>
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                      <Input
                        id="flowix-onboarding-notebook-name"
                        value={notebookName}
                        onChange={(event) => setNotebookName(event.target.value)}
                        autoFocus
                        className="h-10 bg-[var(--card)]"
                      />
                      <NotebookIconPopover
                        value={notebookIcon}
                        notebookName={notebookName}
                        onChange={setNotebookIcon}
                      />
                    </div>
                  </div>
                  <div className="grid min-w-0 gap-1">
                    <label className="text-sm font-semibold text-[var(--foreground)]" htmlFor="flowix-onboarding-notebook-path">存储位置</label>
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                      <Input
                        id="flowix-onboarding-notebook-path"
                        value={notebookPath ?? defaultPath ?? ''}
                        placeholder="文档 / flowix / My Notebook"
                        disabled
                        readOnly
                        className="h-10 min-w-0 bg-[var(--card)]"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        className="h-10 shrink-0 bg-[var(--card)]"
                        onClick={() => void selectNotebookDirectory()}
                      >
                        选择目录
                      </Button>
                    </div>
                  </div>
                </div>
                <div className="grid min-w-0 content-start gap-1">
                  <button
                    type="button"
                    className="flex w-full items-center justify-start gap-0.5 p-0 text-left text-sm font-semibold text-[var(--foreground)] hover:text-[var(--brand)]"
                    aria-haspopup="dialog"
                    onClick={() => setIsTemplatePickerOpen(true)}
                  >
                    <span>选择场景模板（可选）</span>
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                  {notebookTemplates.find((template) => template.id === selectedTemplateId) && (
                    <NotebookTemplateCardPreview
                      template={notebookTemplates.find((template) => template.id === selectedTemplateId)!}
                    />
                  )}
                  {!selectedTemplateId && (
                    <NotebookTemplateEmptyCard onClick={() => setIsTemplatePickerOpen(true)} />
                  )}
                </div>
              </form>
            </section>
          )}

          {step === 1 && (
            <section className="w-full animate-[flowix-onboarding-section-in_500ms_ease-out_both] motion-reduce:animate-none py-[clamp(11px,1.33vw,16px)] pb-4" aria-labelledby="flowix-onboarding-title">
              <div className="max-w-full">
                <h1 className="text-[clamp(23px,3.33vw,44px)] font-light leading-[0.98] tracking-[-0.065em] text-[var(--onboarding-ink)]" id="flowix-onboarding-title">请配置 AI 环境</h1>
                <p className="mt-6 max-w-full text-sm leading-[1.72] text-[var(--onboarding-subtle)]">Flowix 以文档为核心，让 AI 更自然地融入您的创作与工作流程。您可以直接连接本机已安装的 Agent，也可以一键安装 DeepSeek Harness，快速开始使用。</p>
              </div>
              <AgentRows
                dshInstaller={dshInstaller}
              />
            </section>
          )}

          {step === 2 && showDshModelStep && (
            <section className="w-full animate-[flowix-onboarding-section-in_500ms_ease-out_both] motion-reduce:animate-none py-[clamp(11px,1.33vw,16px)] pb-4" aria-labelledby="flowix-onboarding-dsh-model-title">
              <div className="max-w-full">
                <h1 className="text-[clamp(23px,3.33vw,44px)] font-light leading-[0.98] tracking-[-0.065em] text-[var(--onboarding-ink)]" id="flowix-onboarding-dsh-model-title">配置 DeepSeek Harness 模型</h1>
                <p className="mt-6 max-w-full text-sm leading-[1.72] text-[var(--onboarding-subtle)]">配置模型将本地保存，不会上传云端，提供给 DeepSeek Harness 使用，配置后可在 偏好设置 中修改。</p>
              </div>
              <AgentSection
                configStore={deepseekHarness}
                configChangeKind="dsh_config"
                testConnection={deepseekHarness.testConnection}
                modelDirectory={deepseekHarness}
                startWithAddModel
                modelFormOnly
                onModelFormActionsReady={registerDshModelActions}
              />
            </section>
          )}

          {step === 3 && createdNotebook && (
            <section className="w-full animate-[flowix-onboarding-section-in_500ms_ease-out_both] motion-reduce:animate-none py-[clamp(11px,1.33vw,16px)] pb-4" aria-labelledby="flowix-onboarding-access-title">
              <div className="max-w-full">
                <h1 className="text-[clamp(23px,3.33vw,44px)] font-light leading-[0.98] tracking-[-0.065em] text-[var(--onboarding-ink)]" id="flowix-onboarding-access-title">继续为 AI 添加可访问的位置</h1>
                <p className="mt-6 max-w-full text-sm leading-[1.72] text-[var(--onboarding-subtle)]">你可以在这里添加更多仓库，供 AI 在工作时查阅参考资料或参与项目代码。已配置的笔记本会自动作为 AI 的工作空间（cwd），无需重复添加。</p>
              </div>
              <div className="mt-5 border-t border-[var(--onboarding-line)]">
                <div className="flex items-center justify-between gap-[15px] pb-3 pt-[17px]">
                  <div className="grid gap-[5px]"><strong className="text-sm font-semibold text-[var(--onboarding-ink)]">可访问文件夹位置</strong><span className="text-xs text-[var(--onboarding-subtle)]">允许 Agent 在对话中查看、读取和修改以下文件夹中的内容。</span></div>
                </div>
                <div className="mb-3 flex justify-start">
                  <Button type="button" variant="outline" className="h-10" onClick={() => void addRepository()} disabled={isAddingRepository}>
                    {isAddingRepository ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />} 添加 本地资料 或 代码仓库
                  </Button>
                </div>
                {selectedRepositories.length > 0 && (
                  <div className="grid gap-[7px]">
                    {selectedRepositories.map((repo) => (
                      <div className="flex items-center gap-[11px] rounded-[10px] border border-[var(--onboarding-line)] bg-[color-mix(in_oklch,var(--card)_72%,transparent)] p-[10px]" key={repo.path}>
                        <span className="inline-flex h-[29px] w-[29px] shrink-0 items-center justify-center rounded-[7px] bg-[color-mix(in_oklch,var(--brand)_10%,transparent)] text-[var(--brand)]"><FolderOpen size={17} aria-hidden="true" /></span>
                        <span className="grid min-w-0 flex-1 gap-1"><strong className="overflow-hidden text-ellipsis whitespace-nowrap text-xs font-semibold text-[var(--onboarding-ink)]">{repo.name}</strong><small className="text-xs text-[var(--onboarding-subtle)]">{repo.path}</small></span>
                        <button type="button" className="inline-flex h-[25px] w-[25px] items-center justify-center rounded-md text-[var(--onboarding-subtle)] hover:bg-[color-mix(in_oklch,var(--destructive)_10%,transparent)] hover:text-[var(--destructive)]" aria-label={`移除 ${repo.name}`} onClick={() => void removeRepository(repo.path)}><X size={15} aria-hidden="true" /></button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {error && (
            <div className="mt-5 flex items-start gap-[7px] text-xs leading-[1.5] text-[var(--destructive)]" role="alert"><CircleAlert size={15} aria-hidden="true" /> {error}</div>
          )}
        </div>

        <div className="sticky bottom-0 z-[2] mx-auto flex min-h-[62px] w-[min(100%,780px)] flex-[0_0_auto] items-center justify-end gap-[18px] border-t border-[var(--onboarding-line)] bg-[var(--frame-bg)] pt-[18px] max-[760px]:min-h-[58px] max-[760px]:pt-[14px]">
          {step === 0 && (
            <button
              type="submit"
              form="flowix-onboarding-notebook-form"
              className="inline-flex min-h-[38px] items-center justify-center gap-1 rounded-[9px] border border-[var(--brand)] bg-[var(--brand)] px-[15px] text-xs font-semibold text-[var(--primary-foreground)] shadow-[0_8px_18px_color-mix(in_oklch,var(--brand)_18%,transparent)] transition-transform hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-[0.46] max-[760px]:flex-1"
              disabled={isCreatingNotebook || !notebookName.trim() || (!notebookPath && !defaultPath)}
            >
              {isCreatingNotebook
                ? <><LoaderCircle size={17} className="animate-spin" aria-hidden="true" /> 正在创建</>
                : <>新建笔记本 <ArrowRight size={17} aria-hidden="true" /></>}
            </button>
          )}

          {step === 1 && (
            <>
              <button type="button" className="mr-auto inline-flex min-h-[38px] items-center justify-center gap-2 border border-transparent bg-transparent pl-0 text-xs font-semibold text-[var(--onboarding-subtle)] hover:text-[var(--onboarding-ink)]" onClick={() => setStep(0)}>
                <ArrowLeft size={16} aria-hidden="true" /> 返回
              </button>
              <button type="button" className="inline-flex min-h-[38px] items-center justify-center gap-2 rounded-[9px] border border-[var(--onboarding-line)] bg-transparent px-[15px] text-xs font-medium text-[var(--onboarding-subtle)] hover:text-[var(--onboarding-ink)] disabled:cursor-not-allowed disabled:opacity-[0.46]" onClick={() => void finish()} disabled={isFinishing}>
                跳过 AI 配置
              </button>
              <button
                type="button"
                className="inline-flex min-h-[38px] items-center justify-center gap-2 rounded-[9px] border border-[var(--brand)] bg-[var(--brand)] px-[15px] text-xs font-semibold text-[var(--primary-foreground)] shadow-[0_8px_18px_color-mix(in_oklch,var(--brand)_18%,transparent)] transition-transform hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-[0.46] max-[760px]:flex-1"
                disabled={
                  !canContinueWithAgent
                  || dshInstaller.busy
                  || (dshInstalled && dshModelListState === 'unknown')
                }
                onClick={() => setStep(showDshModelStep ? 2 : 3)}
              >
                下一步 <ArrowRight size={17} aria-hidden="true" />
              </button>
            </>
          )}

          {step === 2 && showDshModelStep && (
            <>
              <button
                type="button"
                className="mr-auto inline-flex min-h-[38px] items-center justify-center gap-2 border border-transparent bg-transparent pl-0 text-xs font-semibold text-[var(--onboarding-subtle)] hover:text-[var(--onboarding-ink)] disabled:cursor-not-allowed disabled:opacity-[0.46]"
                onClick={() => setStep(1)}
                disabled={dshModelAction !== null}
              >
                <ArrowLeft size={16} aria-hidden="true" /> 返回
              </button>
              <button
                type="button"
                className="inline-flex min-h-[38px] items-center justify-center gap-2 rounded-[9px] border border-[var(--onboarding-line)] bg-transparent px-[15px] text-xs font-medium text-[var(--onboarding-subtle)] hover:text-[var(--onboarding-ink)] disabled:cursor-not-allowed disabled:opacity-[0.46]"
                onClick={() => setStep(3)}
                disabled={dshModelAction !== null}
              >
                跳过
              </button>
              <button
                type="button"
                className="inline-flex min-h-[38px] items-center justify-center gap-2 rounded-[9px] border border-[var(--brand)] bg-[var(--brand)] px-[15px] text-xs font-semibold text-[var(--primary-foreground)] shadow-[0_8px_18px_color-mix(in_oklch,var(--brand)_18%,transparent)] transition-transform hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-[0.46] max-[760px]:flex-1"
                onClick={() => void continueFromDshModel()}
                disabled={!dshModelActionsReady || dshModelAction !== null}
              >
                {dshModelAction !== null ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : null}
                下一步 <ArrowRight size={17} aria-hidden="true" />
              </button>
            </>
          )}

          {step === 3 && createdNotebook && (
            <>
              <button
                type="button"
                className="mr-auto inline-flex min-h-[38px] items-center justify-center gap-2 border border-transparent bg-transparent pl-0 text-xs font-semibold text-[var(--onboarding-subtle)] hover:text-[var(--onboarding-ink)] disabled:cursor-not-allowed disabled:opacity-[0.46]"
                onClick={() => setStep(showDshModelStep ? 2 : 1)}
                disabled={isFinishing}
              >
                <ArrowLeft size={16} aria-hidden="true" /> 返回
              </button>
              <button type="button" className="inline-flex min-h-[38px] items-center justify-center gap-2 rounded-[9px] border border-[var(--brand)] bg-[var(--brand)] px-[15px] text-xs font-semibold text-[var(--primary-foreground)] shadow-[0_8px_18px_color-mix(in_oklch,var(--brand)_18%,transparent)] transition-transform hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-[0.46] max-[760px]:flex-1" onClick={() => void finish()} disabled={isFinishing}>
                {isFinishing ? <><LoaderCircle size={17} className="animate-spin" /> 正在进入</> : <>开始使用</>}
              </button>
            </>
          )}
        </div>
        {isTemplatePickerOpen && (
          <NotebookTemplatePicker
            templates={notebookTemplates}
            status={notebookTemplateStatus}
            retry={retryNotebookTemplates}
            initialTemplateId={selectedTemplateId}
            onCancel={() => setIsTemplatePickerOpen(false)}
            onComplete={(templateId) => {
              setSelectedTemplateId(templateId);
              setIsTemplatePickerOpen(false);
            }}
          />
        )}
      </main>
    </div>
  );
}
