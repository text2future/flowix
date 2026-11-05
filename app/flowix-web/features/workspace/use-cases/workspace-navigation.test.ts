import { seedWorkColumn } from '@features/workspace/test-support/workspace-fixtures';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginDescriptor } from '@platform/tauri/client';
import type { WorkColumnTarget } from '@features/workspace/store/work-column-target';

function pluginWorkbenchTarget(id: string): Extract<WorkColumnTarget, { kind: 'plugin-workbench' }> {
  return {
    kind: 'plugin-workbench',
    plugin: { manifest: { id } } as unknown as PluginDescriptor,
  };
}

const mocks = vi.hoisted(() => ({
  clearDocument: vi.fn(),
  openExternalDocument: vi.fn(),
  openAgentConversation: vi.fn(),
  replaceActiveMemoPath: vi.fn(),
  discardMemoDocument: vi.fn(),
  closeAgentConversation: vi.fn(),
  prepareDocumentLeave: vi.fn(),
  setCurrentNotebook: vi.fn(),
  beginNavigation: vi.fn().mockReturnValue(1),
  commitNavigation: vi.fn().mockReturnValue(true),
  failNavigation: vi.fn().mockReturnValue(true),
  isCurrentNavigation: vi.fn().mockReturnValue(true),
  navigationRevision: 1,
  navigationTarget: pluginWorkbenchTarget('plugin-a') as WorkColumnTarget,
  memoState: {
    selectedNotebook: null as { id: string; path: string } | null,
    selectedNotebookId: null as string | null,
    selectedNote: null,
    notebooks: [],
    upsertMemo: vi.fn(),
    setSelectedNotebook: vi.fn(),
    setSelectedNote: vi.fn(),
    setActiveFilter: vi.fn(),
    setActivePluginId: vi.fn(),
    setNotebooks: vi.fn(),
    setMemos: vi.fn(),
    loadNotebooks: vi.fn(),
    loadMemos: vi.fn(),
    loadNotes: vi.fn(),
  },
  documentState: {
    activeExternalSession: null as { fileIdentity: { displayId: string; path: string }; scopePath: string | null; transitionId: number } | null,
    activeAgentConversationId: null as string | null,
  },
}));

vi.mock('@features/document/store/document-store', () => ({
  useDocumentStore: {
    getState: () => ({
      clearDocument: mocks.clearDocument,
      openExternalDocument: mocks.openExternalDocument,
      openAgentConversation: mocks.openAgentConversation,
      replaceActiveMemoPath: mocks.replaceActiveMemoPath,
      discardMemoDocument: mocks.discardMemoDocument,
      closeAgentConversation: mocks.closeAgentConversation,
      ...mocks.documentState,
    }),
  },
}));

vi.mock('@features/document/store/document-session-service', () => ({
  prepareDocumentLeave: mocks.prepareDocumentLeave,
}));

vi.mock('@platform/tauri/client', () => ({
  agent: {},
  notes: { resolveLocation: vi.fn().mockResolvedValue(null) },
  notebooks: { setCurrent: mocks.setCurrentNotebook },
}));

vi.mock('@features/workspace/store/work-column-store', () => ({
  useWorkColumnStore: {
    getState: () => ({
      navigation: { phase: 'committed', showWorkColumnLoading: false, requestId: mocks.navigationRevision, target: mocks.navigationTarget, pendingTarget: null, previousTarget: null, failure: null, retryToken: null },
      beginNavigation: mocks.beginNavigation,
      commitNavigation: mocks.commitNavigation,
      failNavigation: mocks.failNavigation,
      isCurrentNavigation: mocks.isCurrentNavigation,
    }),
  },
}));

vi.mock('@features/memo/store/note-store', () => ({
  useNoteStore: {
    getState: () => mocks.memoState,
  },
}));

import {
  captureWorkspaceRestoreTarget,
  closePluginWorkbench,
  openPluginWorkbench,
} from './workspace-navigation';

