import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openBrowserColumnAgentConversation,
  openBrowserColumnFileBrowser,
  openBrowserColumnMemo,
  openBrowserColumnMarkdown,
  openBrowserColumnTabInWorkColumn,
  openBrowserColumnTarget,
  openBrowserColumnWebpage,
  openWorkColumnTargetInBrowserColumn,
} from './browser-column-navigation';
import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import {
  registerBrowserColumnDocumentFlush,
  resetBrowserColumnCoordinator,
} from './browser-column-coordinator';
import type { MemoItem } from '@/types/memo-item';

function resetWorkspace() {
  useWorkColumnStore.setState({
    navigation: {
      phase: 'idle',
      requestId: 0,
      target: { kind: 'empty' },
      pendingTarget: null,
      previousTarget: null,
      failure: null,
      retryToken: null,
    },
  });
}

describe('browser column navigation', () => {
  beforeEach(() => {
    resetWorkspace();
    resetBrowserColumnCoordinator();
    useBrowserColumnStore.getState().reset();
  });

  it('opens local Markdown targets as browser-column tabs', async () => {
    const tabId = await openBrowserColumnMarkdown('/notes/plan.md');

    expect(tabId).toEqual({
      host: 'browser-column',
      tabId: 'file:/notes/plan.md',
      alreadyOpen: false,
    });
    expect(useBrowserColumnStore.getState().tabs[0]).toMatchObject({
      title: 'plan',
      target: { kind: 'file-browser', folderPath: null, notebookId: null, fileTreeVisible: true, fileTreeWidth: 220, activeFilePath: '/notes/plan.md', scopePath: null },
    });
  });

  it('opens one file-browser tab per folder and switches its active file', async () => {
    await openBrowserColumnFileBrowser('/workspace');
    await openBrowserColumnFileBrowser('/workspace', '/workspace/src/main.ts');

    const store = useBrowserColumnStore.getState();
    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0].target).toMatchObject({
      kind: 'file-browser',
      folderPath: '/workspace',
      activeFilePath: '/workspace/src/main.ts',
    });

    await openBrowserColumnFileBrowser('/workspace', '/workspace/src/other.ts');
    expect(useBrowserColumnStore.getState().tabs[0].target).toMatchObject({
      kind: 'file-browser',
      activeFilePath: '/workspace/src/other.ts',
    });
  });

  it('switches the current file-browser tab folder without changing other tabs', async () => {
    await openBrowserColumnFileBrowser('/workspace');
    await openBrowserColumnFileBrowser('/other');

    const store = useBrowserColumnStore.getState();
    const otherTabId = store.tabs.find((tab) => tab.target.kind === 'file-browser' && tab.target.folderPath === '/other')?.id;
    const workspaceTab = store.tabs.find((tab) => tab.target.kind === 'file-browser' && tab.target.folderPath === '/workspace');
    expect(otherTabId).toBeDefined();
    expect(workspaceTab).toBeDefined();
    if (!otherTabId || !workspaceTab) return;

    store.selectFileBrowserFile(otherTabId, '/other/readme.md');
    store.switchFileBrowserFolder(otherTabId, '/next');

    expect(useBrowserColumnStore.getState().tabs).toEqual([
      workspaceTab,
      expect.objectContaining({
        id: otherTabId,
        title: 'next',
        target: expect.objectContaining({
          kind: 'file-browser',
          folderPath: '/next',
          activeFilePath: null,
        }),
      }),
    ]);
  });

  it('uses the Agent instance as the stable tab target', async () => {
    await openBrowserColumnAgentConversation('agent-1');

    expect(useBrowserColumnStore.getState()).toMatchObject({
      activeTabId: 'agent:agent-1',
      tabs: [{ title: 'Agent 会话', target: { kind: 'agent_conversation', instanceId: 'agent-1' } }],
    });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('browser-column');
  });

  it('opens webpages as browser-column tabs and reuses the existing tab', async () => {
    const first = await openBrowserColumnWebpage('https://example.com/docs');
    const second = await openBrowserColumnWebpage('https://example.com/docs');

    expect(first).toEqual({
      host: 'browser-column',
      tabId: 'web:https://example.com/docs',
      alreadyOpen: false,
    });
    expect(second).toEqual({
      host: 'browser-column',
      tabId: 'web:https://example.com/docs',
      alreadyOpen: true,
    });
    expect(useBrowserColumnStore.getState().tabs[0]).toMatchObject({
      title: 'example.com',
      target: { kind: 'web', url: 'https://example.com/docs' },
    });
  });

  it('preserves webpage tabs instead of moving them to an unsupported surface', async () => {
    await openBrowserColumnWebpage('https://example.com/docs');
    await openBrowserColumnWebpage('https://flowix.dev/');
    const before = useBrowserColumnStore.getState();
    const focus = useWorkspaceFocusStore.getState().focusedHostId;

    expect(await openBrowserColumnTabInWorkColumn('web:https://example.com/docs')).toBe(false);
    expect(useBrowserColumnStore.getState().tabs).toEqual(before.tabs);
    expect(useBrowserColumnStore.getState().activeTabId).toBe(before.activeTabId);
    expect(useWorkColumnStore.getState().navigation.target).toEqual({ kind: 'empty' });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe(focus);
  });

  it('preserves a folder tab without a selected file when asked to move it', async () => {
    await openBrowserColumnFileBrowser('/workspace');
    const before = useBrowserColumnStore.getState();
    expect(await openBrowserColumnTabInWorkColumn(before.tabs[0].id)).toBe(false);
    expect(useBrowserColumnStore.getState().tabs).toEqual(before.tabs);
    expect(useBrowserColumnStore.getState().visible).toBe(true);
    expect(useWorkColumnStore.getState().navigation.target).toEqual({ kind: 'empty' });
  });

  it('keeps the tab when its document cannot be flushed before moving', async () => {
    await openBrowserColumnMarkdown('/notes/plan.md');
    registerBrowserColumnDocumentFlush(
      'file:/notes/plan.md',
      vi.fn().mockResolvedValue(false),
    );

    const moved = await openBrowserColumnTabInWorkColumn('file:/notes/plan.md');

    expect(moved).toBeNull();
    expect(useBrowserColumnStore.getState().tabs[0]).toMatchObject({
      id: 'file:/notes/plan.md',
      target: { kind: 'file-browser', folderPath: null, notebookId: null, fileTreeVisible: true, fileTreeWidth: 220, activeFilePath: '/notes/plan.md' },
    });
  });

  it('explicitly opens a memo in the right column, retaining the left and reusing its tab', async () => {
    const target = { kind: 'memo' as const, memoId: 'shared', path: '/notes/shared.md', notebookId: 'notes', notebookPath: '/notes', transitionId: 1 };
    const work = useWorkColumnStore.getState();
    const requestId = work.beginNavigation(target, null);
    work.commitNavigation(requestId, target);
    const browserTarget = { kind: 'memo' as const, memoId: 'shared', filePath: target.path, notebookId: 'notes', notebookPath: '/notes' };
    const first = await openBrowserColumnTarget(browserTarget, 'open-in-column');
    await openBrowserColumnWebpage('https://example.com');
    const second = await openBrowserColumnTarget(browserTarget, 'open-in-column');
    expect(first?.alreadyOpen).toBe(false);
    expect(second?.alreadyOpen).toBe(true);
    expect(useBrowserColumnStore.getState().activeTabId).toBe('memo:shared');
    expect(useBrowserColumnStore.getState().tabs).toHaveLength(2);
    expect(useWorkColumnStore.getState().navigation.target).toEqual(target);
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('browser-column');
  });

  it('supports replacing the active tab', async () => {
    await openBrowserColumnMarkdown('/notes/old.md');
    await openBrowserColumnTarget({ kind: 'agent_conversation', instanceId: 'agent-2' }, 'replace-active');

    expect(useBrowserColumnStore.getState().tabs.map((tab) => tab.target.kind)).toEqual(['agent_conversation']);
    expect(useBrowserColumnStore.getState().activeTabId).toBe('agent:agent-2');
  });

  it('focuses an existing work-column document instead of opening a duplicate tab', async () => {
    const workColumn = useWorkColumnStore.getState();
    const requestId = workColumn.beginNavigation({
      kind: 'external',
      path: '/notes/plan.md',
      scopePath: '/notes',
      transitionId: null,
    }, null);
    workColumn.commitNavigation(requestId, {
      kind: 'external',
      path: '/notes/plan.md',
      scopePath: '/notes',
      transitionId: 1,
    });

    const result = await openBrowserColumnMarkdown('/notes/plan.md');

    expect(useBrowserColumnStore.getState()).toMatchObject({
      tabs: [],
      visible: false,
    });
    expect(result).toEqual({ host: 'main-third', alreadyOpen: true });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('main-third');
  });

  it('opens the active work-column target in the right column while keeping the left target', async () => {
    const target = {
      kind: 'external' as const,
      path: '/notes/plan.md',
      scopePath: '/notes',
      transitionId: 1,
    };
    const workColumn = useWorkColumnStore.getState();
    const requestId = workColumn.beginNavigation(target, null);
    workColumn.commitNavigation(requestId, target);

    const result = await openWorkColumnTargetInBrowserColumn(target);

    expect(result).toEqual({
      host: 'browser-column',
      tabId: 'file:/notes/plan.md',
      alreadyOpen: false,
    });
    expect(useBrowserColumnStore.getState().tabs[0]).toMatchObject({
      target: { kind: 'file-browser', folderPath: null, notebookId: null, fileTreeVisible: true, fileTreeWidth: 220, activeFilePath: '/notes/plan.md', scopePath: '/notes' },
    });
    expect(useWorkColumnStore.getState().navigation.target).toEqual(target);
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('browser-column');
  });

  it('flushes the active editor before a programmatic tab replacement', async () => {
    await openBrowserColumnMarkdown('/notes/old.md');
    const flush = vi.fn().mockResolvedValue(true);
    registerBrowserColumnDocumentFlush('file:/notes/old.md', flush);

    await openBrowserColumnTarget(
      { kind: 'agent_conversation', instanceId: 'agent-2' },
      'replace-active',
    );

    expect(flush).toHaveBeenCalledOnce();
    expect(useBrowserColumnStore.getState().tabs.map((tab) => tab.target.kind)).toEqual([
      'agent_conversation',
    ]);
  });

  it('keeps the current tab when its editor refuses to flush', async () => {
    await openBrowserColumnMarkdown('/notes/old.md');
    registerBrowserColumnDocumentFlush(
      'file:/notes/old.md',
      vi.fn().mockResolvedValue(false),
    );

    const result = await openBrowserColumnTarget(
      { kind: 'agent_conversation', instanceId: 'agent-2' },
      'replace-active',
    );

    expect(result).toBeNull();
    expect(useBrowserColumnStore.getState().tabs[0].target).toMatchObject({
      kind: 'file-browser', folderPath: null, notebookId: null, fileTreeVisible: true, fileTreeWidth: 220, activeFilePath: '/notes/old.md',
    });
  });

  it('opens plugin pointer notes as artifact tabs', async () => {
    const memo: MemoItem = {
      id: 'artifact-memo',
      filename: 'Roadmap.md',
      preview: '',
      tags: [],
      todos: [],
      agents: [],
      createdAt: 1,
      updatedAt: 1,
      favorited: false,
      icon: null,
      colors: [],
      properties: {
        flowix_note_type: 'mindmap',
        flowix_plugin: 'mindmap',
        flowix_artifact: { renderer: 'markmap' },
      },
    };

    await openBrowserColumnMemo(memo, null);

    expect(useBrowserColumnStore.getState().tabs[0].target).toEqual({
      kind: 'artifact',
      pointerMemoId: 'artifact-memo',
      renderer: 'markmap',
    });
  });
});

