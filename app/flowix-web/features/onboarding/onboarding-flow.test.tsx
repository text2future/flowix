import { act, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotebookImportStatus, NotebookRecord } from '@platform/tauri/client';

// Only unrelated desktop IPC and window chrome are replaced. The wizard,
// notebook policy, import monitoring and retry UI run together.
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  selectDirectory: vi.fn(),
  attachFolder: vi.fn(),
  list: vi.fn(),
  getDefaultPath: vi.fn(),
  getImportStatus: vi.fn(),
  startImport: vi.fn(),
  selectNotebook: vi.fn(),
  listeners: new Set<(status: NotebookImportStatus) => void>(),
}));

vi.mock('@platform/tauri/client', () => ({
  boot: {},
  consumeAppUpdateResult: async () => null,
  dshIntegration: { downloadStatus: async () => null },
  notebooks: {
    getDefaultPath: mocks.getDefaultPath,
  },
  dialogs: { selectDirectory: mocks.selectDirectory },
  listenToNotebookImportStatus: (handler: (status: NotebookImportStatus) => void) => {
    mocks.listeners.add(handler);
    return () => mocks.listeners.delete(handler);
  },
}));
vi.mock('@features/agent/public/workspace-api', () => ({ attachNotebookFolder: mocks.attachFolder }));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: () => () => {} }));
vi.mock('@features/memo/services/note-repository', () => ({ notebookRepository: {
  create: mocks.create, list: mocks.list, getDefaultPath: mocks.getDefaultPath,
  getImportStatus: mocks.getImportStatus,
  startImport: mocks.startImport,
} }));
vi.mock('@features/memo/services', async () => ({
  ...(await import('@features/memo/services/notebook-creation-service')),
  ...(await import('@features/memo/services/note-repository')),
}));
vi.mock('@features/memo/public/shell-api', async () => ({
  ...(await import('@features/memo/services/notebook-creation-service')),
}));
vi.mock('@features/memo/store/note-store', async () => {
  const { create } = await import('zustand');
  type MockNoteStore = {
    selectedNotebook: NotebookRecord | null;
    notebooks: NotebookRecord[];
    startupPhase: 'ready';
    setNotebooks(notebooks: NotebookRecord[]): void;
  };
  return { useNoteStore: create<MockNoteStore>()((set) => ({
    selectedNotebook: null as NotebookRecord | null,
    notebooks: [] as NotebookRecord[],
    startupPhase: 'ready' as const,
    setNotebooks: (notebooks: NotebookRecord[]) => set({ notebooks }),
  })) };
});
vi.mock('@features/workspace/public/shell-api', () => ({ selectNotebook: mocks.selectNotebook }));
vi.mock('@features/preferences/public/app-api', () => ({
  useAppUpdatePreferences: () => ({ loading: false, enabled: false }),
}));
vi.mock('@features/shell/public/system-api', () => ({ useAppUpdater: () => ({}) }));
vi.mock('@shared/window-titlebar-controls', () => ({ WindowsTitlebarControls: () => null }));
vi.mock('@features/shortcuts', () => ({ isMac: () => false, useShortcutScope: () => {} }));
vi.mock('@features/memo/components/notebook-icon-popover', () => ({ NotebookIconPopover: () => null }));

import { I18nProvider } from '@/lib/i18n';
import { admitStartupStage3 } from '@/lib/startup-stage3';
import { useMainWindowSystemController } from '@app/main-window/use-main-window-system-controller';
import { useNoteStore } from '@features/memo/store/note-store';
import { useEmptyNotebookPrompt } from '@features/memo/hooks/use-empty-notebook-prompt';
import { finishOnboardingNotebook } from '@features/shell/use-cases/finish-onboarding';
import { ActionableNoticeHost } from '@features/notifications/actionable-notice-host';
import { clearActionableNotice, getActionableNotices } from '@features/notifications/actionable-notice-store';
import { OnboardingScreen } from './onboarding-screen';

const notebook: NotebookRecord = {
  id: 'first-book', name: 'My Notebook', path: '/notes/My Notebook',
  createdAt: 1, updatedAt: 1, isDefault: false,
};
let host: HTMLDivElement;
let root: Root;

function FirstRunHarness() {
  const system = useMainWindowSystemController();
  const selectedNotebook = useNoteStore((state) => state.selectedNotebook);
  const [ordinaryCreateOpen, setOrdinaryCreateOpen] = useState(false);
  const [introOpen, setIntroOpen] = useState(false);
  const openCreate = useCallback(() => setOrdinaryCreateOpen(true), []);
  useEmptyNotebookPrompt({
    startupReady: true,
    hasSelectedNotebook: Boolean(selectedNotebook),
    suppressed: system.onboardingLoading || system.onboardingOpen,
    openCreate,
  });
  return <>
    {ordinaryCreateOpen && <div data-ordinary-create>普通新建笔记本</div>}
    {selectedNotebook && <div data-workspace>{selectedNotebook.name}</div>}
    {introOpen && <div data-product-intro>产品介绍</div>}
    {system.onboardingOpen && <OnboardingScreen onFinish={async (book, options) => {
      await finishOnboardingNotebook(book, options, {
        completeOnboarding: system.completeOnboarding,
        failureTitle: '笔记本初始化失败', retryLabel: '重试',
      });
      setIntroOpen(true);
    }} />}
    <ActionableNoticeHost />
  </>;
}