describe('workspace navigation', () => {
  it('flushes the mounted left surface before replacing an isolated document after a swap', async () => {
    const { registerWorkspaceColumnIdView, registerWorkspaceSurfaceLifecycle } = await import('../store/surface-lifecycle-store');
    const { openExternalTarget } = await import('./workspace-navigation');
    const flush = vi.fn().mockResolvedValue(false);
    const release = registerWorkspaceColumnIdView('column-1', 'isolated-A');
    const owner = {};
    registerWorkspaceSurfaceLifecycle('isolated-A', { status: 'ready', flush }, owner);
    try {
      await expect(openExternalTarget('/after-swap.md', { destination: 'column-1' })).rejects.toThrow();
      expect(flush).toHaveBeenCalledOnce();
      expect(mocks.openExternalDocument).not.toHaveBeenCalled();
    } finally {
      release();
      registerWorkspaceSurfaceLifecycle('isolated-A', null, owner);
    }
  });

  it('reloads the document runtime when only the persisted target survives a window refresh', async () => {
    const { useWorkspaceSessionStore } = await import('../store/workspace-session-store');
    const { getSessionId } = await import('../store/workspace-session-store');
    const { restoreExternalDocumentWorkspace } = await import('./workspace-navigation');
    const target = { kind: 'external' as const, path: '/restored.md', scopePath: null, transitionId: null };
    useWorkspaceSessionStore.getState().commitTarget(getSessionId(0), target);
    mocks.navigationTarget = target;
    mocks.documentState.activeExternalSession = null;
    mocks.openExternalDocument.mockImplementationOnce(async () => {
      mocks.documentState.activeExternalSession = {
        fileIdentity: { displayId: 'restored-document', path: '/restored.md' }, scopePath: null, transitionId: 1,
      };
    });
    await restoreExternalDocumentWorkspace(target, 1);
    expect(mocks.openExternalDocument).toHaveBeenCalledWith('/restored.md', expect.any(Object));
    expect(mocks.commitNavigation).toHaveBeenCalledWith(1, expect.objectContaining({
      kind: 'external', path: '/restored.md', transitionId: 1,
    }), 'skip');
    useWorkspaceSessionStore.getState().reset();
  });

  it('does not replace user navigation after a delayed Markdown restore lookup', async () => {
    const { notes } = await import('@platform/tauri/client');
    const { restoreExternalDocumentWorkspace } = await import('./workspace-navigation');
    let finish!: (value: Awaited<ReturnType<typeof notes.resolveLocation>>) => void;
    vi.mocked(notes.resolveLocation).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const restored = restoreExternalDocumentWorkspace({ kind: 'external', path: '/old.md', scopePath: null });
    mocks.navigationRevision = 2;
    finish({ path: '/old.md', notebookId: null, relativePath: null, notebookPath: null, indexable: false });
    await restored;
    expect(mocks.beginNavigation).not.toHaveBeenCalled();
    expect(mocks.openExternalDocument).not.toHaveBeenCalled();
  });

  it('publishes loading before metadata work and skips a superseded request after yielding', async () => {
    const { notes } = await import('@platform/tauri/client');
    const { openExternalTarget } = await import('./workspace-navigation');
    const opening = openExternalTarget('/new.md', { destination: 'column-1' });
    expect(mocks.beginNavigation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'external', path: '/new.md' }), expect.any(String), false, true,
    );
    expect(notes.resolveLocation).not.toHaveBeenCalled();
    mocks.isCurrentNavigation.mockReturnValueOnce(false);
    await opening;
    expect(notes.resolveLocation).not.toHaveBeenCalled();
    expect(mocks.openExternalDocument).not.toHaveBeenCalled();
  });

  it('keeps A selected when B metadata resolves after the user clicks back to A', async () => {
    const { notes } = await import('@platform/tauri/client');
    const { openExternalTarget } = await import('./workspace-navigation');
    const { useWorkColumnStore: mockedStore } = await import('../store/work-column-store');
    const { useWorkColumnStore: realStore } = await vi.importActual<typeof import('../store/work-column-store')>(
      '../store/work-column-store',
    );
    const previousState = realStore.getState();
    const getState = vi.spyOn(mockedStore, 'getState').mockImplementation(realStore.getState);
    seedWorkColumn({ navigation: {
      phase: 'committed', showWorkColumnLoading: false, requestId: 10,
      target: { kind: 'external', path: '/A.md', scopePath: null, transitionId: null },
      pendingTarget: null, previousTarget: null, failure: null, retryToken: null,
    } });
    mocks.documentState.activeExternalSession = {
      fileIdentity: { displayId: 'test-A', path: '/A.md' }, scopePath: null, transitionId: 1,
    };
    let finishB!: () => void;
    const previousResolveLocation = vi.mocked(notes.resolveLocation).getMockImplementation();
    vi.mocked(notes.resolveLocation).mockImplementation((path) => {
      const location = { path, notebookId: null, relativePath: null, notebookPath: null, indexable: false };
      return path === '/B.md'
        ? new Promise((resolve) => { finishB = () => resolve(location); })
        : Promise.resolve(location);
    });
    const openingB = openExternalTarget('/B.md', { destination: 'column-1' }).catch(() => undefined);
    try {
      await vi.waitFor(() => expect(notes.resolveLocation).toHaveBeenCalledWith('/B.md'));
      await openExternalTarget('/A.md', { destination: 'column-1' });
      finishB();
      await openingB;
      expect(mocks.openExternalDocument.mock.calls.some(([path]) => path === '/B.md')).toBe(false);
      expect(realStore.getState().navigation).toMatchObject({
        phase: 'committed', target: { kind: 'external', path: '/A.md' }, pendingTarget: null,
      });
    } finally {
      finishB?.();
      await openingB;
      getState.mockRestore();
      seedWorkColumn(previousState, true);
      if (previousResolveLocation) vi.mocked(notes.resolveLocation).mockImplementation(previousResolveLocation);
    }
  });

  it('clears a restored notebook target after registry rebuild', async () => {
    const { useWorkspaceRestoreStore } = await import('../store/workspace-restore-store');
    useWorkspaceRestoreStore.getState().setDesiredTarget({
      kind: 'table', notebookId: 'removed-notebook', notebookPath: '/old', filePath: '/old/table.csv',
    });
    mocks.memoState.notebooks = [];
    expect(captureWorkspaceRestoreTarget()).toBeNull();
    expect(useWorkspaceRestoreStore.getState().desiredTarget).toBeNull();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clearDocument.mockResolvedValue(undefined);
    mocks.openExternalDocument.mockResolvedValue(undefined);
    mocks.openAgentConversation.mockResolvedValue(undefined);
    mocks.discardMemoDocument.mockResolvedValue(undefined);
    mocks.prepareDocumentLeave.mockResolvedValue(true);
    mocks.setCurrentNotebook.mockResolvedValue(undefined);
    mocks.navigationTarget = pluginWorkbenchTarget('plugin-a');
    mocks.navigationRevision = 1;
    mocks.documentState.activeExternalSession = null;
    mocks.documentState.activeAgentConversationId = null;
    mocks.memoState.selectedNotebook = null;
    mocks.memoState.selectedNotebookId = null;
    mocks.memoState.notebooks = [];
    mocks.memoState.upsertMemo.mockClear();
    mocks.memoState.setSelectedNotebook.mockClear();
    mocks.memoState.setActiveFilter.mockClear();
    mocks.memoState.setActivePluginId.mockClear();
    mocks.memoState.setNotebooks.mockClear();
    mocks.memoState.setMemos.mockClear();
    mocks.memoState.loadNotebooks.mockResolvedValue(undefined);
    mocks.memoState.loadMemos.mockResolvedValue(undefined);
  });

  it('opens a plugin workbench after the document has been cleared', async () => {
    await openPluginWorkbench({ manifest: { id: 'plugin-b' } } as never);

    expect(mocks.clearDocument).toHaveBeenCalledOnce();
    expect(mocks.commitNavigation).toHaveBeenCalledWith(1, {
      kind: 'plugin-workbench',
      plugin: { manifest: { id: 'plugin-b' } },
    }, 'push');
    expect(mocks.memoState.setActiveFilter).toHaveBeenCalledWith('all');
    expect(mocks.memoState.setActivePluginId).toHaveBeenCalledWith('plugin-b');
  });

  it('restores the workbench target when closing cannot flush the document', async () => {
    const failure = new Error('save refused');
    mocks.clearDocument.mockRejectedValueOnce(failure);

    await expect(closePluginWorkbench()).rejects.toBe(failure);
    expect(mocks.failNavigation).toHaveBeenCalledWith(1, failure);
  });
});