it('moves a folder selection to the main column even when a separate file tab already exists', async () => {
  resetWorkspace();
  resetBrowserColumnCoordinator();
  useBrowserColumnStore.getState().reset();
  const { useDocumentStore } = await import('@features/document/store/document-store');
  const previousDocument = useDocumentStore.getState();
  useDocumentStore.setState({ activeMemoSession: null, activeExternalSession: null, currentDocumentPath: null, currentDocumentSource: null });
  try {
    await openBrowserColumnMarkdown('/workspace/readme.md');
    useBrowserColumnStore.setState((state) => ({
      tabs: [...state.tabs, { id: 'file-browser:/workspace', title: 'workspace', icon: null,
        target: { kind: 'file-browser', folderPath: '/workspace', activeFilePath: '/workspace/readme.md',
          scopePath: '/workspace', notebookId: null, fileTreeVisible: true, fileTreeWidth: 220 } }],
      activeTabId: 'file-browser:/workspace',
    }));
    const moving = openBrowserColumnTabInWorkColumn('file-browser:/workspace');
    const result = await Promise.race([
      moving,
      new Promise<string>((resolve) => setTimeout(() => resolve('navigation queue deadlocked'), 100)),
    ]);
    expect(result).toBe(true);
    expect(useWorkColumnStore.getState().navigation.target).toMatchObject({ kind: 'external', path: '/workspace/readme.md' });
    expect(useBrowserColumnStore.getState().tabs.map((tab) => tab.id)).toEqual(['file:/workspace/readme.md']);
    await openBrowserColumnWebpage('https://example.com/after-move');
    expect(useBrowserColumnStore.getState().tabs).toHaveLength(2);
  } finally {
    resetBrowserColumnCoordinator();
    resetWorkspace();
    useDocumentStore.setState(previousDocument);
    useBrowserColumnStore.getState().reset();
  }
});