async function mount() {
  await act(async () => {
    admitStartupStage3();
    root.render(<I18nProvider language="zh-CN"><FirstRunHarness /></I18nProvider>);
  });
}

function button(text: string): HTMLButtonElement {
  const element = [...document.body.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  expect(element, `button ${text}`).toBeDefined();
  return element!;
}

async function click(text: string) {
  await act(async () => button(text).click());
}

async function emitImport(status: NotebookImportStatus['status'], message?: string, notebookId = notebook.id) {
  await act(async () => {
    for (const handler of [...mocks.listeners]) handler({ notebookId, status, message });
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listeners.clear();
  for (const notice of getActionableNotices()) clearActionableNotice(notice.id);
  mocks.create.mockResolvedValue(notebook);
  mocks.selectDirectory.mockResolvedValue(null);
  mocks.attachFolder.mockResolvedValue(true);
  mocks.list.mockResolvedValue([notebook]);
  mocks.getDefaultPath.mockResolvedValue(notebook.path);
  mocks.getImportStatus.mockResolvedValue({ notebookId: notebook.id, status: 'started' });
  mocks.startImport.mockResolvedValue(undefined);
  mocks.selectNotebook.mockImplementation(async (book: NotebookRecord) => {
    useNoteStore.setState({ selectedNotebook: book });
  });
  useNoteStore.setState({ selectedNotebook: null, notebooks: [], startupPhase: 'ready' });
  host = document.createElement('div');
  host.id = 'root';
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  for (const notice of getActionableNotices()) clearActionableNotice(notice.id);
  mocks.listeners.clear();
});

describe('first-run notebook setup', () => {
  it('makes the workspace inert while onboarding is open and restores it on unmount', async () => {
    await mount();
    expect(host.inert).toBe(true);

    await act(async () => root.unmount());
    expect(host.inert).toBe(false);
    root = createRoot(host);
  });

  it('shows the compact create dialog without a cancel action or a default-path dependency', async () => {
    mocks.getDefaultPath.mockRejectedValue(new Error('PATH_UNAVAILABLE'));
    await mount();
    expect(document.body.querySelector('h1')?.textContent).toBe('创建笔记本');
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect([...document.body.querySelectorAll('button')].some((item) => item.textContent === '取消')).toBe(false);
    expect(button('创建并开始使用').disabled).toBe(false);
    await click('创建并开始使用');
    expect(mocks.create).toHaveBeenCalledWith('我的笔记本', undefined, 'notebook_2_fill', false);
  });

  it('keeps the form after cancelling the folder picker', async () => {
    await mount();
    await click('选择本地');
    expect(document.body.querySelector('#flowix-onboarding-notebook-form')).not.toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('uses the first folder as primary and attaches subsequent folders', async () => {
    mocks.selectDirectory.mockResolvedValueOnce('/primary').mockResolvedValueOnce('/extra');
    await mount();
    await click('选择本地');
    await click('选择本地');
    await click('创建并开始使用');
    expect(mocks.create).toHaveBeenCalledWith('我的笔记本', '/primary', 'notebook_2_fill', false);
    expect(mocks.attachFolder).toHaveBeenCalledWith(notebook.id, '/extra');
    expect(mocks.selectNotebook).toHaveBeenCalledWith(notebook);
  });

  it('enters the workspace when an additional folder fails to attach', async () => {
    mocks.selectDirectory.mockResolvedValueOnce('/primary').mockResolvedValueOnce('/extra');
    mocks.attachFolder.mockRejectedValueOnce(new Error('ATTACH_FAILED'));
    await mount();
    await click('选择本地');
    await click('选择本地');
    await click('创建并开始使用');
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.selectNotebook).toHaveBeenCalledWith(notebook);
    expect(document.body.querySelector('#flowix-onboarding-notebook-form')).toBeNull();
  });

  it('suppresses the ordinary create screen while notebook context is ready and enters the workspace with one create', async () => {
    await mount();
    expect(document.body.querySelector('#flowix-onboarding-notebook-form')).not.toBeNull();
    expect(host.textContent).not.toContain('接入 Agent');

    await click('创建并开始使用');
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.startImport).toHaveBeenCalledWith(notebook.id);
    expect(document.body.querySelector('#flowix-onboarding-notebook-form')).toBeNull();
    expect(host.querySelector('[data-ordinary-create]')).toBeNull();
    expect(host.querySelector('[data-workspace]')).not.toBeNull();
    expect(host.querySelector('[data-product-intro]')).not.toBeNull();
    await emitImport('completed');
    expect(getActionableNotices()).toHaveLength(0);
    expect(mocks.listeners.size).toBe(0);
  });

  it('shows onboarding again on the next development launch after successful setup', async () => {
    await mount();
    await click('创建并开始使用');
    await emitImport('completed');
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    expect(document.body.querySelector('#flowix-onboarding-notebook-form')).not.toBeNull();
    expect(host.querySelector('[data-ordinary-create]')).toBeNull();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('keeps creation failures retryable', async () => {
    mocks.create.mockRejectedValueOnce(new Error('PATH_CREATE_FAILED'));
    await mount();
    await click('创建并开始使用');
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('PATH_CREATE_FAILED');
    expect(mocks.startImport).not.toHaveBeenCalled();
    await click('创建并开始使用');
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it('retries workspace selection with the registered notebook instead of creating a second one', async () => {
    mocks.selectNotebook.mockRejectedValueOnce(new Error('NOTEBOOK_UNAVAILABLE'));
    await mount();
    await click('创建并开始使用');
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('NOTEBOOK_UNAVAILABLE');
    expect(mocks.startImport).not.toHaveBeenCalled();
    await click('重试');
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.selectNotebook).toHaveBeenCalledTimes(2);
    expect(mocks.selectNotebook).toHaveBeenLastCalledWith(notebook);
    expect(host.querySelector('[data-ordinary-create]')).toBeNull();
  });

  it('keeps the wizard open if import startup IPC fails and reuses the notebook on retry', async () => {
    mocks.startImport.mockRejectedValueOnce(new Error('IMPORT_START_FAILED'));
    await mount();
    await click('创建并开始使用');
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('IMPORT_START_FAILED');
    expect(mocks.listeners.size).toBe(0);
    await click('重试');
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.startImport).toHaveBeenCalledTimes(2);
  });

  it('dismisses setup after import completion without a completion-state write', async () => {
    mocks.getImportStatus.mockResolvedValue({ notebookId: notebook.id, status: 'completed' });
    await mount();
    await click('创建并开始使用');
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('#flowix-onboarding-notebook-form')).toBeNull();
    expect(host.querySelector('[data-product-intro]')).not.toBeNull();
  });

  it('reuses a notebook registered during an interrupted previous attempt', async () => {
    mocks.create.mockRejectedValueOnce(new Error('PATH_ALREADY_REGISTERED'));
    mocks.getImportStatus.mockResolvedValue({ notebookId: notebook.id, status: 'completed' });
    await mount();
    await click('创建并开始使用');
    expect(mocks.selectNotebook).toHaveBeenCalledWith(notebook);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.startImport).not.toHaveBeenCalled();
  });

  it('offers a real retry button after background import failure and retries the original notebook', async () => {
    await mount();
    await click('创建并开始使用');
    await emitImport('failed', 'INDEX_WRITE_FAILED');
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('INDEX_WRITE_FAILED');
    expect(button('重试').disabled).toBe(false);
    await act(async () => useNoteStore.setState({ selectedNotebook: { ...notebook, id: 'other-book' } }));
    await click('重试');
    expect(mocks.startImport).toHaveBeenCalledTimes(2);
    expect(mocks.startImport).toHaveBeenLastCalledWith(notebook.id);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.selectNotebook).toHaveBeenCalledTimes(1);
    await emitImport('completed', undefined, 'other-book');
    expect(getActionableNotices()).toHaveLength(1);
    await emitImport('completed');
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(mocks.listeners.size).toBe(0);
  });

  it('retains retry after another import failure or a retry IPC error', async () => {
    await mount();
    await click('创建并开始使用');
    await emitImport('failed', 'FIRST_FAILURE');
    mocks.startImport.mockRejectedValueOnce(new Error('RETRY_IPC_FAILED'));
    await click('重试');
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('RETRY_IPC_FAILED');
    expect(button('重试').disabled).toBe(false);
    await click('重试');
    await emitImport('failed', 'SECOND_FAILURE');
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('SECOND_FAILURE');
    await click('重试');
    await emitImport('completed');
    expect(getActionableNotices()).toHaveLength(0);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('shows retry for a failure already reported by the status query, then clears it on a fast retry', async () => {
    mocks.getImportStatus.mockResolvedValueOnce({
      notebookId: notebook.id, status: 'failed', message: 'FAST_IMPORT_FAILURE',
    });
    await mount();
    await click('创建并开始使用');
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('FAST_IMPORT_FAILURE');
    expect(mocks.listeners.size).toBe(0);
    mocks.getImportStatus.mockResolvedValueOnce({ notebookId: notebook.id, status: 'completed' });
    await click('重试');
    expect(mocks.startImport).toHaveBeenLastCalledWith(notebook.id);
    expect(mocks.startImport).toHaveBeenCalledTimes(2);
    expect(getActionableNotices()).toHaveLength(0);
    expect(mocks.listeners.size).toBe(0);
  });

  it('opens onboarding when no notebook exists', async () => {
    await mount();
    expect(document.body.querySelector('#flowix-onboarding-notebook-form')).not.toBeNull();
    expect(host.querySelector('[data-agent-intro]')).toBeNull();
  });
});
