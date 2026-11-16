import { openBrowserColumnTarget } from './browser-column-navigation';
import { useWorkspaceSessionStore } from '../store/workspace-session-store';
import { navigateWorkspaceSession } from './session-navigation';
import { seedWorkColumn, seedBrowserColumn } from '@features/workspace/test-support/workspace-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  memoState: {
    selectedNotebook: null as { id: string; path: string } | null,
    selectedNotebookId: null as string | null,
    selectedNote: null as { notebookId: string; relativePath: string } | null,
    notebooks: [] as Array<{ id: string; path: string }>,
    upsertMemo: vi.fn(),
    setSelectedNotebook: vi.fn((notebook: { id: string; path: string } | null) => {
      mocks.memoState.selectedNotebook = notebook;
      mocks.memoState.selectedNotebookId = notebook?.id ?? null;
    }),
    setSelectedNote: vi.fn((identity: { notebookId: string; relativePath: string } | null) => {
      mocks.memoState.selectedNote = identity;
    }),
    setNotebooks: vi.fn((
      notebooks: Array<{ id: string; path: string }>,
      selectedNotebookId?: string | null,
    ) => {
      mocks.memoState.notebooks = notebooks;
      const nextSelectedId = selectedNotebookId === undefined
        ? mocks.memoState.selectedNotebookId
        : selectedNotebookId;
      if (!notebooks.some((item) => item.id === nextSelectedId)) {
        mocks.memoState.selectedNotebook = null;
        mocks.memoState.selectedNotebookId = null;
      } else {
        mocks.memoState.selectedNotebook = notebooks.find((item) => item.id === nextSelectedId) ?? null;
        mocks.memoState.selectedNotebookId = nextSelectedId;
      }
    }),
    setMemos: vi.fn(),
    setActiveFilter: vi.fn(),
    setActivePluginId: vi.fn(),
    loadNotebooks: vi.fn(),
    loadMemos: vi.fn(),
    loadNotes: vi.fn().mockResolvedValue(true),
  },
  documentState: {
    activeExternalSession: null as {
      fileIdentity: { displayId: string; path: string };
      scopePath: string | null;
      transitionId: number;
    } | null,
    activeAgentConversationId: null,
  },
  clearDocument: vi.fn(),
  openExternalDocument: vi.fn(),
  resolveMarkdownLocation: vi.fn(),
  setCurrentNotebook: vi.fn(),
  notebookPersistenceRevision: 0,
  persistedNotebookId: undefined as string | null | undefined,
  requestedNotebookId: undefined as string | null | undefined,
}));

vi.mock('@features/memo/store/note-store', () => ({
  useNoteStore: { getState: () => mocks.memoState },
}));

vi.mock('@features/document/store/document-store', () => ({
  useDocumentStore: {
    getState: () => ({
      ...mocks.documentState,
      clearDocument: mocks.clearDocument,
      openExternalDocument: mocks.openExternalDocument,
    }),
  },
}));

vi.mock('@platform/tauri/client', () => ({
  agent: {},
  notes: { resolveLocation: mocks.resolveMarkdownLocation },
  notebooks: { setCurrent: mocks.setCurrentNotebook },
}));
vi.mock('@features/memo/public/workspace-api', () => ({
  getWorkspaceMemoState: () => mocks.memoState,
  getSelectedWorkspaceNotebookId: () => mocks.memoState.selectedNotebookId,
  needsWorkspaceNotebookPersistence: (notebookId: string | null) => (
    (mocks.requestedNotebookId !== undefined && mocks.requestedNotebookId !== notebookId)
    || (mocks.persistedNotebookId !== undefined && mocks.persistedNotebookId !== notebookId)
  ),
  setCurrentWorkspaceNotebook: async (notebook: string | null | { id: string }) => {
    const notebookId = typeof notebook === 'string' ? notebook : notebook?.id ?? null;
    const revision = ++mocks.notebookPersistenceRevision;
    mocks.requestedNotebookId = notebookId;
    await mocks.setCurrentNotebook(notebookId);
    if (revision === mocks.notebookPersistenceRevision) {
      mocks.persistedNotebookId = notebookId;
      mocks.requestedNotebookId = undefined;
    }
  },
}));