it('reuses one file identity across standalone and directory opens without resetting tree preferences', async () => {
  resetWorkspace();
  resetBrowserColumnCoordinator();
  useBrowserColumnStore.getState().reset();
  await openBrowserColumnMarkdown('/workspace/a.md');
  const first = useBrowserColumnStore.getState().activeTabId!;
  useBrowserColumnStore.getState().setFileBrowserTreeVisible(first, false);
  await openBrowserColumnFileBrowser('/workspace', '/workspace/a.md');
  expect(useBrowserColumnStore.getState().tabs).toHaveLength(1);
  expect(useBrowserColumnStore.getState().activeTabId).toBe(first);
  expect(useBrowserColumnStore.getState().tabs[0].target).toMatchObject({ fileTreeVisible: false });
});

it('upgrades a standalone file tab with its resource folder context in place', async () => {
  resetWorkspace();
  resetBrowserColumnCoordinator();
  useBrowserColumnStore.getState().reset();
  await openBrowserColumnMarkdown('/workspace/a.md');
  const tabId = useBrowserColumnStore.getState().activeTabId!;
  useBrowserColumnStore.getState().setFileBrowserTreeVisible(tabId, false);
  await openBrowserColumnFileBrowser('/workspace', '/workspace/a.md');
  const tab = useBrowserColumnStore.getState().tabs[0];
  expect(tab.id).toBe(tabId);
  expect(tab.target).toMatchObject({
    kind: 'file-browser',
    folderPath: '/workspace',
    activeFilePath: '/workspace/a.md',
    fileTreeVisible: false,
  });
});