import { useWorkColumnStore } from '../store/work-column-store';
import { NavigationCancelledError } from '@/lib/navigation-cancelled-error';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { registerWorkspaceSurfaceLifecycle } from '../store/surface-lifecycle-store';
import {
  openExternalTarget,
  openFolderCollectionChooserTarget,
  reconcileDeletedNotebook,
  selectNotebook,
} from './workspace-navigation';

function resetWorkspace() {
  seedWorkColumn({
    navigation: {
      phase: 'idle',
      showMainColumnLoading: false,
      requestId: 0,
      target: { kind: 'empty' },
      pendingTarget: null,
      previousTarget: null,
      failure: null,
      retryToken: null,
    },
  });
}


afterEach(() => { registerWorkspaceSurfaceLifecycle('saving-tab', null); });

describe('workspace navigation transaction', () => {
  beforeEach(() => {
    resetWorkspace();
    useBrowserColumnStore.getState().reset();
    vi.clearAllMocks();
    mocks.memoState.selectedNote = { notebookId: 'notebook-a', relativePath: 'old.md' };
    mocks.memoState.selectedNotebook = null;
    mocks.memoState.selectedNotebookId = null;
    mocks.memoState.notebooks = [];
    mocks.documentState.activeExternalSession = null;
    mocks.openExternalDocument.mockReset();
    mocks.openExternalDocument.mockResolvedValue(undefined);
    mocks.resolveMarkdownLocation.mockReset();
    mocks.resolveMarkdownLocation.mockResolvedValue(null);
    mocks.memoState.loadNotes.mockResolvedValue(true);
    mocks.clearDocument.mockReset();
    mocks.clearDocument.mockResolvedValue(undefined);
    mocks.setCurrentNotebook.mockReset();
    mocks.setCurrentNotebook.mockResolvedValue(undefined);
    mocks.notebookPersistenceRevision = 0;
    mocks.persistedNotebookId = undefined;
    mocks.requestedNotebookId = undefined;
    mocks.memoState.upsertMemo.mockClear();
    mocks.memoState.setSelectedNotebook.mockClear();
    mocks.memoState.setNotebooks.mockClear();
    mocks.memoState.setMemos.mockClear();
    mocks.memoState.setActiveFilter.mockClear();
    mocks.memoState.setActivePluginId.mockClear();
    mocks.memoState.loadNotebooks.mockResolvedValue(undefined);
    mocks.memoState.loadMemos.mockResolvedValue(undefined);
  });

  it('does not replace the primary sidebar notebook when opening a folder in the secondary session', async () => {
    const sessions = useWorkspaceSessionStore.getState();
    sessions.reset();
    sessions.swapColumnContents();
    const primary = { id: 'a', path: '/a' };
    mocks.memoState.notebooks = [primary, { id: 'b', path: '/b' }];
    mocks.memoState.setSelectedNotebook(primary);
    try {
      await openFolderCollectionChooserTarget({ kind: 'folder-collection', notebookId: 'b', notebookPath: '/b', folderPath: '/b/folder', folderName: 'folder' });
      expect(mocks.memoState.selectedNotebookId).toBe('a');
      expect(mocks.setCurrentNotebook).not.toHaveBeenCalled();
      expect(useWorkColumnStore.getState().navigation.target).toMatchObject({ kind: 'folder-collection', notebookId: 'b' });
    } finally { sessions.reset(); resetWorkspace(); }
  });

  it('keeps the sidebar notebook in sync after column swapping, popup selection and history', async () => {
    const sessionStore = useWorkspaceSessionStore.getState();
    sessionStore.reset();
    sessionStore.swapColumnContents();
    const a = { id: 'a', path: '/a' };
    const b = { id: 'b', path: '/b' };
    mocks.memoState.notebooks = [a, b];
    mocks.memoState.setSelectedNotebook(a);
    const folder = (book: typeof a) => ({ kind: 'folder-collection' as const, notebookId: book.id,
      notebookPath: book.path, folderPath: `${book.path}/folder`, folderName: 'folder' });
    try {
      await selectNotebook(b as Parameters<typeof selectNotebook>[0]);
      expect(mocks.memoState.selectedNotebookId).toBe('b');
      expect(mocks.memoState.loadNotes).toHaveBeenLastCalledWith({ notebookId: 'b' });
      await openBrowserColumnTarget(folder(a));
      expect(mocks.memoState.selectedNotebookId).toBe('a');
      await openBrowserColumnTarget(folder(b));
      expect(mocks.memoState.selectedNotebookId).toBe('b');
      expect(await navigateWorkspaceSession(0, 'back')).toBe(true);
      expect(mocks.memoState.selectedNotebookId).toBe('a');
      expect(await navigateWorkspaceSession(0, 'forward')).toBe(true);
      expect(mocks.memoState.selectedNotebookId).toBe('b');
    } finally { sessionStore.reset(); resetWorkspace(); }
  });

  it('restores notebook ownership when history moves between a file and a folder', async () => {
    useWorkspaceSessionStore.getState().reset();
    resetWorkspace();
    mocks.memoState.notebooks = [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }];
    mocks.resolveMarkdownLocation.mockResolvedValue({ path: '/a/source.md', notebookId: 'a', notebookPath: '/a',
      relativePath: 'source.md', indexable: true });
    mocks.openExternalDocument.mockImplementation(async (path: string) => {
      mocks.documentState.activeExternalSession = { fileIdentity: { displayId: 'history-file-a', path }, scopePath: '/a', transitionId: 1 };
    });
    await openExternalTarget('/a/source.md', { history: 'push' });
    await openFolderCollectionChooserTarget({ kind: 'folder-collection', notebookId: 'b', notebookPath: '/b', folderPath: '/b/folder', folderName: 'folder' }, undefined, 'push');
    expect(mocks.memoState.selectedNotebookId).toBe('b');
    expect(await navigateWorkspaceSession(0, 'back')).toBe(true);
    expect(mocks.memoState.selectedNotebookId).toBe('a');
    expect(useWorkColumnStore.getState().navigation.target).toMatchObject({ kind: 'external', path: '/a/source.md' });
    expect(await navigateWorkspaceSession(0, 'forward')).toBe(true);
    expect(mocks.memoState.selectedNotebookId).toBe('b');
  });

  it('replays cross-notebook folder history through the same notebook switch transaction', async () => {
    useWorkspaceSessionStore.getState().reset();
    resetWorkspace();
    const a = { id: 'a', path: '/a' };
    const b = { id: 'b', path: '/b' };
    mocks.memoState.notebooks = [a, b];
    mocks.memoState.setSelectedNotebook(a);
    const folder = (notebook: typeof a) => ({ kind: 'folder-collection' as const, notebookId: notebook.id,
      notebookPath: notebook.path, folderPath: `${notebook.path}/folder`, folderName: 'folder' });
    await openFolderCollectionChooserTarget(folder(a), undefined, 'push');
    await openFolderCollectionChooserTarget(folder(b), undefined, 'push');
    expect(mocks.memoState.selectedNotebookId).toBe('b');
    expect(await navigateWorkspaceSession(0, 'back')).toBe(true);
    expect(mocks.memoState.selectedNotebookId).toBe('a');
    expect(useWorkColumnStore.getState().navigation.target).toMatchObject(folder(a));
    expect(await navigateWorkspaceSession(0, 'forward')).toBe(true);
    expect(mocks.memoState.selectedNotebookId).toBe('b');
    expect(useWorkColumnStore.getState().navigation.target).toMatchObject(folder(b));
    expect(mocks.memoState.loadNotes.mock.calls.map(call => call[0])).toEqual([
      { notebookId: 'b' }, { notebookId: 'a' }, { notebookId: 'b' },
    ]);
  });

  it('uses the same notebook/list updates for popup selection and folder navigation', async () => {
    const a = { id: 'a', path: '/a' };
    const b = { id: 'b', path: '/b' };
    mocks.memoState.notebooks = [a, b];
    mocks.memoState.setSelectedNotebook(a);
    await selectNotebook(b as Parameters<typeof selectNotebook>[0]);
    expect(mocks.memoState.selectedNotebookId).toBe('b');
    expect(mocks.memoState.loadNotes).toHaveBeenLastCalledWith({ notebookId: 'b' });
    await openFolderCollectionChooserTarget({ kind: 'folder-collection', notebookId: 'a', notebookPath: '/a', folderPath: '/a/folder', folderName: 'folder' });
    expect(mocks.memoState.selectedNotebookId).toBe('a');
    expect(mocks.memoState.loadNotes).toHaveBeenLastCalledWith({ notebookId: 'a' });
    expect(mocks.setCurrentNotebook.mock.calls.map(call => call[0])).toEqual(['b', 'a']);
  });

  it('switches notebook ownership before committing a cross-notebook folder', async () => {
    const previous = { id: 'a', path: '/a' };
    const destination = { id: 'b', path: '/b' };
    mocks.memoState.notebooks = [previous, destination];
    mocks.memoState.setSelectedNotebook(previous);
    const target = { kind: 'folder-collection' as const, notebookId: 'b', notebookPath: '/b', folderPath: '/b/folder', folderName: 'folder' };
    await openFolderCollectionChooserTarget(target);
    expect(mocks.setCurrentNotebook).toHaveBeenCalledWith('b');
    expect(mocks.memoState.selectedNotebookId).toBe('b');
    expect(mocks.memoState.selectedNote).toBeNull();
    expect(mocks.memoState.loadNotes).toHaveBeenCalledWith({ notebookId: 'b' });
    expect(useWorkColumnStore.getState().navigation.target).toMatchObject(target);
  });

  it('restores native selection when a newer navigation returns to the still-selected notebook', async () => {
    const a = { id: 'a', path: '/a' };
    const b = { id: 'b', path: '/b' };
    mocks.memoState.notebooks = [a, b];
    mocks.memoState.setSelectedNotebook(a);
    let finishFirstSwitch!: () => void;
    mocks.setCurrentNotebook.mockImplementationOnce(() => new Promise<void>(resolve => {
      finishFirstSwitch = resolve;
    }));

    const firstNavigation = openFolderCollectionChooserTarget({
      kind: 'folder-collection', notebookId: 'b', notebookPath: '/b', folderPath: '/b/folder', folderName: 'folder',
    });
    await vi.waitFor(() => expect(mocks.setCurrentNotebook).toHaveBeenCalledWith('b'));

    await openFolderCollectionChooserTarget({
      kind: 'folder-collection', notebookId: 'a', notebookPath: '/a', folderPath: '/a/folder', folderName: 'folder',
    });
    expect(mocks.setCurrentNotebook.mock.calls.map(([id]) => id)).toEqual(['b', 'a']);
    expect(mocks.memoState.selectedNotebookId).toBe('a');

    finishFirstSwitch();
    await firstNavigation;
  });

  it('does not switch notebooks for a folder within the selected notebook', async () => {
    const notebook = { id: 'a', path: '/a' };
    mocks.memoState.notebooks = [notebook];
    mocks.memoState.setSelectedNotebook(notebook);
    await openFolderCollectionChooserTarget({ kind: 'folder-collection', notebookId: 'a', notebookPath: '/a', folderPath: '/a/folder', folderName: 'folder' });
    expect(mocks.setCurrentNotebook).not.toHaveBeenCalled();
    expect(mocks.memoState.loadNotes).not.toHaveBeenCalled();
  });

  it('restores the previous notebook if loading the destination folder notebook fails', async () => {
    const previous = { id: 'a', path: '/a' };
    mocks.memoState.notebooks = [previous, { id: 'b', path: '/b' }];
    mocks.memoState.setSelectedNotebook(previous);
    const previousNote = mocks.memoState.selectedNote;
    mocks.memoState.loadNotes.mockRejectedValueOnce(new Error('load failed'));
    await expect(openFolderCollectionChooserTarget({ kind: 'folder-collection', notebookId: 'b', notebookPath: '/b', folderPath: '/b/folder', folderName: 'folder' })).rejects.toThrow('load failed');
    expect(mocks.memoState.selectedNotebookId).toBe('a');
    expect(mocks.memoState.selectedNote).toEqual(previousNote);
    expect(mocks.setCurrentNotebook.mock.calls.map(call => call[0])).toEqual(['b', 'a']);
    expect(useWorkColumnStore.getState().navigation.target.kind).toBe('empty');
  });

  it('retains the previous Work target without a failure or retry action when leaving is refused', async () => {
    const previous = { kind: 'web' as const, url: 'https://example.com' };
    const work = useWorkColumnStore.getState();
    const requestId = work.beginNavigation(previous, null);
    work.commitNavigation(requestId, previous);
    mocks.openExternalDocument.mockRejectedValueOnce(new NavigationCancelledError('saving could not be retained'));
    await expect(openExternalTarget('/notes/new.md')).rejects.toBeInstanceOf(NavigationCancelledError);
    expect(useWorkColumnStore.getState().navigation).toMatchObject({
      phase: 'committed', target: previous, pendingTarget: null, failure: null, retryToken: null,
    });
  });

  it('restores the path selection when opening a document fails', async () => {
    mocks.openExternalDocument.mockRejectedValueOnce(new Error('external unavailable'));

    await expect(openExternalTarget('/workspace/readme.md', {
      scopePath: '/workspace',
    })).rejects.toThrow('external unavailable');

    expect(mocks.memoState.selectedNote).toEqual({ notebookId: 'notebook-a', relativePath: 'old.md' });
    expect(useWorkColumnStore.getState().navigation).toMatchObject({
      phase: 'failed',
      pendingTarget: {
        kind: 'external',
        path: '/workspace/readme.md',
        scopePath: '/workspace',
      },
      failure: { message: 'external unavailable' },
    });
  });

  it('opens indexed Markdown by path and selects its owning notebook', async () => {
    mocks.memoState.notebooks = [{ id: 'notebook-a', path: '/notes' }];
    mocks.resolveMarkdownLocation.mockResolvedValueOnce({
      path: '/notes/a.md', notebookId: 'notebook-a', notebookPath: '/notes',
      relativePath: 'a.md', indexable: true,
    });
    mocks.openExternalDocument.mockImplementationOnce(async (path: string, options: { scopePath: string }) => {
      mocks.documentState.activeExternalSession = {
        fileIdentity: { displayId: 'display-a', path },
        scopePath: options.scopePath,
        transitionId: 1,
      };
    });

    await openExternalTarget('/notes/a.md');

    expect(mocks.setCurrentNotebook).toHaveBeenCalledWith('notebook-a');
    expect(mocks.memoState.selectedNote).toEqual({ notebookId: 'notebook-a', relativePath: 'a.md' });
    expect(mocks.openExternalDocument).toHaveBeenCalledWith('/notes/a.md', expect.objectContaining({
      scopePath: '/notes', notebookId: 'notebook-a', relativePath: 'a.md', indexable: true,
    }));
    expect(useWorkColumnStore.getState().navigation.target).toMatchObject({
      kind: 'external', path: '/notes/a.md', scopePath: '/notes',
    });
  });

  it('switches Work without resetting or flushing the independent Browser session', async () => {
    const notebook = {
      id: 'next-notebook', name: 'Next', path: '/next',
      createdAt: 0, updatedAt: 0, isDefault: false,
    };
    seedWorkColumn((state) => ({
      navigation: { ...state.navigation, target: { kind: 'plugin-workbench', plugin: {} as never } },
    }));
    seedBrowserColumn({
      visible: true,
      current: { id: 'web-tab', target: { kind: 'web', url: 'https://example.com' } } as never,
    });
    const reset = vi.spyOn(useBrowserColumnStore.getState(), 'reset');
    const browserBefore = useBrowserColumnStore.getState();
    const flush = vi.fn(async () => false);
    registerWorkspaceSurfaceLifecycle('web-tab', { status: 'ready', flush });

    await selectNotebook(notebook);

    expect(mocks.clearDocument).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
    expect(useWorkColumnStore.getState().navigation.target).toEqual({ kind: 'empty' });
    expect(useBrowserColumnStore.getState()).toBe(browserBefore);
    expect(flush).not.toHaveBeenCalled();
    registerWorkspaceSurfaceLifecycle('web-tab', null);
    reset.mockRestore();
  });

  it('retains notebook and surfaces when Work saving is refused', async () => {
    const previous = { id: 'old', path: '/old' };
    mocks.memoState.selectedNotebook = previous;
    mocks.memoState.selectedNotebookId = previous.id;
    const target = { kind: 'web' as const, url: 'https://old.example' };
    seedWorkColumn((state) => ({ navigation: { ...state.navigation, target } }));
    useBrowserColumnStore.getState().openContent({
      id: 'saving-tab', title: 'Saving', icon: null, target,
    });
    const browserBefore = useBrowserColumnStore.getState();
    mocks.clearDocument.mockRejectedValueOnce(new NavigationCancelledError('Work save refused'));

    await expect(selectNotebook({
      id: 'next', name: 'Next', path: '/next', createdAt: 0, updatedAt: 0, isDefault: false,
    })).rejects.toBeInstanceOf(NavigationCancelledError);

    expect(mocks.setCurrentNotebook).not.toHaveBeenCalled();
    expect(mocks.memoState.setSelectedNotebook).not.toHaveBeenCalled();
    expect(mocks.memoState.selectedNote).toEqual({ notebookId: 'notebook-a', relativePath: 'old.md' });
    expect(useBrowserColumnStore.getState()).toBe(browserBefore);
    expect(useWorkColumnStore.getState().navigation.target).toEqual(target);
    expect(mocks.clearDocument).toHaveBeenCalledOnce();
  });

  it('only switches Work once when a queued notebook switch is superseded', async () => {
    let release!: () => void;
    const saving = new Promise<void>((resolve) => { release = resolve; });
    mocks.clearDocument.mockImplementationOnce(() => saving);
    const book = (id: string) => ({
      id, name: id, path: `/${id}`, createdAt: 0, updatedAt: 0, isDefault: false,
    });
    const reset = vi.spyOn(useBrowserColumnStore.getState(), 'reset');
    const first = selectNotebook(book('first'));
    await vi.waitFor(() => expect(mocks.clearDocument).toHaveBeenCalledOnce());
    const second = selectNotebook(book('second'));
    release();
    await Promise.all([first, second]);

    expect(mocks.setCurrentNotebook).toHaveBeenCalledExactlyOnceWith('second');
    expect(mocks.memoState.selectedNotebook?.id).toBe('second');
    expect(reset).not.toHaveBeenCalled();
    expect(useWorkColumnStore.getState().notebookSwitchesInFlight).toBe(0);
    reset.mockRestore();
  });

  it('rolls back notebook selection when switching the backend notebook fails', async () => {
    const previousNotebook = {
      id: 'old-notebook',
      name: 'Old notebook',
      path: '/old',
      createdAt: 0,
      updatedAt: 0,
      isDefault: false,
    };
    const nextNotebook = {
      id: 'next-notebook',
      name: 'Next notebook',
      path: '/next',
      createdAt: 0,
      updatedAt: 0,
      isDefault: false,
    };
    mocks.memoState.selectedNotebook = previousNotebook;
    mocks.memoState.selectedNotebookId = previousNotebook.id;
    mocks.setCurrentNotebook.mockRejectedValueOnce(new Error('notebook unavailable'));

    await expect(selectNotebook(nextNotebook)).rejects.toThrow('notebook unavailable');

    expect(mocks.memoState.selectedNotebook).toEqual(previousNotebook);
    expect(useWorkColumnStore.getState().navigation).toMatchObject({
      phase: 'failed',
      pendingTarget: { kind: 'empty' },
      failure: { message: 'notebook unavailable' },
    });
  });

  it('reconciles selection through the facade after deleting the active notebook', async () => {
    const deletedNotebook = {
      id: 'deleted-notebook',
      name: 'Deleted notebook',
      path: '/deleted',
      createdAt: 0,
      updatedAt: 0,
      isDefault: true,
    };
    const remainingNotebook = {
      ...deletedNotebook,
      id: 'remaining-notebook',
      name: 'Remaining notebook',
      path: '/remaining',
    };
    mocks.memoState.selectedNotebook = deletedNotebook;
    mocks.memoState.selectedNotebookId = deletedNotebook.id;

    await reconcileDeletedNotebook(deletedNotebook.id, [remainingNotebook]);

    expect(mocks.clearDocument).toHaveBeenCalledOnce();
    expect(mocks.memoState.setNotebooks).toHaveBeenCalledWith(
      [remainingNotebook],
      remainingNotebook.id,
    );
    expect(mocks.setCurrentNotebook).toHaveBeenCalledWith(remainingNotebook.id);
    expect(mocks.memoState.selectedNotebook?.id).toBe(remainingNotebook.id);
    expect(mocks.memoState.loadNotes).toHaveBeenCalledWith({
      notebookId: remainingNotebook.id,
    });
    expect(useWorkColumnStore.getState().navigation).toMatchObject({
      phase: 'idle',
      target: { kind: 'empty' },
    });
  });
});