it('keeps the old file when a tree selection cannot be saved and reuses already open files', async () => {
  const { selectBrowserColumnFile } = await import('./browser-column-navigation');
  resetWorkspace();
  resetBrowserColumnCoordinator();
  useBrowserColumnStore.getState().reset();
  await openBrowserColumnMarkdown('/workspace/a.md');
  const first = useBrowserColumnStore.getState().activeTabId!;
  const flush = vi.fn().mockResolvedValue(false);
  registerBrowserColumnDocumentFlush(first, flush);
  expect(await selectBrowserColumnFile(first, '/workspace/b.md')).toBeNull();
  expect(useBrowserColumnStore.getState().tabs[0].target).toMatchObject({ activeFilePath: '/workspace/a.md' });
  flush.mockResolvedValue(true);
  await selectBrowserColumnFile(first, '/workspace/b.md');
  expect(useBrowserColumnStore.getState().tabs[0]).toMatchObject({ id: first, title: 'b' });
  await openBrowserColumnMarkdown('/workspace/a.md');
  const second = useBrowserColumnStore.getState().activeTabId!;
  expect(second).not.toBe(first);
  expect(new Set(useBrowserColumnStore.getState().tabs.map((tab) => tab.id)).size).toBe(2);
  await selectBrowserColumnFile(second, '/workspace/b.md');
  expect(useBrowserColumnStore.getState().activeTabId).toBe(first);
  expect(useBrowserColumnStore.getState().tabs).toHaveLength(2);
  resetBrowserColumnCoordinator();
});
