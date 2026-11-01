import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
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
  readDocument: vi.fn(),
  readFolderIndex: vi.fn(),
  resolveCollection: vi.fn(),
  setCurrentNotebook: vi.fn(),
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
  collections: { resolve: mocks.resolveCollection },
  files: { read: mocks.readFolderIndex, watchRoot: vi.fn().mockResolvedValue('lease'), unwatchRoot: vi.fn().mockResolvedValue(undefined) },
  mediaResources: {},
  externalDocuments: { read: mocks.readDocument },
  notes: { resolveLocation: mocks.resolveMarkdownLocation },
  notebooks: { setCurrent: mocks.setCurrentNotebook },
}));

import { useWorkColumnStore } from '../store/work-column-store';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { openWorkspaceSurface } from '../public/open-surface-api';
import { clearWorkspaceDocument, selectNotebook } from './workspace-navigation';
import { NotebookFolderView } from '@features/memo/components/notebook-folder-view';
import { useWorkspaceFocusStore } from '../store/workspace-focus-store';
import { registerWorkspaceSurfaceLifecycle } from '../store/surface-lifecycle-store';
import { createFolderCollectionContent } from '@features/collection/folder-collection';
import type { Notebook } from '@features/memo/store/note-store';

vi.mock('@features/memo/components/use-folder-tree', () => ({
  useFolderTree: () => ({ nodes: [], refresh: vi.fn(), refreshDirectories: vi.fn(), reload: vi.fn(), updateNoteMetadata: vi.fn() }),
}));
// Render only the tree selection boundary; row selection/keyboard behavior has
// its own tests. Parent callbacks and all navigation/store logic remain real.
vi.mock('@features/memo/components/notebook-file-tree', () => ({
  NotebookFileTree: (props: { onNoteSelect: (path: string) => void; onNoteOpenInNewTab: (path: string) => void; onFolderSelect: (path: string) => void }) => createElement('div', null,
    createElement('button', { onClick: () => props.onNoteSelect('/notes/a.md') }, 'Note A'),
    createElement('button', { onClick: () => props.onNoteSelect('/notes/b.md') }, 'Note B'),
    createElement('button', { onClick: () => props.onNoteOpenInNewTab('/notes/a.md') }, 'New tab'),
    createElement('button', { onClick: () => props.onFolderSelect('/notes/folder') }, 'Folder')),
}));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: () => () => {} }));
vi.mock('@platform/tauri/notebook-change-events', () => ({ subscribeNotebookChanges: () => () => {} }));
vi.mock('@features/memo/services/note-link-rewriter', () => ({ updateNoteLinksAfterMove: vi.fn() }));

function resetWorkspace() {
  useWorkColumnStore.setState({
    navigation: {
      phase: 'idle',
      showWorkColumnLoading: false,
      requestId: 0,
      target: { kind: 'empty' },
      pendingTarget: null,
      previousTarget: null,
      failure: null,
      retryToken: null,
    },
  });
}



describe('notebook tree navigation with an Agent in Browser', () => {
  const notebook = { id: 'notes', path: '/notes', name: 'Notes' } as Notebook;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

  beforeEach(async () => {
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    resetWorkspace();
    useBrowserColumnStore.getState().reset();
    mocks.memoState.selectedNotebook = notebook;
    mocks.memoState.selectedNotebookId = notebook.id;
    mocks.memoState.notebooks = [notebook];
    mocks.documentState.activeExternalSession = null;
    mocks.openExternalDocument.mockReset().mockImplementation(async (path: string, options: { scopePath: string }) => {
      mocks.documentState.activeExternalSession = {
        fileIdentity: { displayId: `display:${path}`, path }, scopePath: options.scopePath, transitionId: 1,
      };
    });
    mocks.clearDocument.mockReset().mockResolvedValue(undefined);
    mocks.resolveMarkdownLocation.mockReset().mockResolvedValue(null);
    mocks.readFolderIndex.mockReset().mockResolvedValue(null);
    mocks.resolveCollection.mockReset().mockResolvedValue({
      relativePath: 'folder/.index.yaml', collectionType: 'table',
      name: 'Folder', parseState: 'valid', identityConflict: false, indexSequence: 1,
    });
    useBrowserColumnStore.getState().openContent({
      id: 'agent:active', title: 'Agent', icon: null,
      target: { kind: 'agent_conversation', instanceId: 'active' },
    });
    useWorkspaceFocusStore.getState().focusHost('browser-column');
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root.render(createElement(NotebookFolderView, { notebook, onCreateNote: vi.fn() })));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    registerWorkspaceSurfaceLifecycle('note:a', null);
    useBrowserColumnStore.getState().reset();
    useWorkspaceFocusStore.getState().reset();
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  async function click(index: number) {
    await act(async () => container.querySelectorAll('button')[index].click());
  }

  function addBrowserNote() {
    useBrowserColumnStore.getState().openContent({
      id: 'note:a', title: 'A', icon: null,
      target: { kind: 'file-browser', folderPath: null, scopePath: '/notes', notebookId: 'notes',
        fileTreeVisible: true, fileTreeWidth: 220, activeFilePath: '/notes/a.md' },
    });
  }

  it('ordinary click opens Work while preserving the Browser Agent tab', async () => {
    await click(0);
    expect(useWorkColumnStore.getState().navigation.target).toMatchObject({ kind: 'external', path: '/notes/a.md' });
    expect(useBrowserColumnStore.getState().current?.id).toBe('agent:active');
    expect(useBrowserColumnStore.getState().current).not.toBeNull();
  });

  it('folder click opens Work even when Browser owns focus', async () => {
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('browser-column');
    await click(3);
    expect(useWorkColumnStore.getState().navigation.target).toMatchObject({ kind: 'folder-collection', folderPath: '/notes/folder' });
    expect(useBrowserColumnStore.getState().current?.id).toBe('agent:active');
  });

  it('a later note click retires a folder view before it finishes mounting', async () => {
    await click(3);
    expect(useWorkColumnStore.getState().navigation.target).toMatchObject({ kind: 'folder-collection', folderPath: '/notes/folder' });
    await click(1);
    expect(useWorkColumnStore.getState().navigation.target).toMatchObject({ kind: 'external', path: '/notes/b.md' });
    expect(useBrowserColumnStore.getState().current?.id).toBe('agent:active');
    expect(mocks.resolveCollection).not.toHaveBeenCalled();
  });

  it('clearing Work clears an open folder view', async () => {
    await click(3);
    await act(async () => { await clearWorkspaceDocument(); });
    expect(useWorkColumnStore.getState().navigation.target).toEqual({ kind: 'empty' });
  });

  it('switching notebook clears an open folder view', async () => {
    await click(3);
    const nextNotebook = { ...notebook, id: 'next', path: '/next' };
    await act(async () => { await selectNotebook(nextNotebook); });
    await act(async () => {});
    expect(mocks.memoState.selectedNotebook?.id).toBe('next');
    expect(useWorkColumnStore.getState().navigation.target).toEqual({ kind: 'empty' });
  });

  it('folder intent retires an older note loader and lands on the folder view', async () => {
    let finishOpen!: () => void;
    mocks.openExternalDocument.mockImplementationOnce(() => new Promise<void>(resolve => { finishOpen = resolve; }));
    await click(1);
    const oldRequestId = useWorkColumnStore.getState().navigation.requestId;
    await click(3);
    expect(useWorkColumnStore.getState().isCurrentNavigation(oldRequestId)).toBe(false);
    await act(async () => finishOpen());
    expect(useWorkColumnStore.getState().navigation.target).toMatchObject({ kind: 'folder-collection', folderPath: '/notes/folder' });
  });

  it('a configured folder still opens the folder home (never the collection directly)', async () => {
    mocks.readFolderIndex.mockResolvedValue(createFolderCollectionContent('notes', 'Folder', 'folder'));
    await click(3);
    expect(useWorkColumnStore.getState().navigation.target).toMatchObject({ kind: 'folder-collection', folderPath: '/notes/folder' });
    expect(mocks.resolveCollection).not.toHaveBeenCalled();
    expect(useBrowserColumnStore.getState().current?.id).toBe('agent:active');
  });

  it('ordinary click stays in Work even when the same note is current in Browser', async () => {
    addBrowserNote();
    await click(0);
    expect(useWorkColumnStore.getState().navigation.target).toMatchObject({ kind: 'external', path: '/notes/a.md' });
    expect(useBrowserColumnStore.getState().current?.id).toBe('note:a');
  });

  it('a later click wins when the first note waits for Browser saving', async () => {
    addBrowserNote();
    let finishSave!: (saved: boolean) => void;
    const flush = vi.fn(() => new Promise<boolean>((resolve) => { finishSave = resolve; }));
    registerWorkspaceSurfaceLifecycle('note:a', { status: 'ready', flush });
    await click(0);
    expect(flush).toHaveBeenCalledOnce();
    await click(1);
    await act(async () => finishSave(true));
    expect(useWorkColumnStore.getState().navigation.target).toMatchObject({ kind: 'external', path: '/notes/b.md' });
    expect(mocks.openExternalDocument).toHaveBeenCalledTimes(1);
    expect(useBrowserColumnStore.getState().current?.id).toBe('note:a');
  });

  it('explicit browser action replaces the surface and preserves the Agent in history', async () => {
    await click(2);
    expect(useBrowserColumnStore.getState().backStack.some(tab => tab.id === 'agent:active')).toBe(true);
    expect(useBrowserColumnStore.getState().current?.id).not.toBe('agent:active');
    expect(useWorkColumnStore.getState().navigation.target).toEqual({ kind: 'empty' });
  });
  it('clearing Work retires a tree click waiting for Browser saving', async () => {
    addBrowserNote();
    let finishSave!: (saved: boolean) => void;
    registerWorkspaceSurfaceLifecycle('note:a', { status: 'ready', flush: () => new Promise<boolean>(resolve => { finishSave = resolve; }) });
    await click(0);
    await act(async () => { await clearWorkspaceDocument(); });
    await act(async () => finishSave(true));
    expect(useWorkColumnStore.getState().navigation.target).toEqual({ kind: 'empty' });
    expect(mocks.openExternalDocument).not.toHaveBeenCalled();
  });

  it('switching notebook retires a tree click waiting for Browser saving', async () => {
    addBrowserNote();
    let finishSave!: (saved: boolean) => void;
    registerWorkspaceSurfaceLifecycle('note:a', { status: 'ready', flush: () => new Promise<boolean>(resolve => { finishSave = resolve; }) });
    await click(0);
    const nextNotebook = { ...notebook, id: 'next', path: '/next' };
    let switching!: Promise<unknown>;
    await act(async () => { switching = selectNotebook(nextNotebook); });
    await act(async () => { finishSave(true); await switching; });
    expect(mocks.memoState.selectedNotebook?.id).toBe('next');
    expect(useWorkColumnStore.getState().navigation.target).toEqual({ kind: 'empty' });
    expect(mocks.openExternalDocument).not.toHaveBeenCalled();
  });

  it('a new click invalidates an older loader before its own save finishes', async () => {
    let finishOpen!: () => void;
    let oldRequestId = 0;
    mocks.openExternalDocument.mockImplementationOnce(() => {
      oldRequestId = useWorkColumnStore.getState().navigation.requestId;
      return new Promise<void>(resolve => { finishOpen = resolve; });
    });
    await click(1);
    addBrowserNote();
    let finishSave!: (saved: boolean) => void;
    registerWorkspaceSurfaceLifecycle('note:a', { status: 'ready', flush: () => new Promise<boolean>(resolve => { finishSave = resolve; }) });
    await click(0);
    expect(useWorkColumnStore.getState().isCurrentNavigation(oldRequestId)).toBe(false);
    await act(async () => finishOpen());
    expect(useWorkColumnStore.getState().navigation.target).toEqual({ kind: 'empty' });
    await act(async () => finishSave(true));
    expect(useWorkColumnStore.getState().navigation.target).toMatchObject({ kind: 'external', path: '/notes/a.md' });
  });

  it('retires a collection file waiting on metadata before its adapter starts a transaction', async () => {
    let finishRead!: (source: string) => void;
    mocks.readDocument.mockReset().mockImplementationOnce(() => new Promise<string>(resolve => { finishRead = resolve; }));
    let opening!: ReturnType<typeof openWorkspaceSurface>;
    await act(async () => {
      opening = openWorkspaceSurface({ host: 'main-third', target: {
        kind: 'table', filePath: '/notes/slow.table.yaml', notebookPath: '/notes', notebookId: 'notes',
      } });
    });
    expect(mocks.readDocument).toHaveBeenCalledOnce();
    await click(0);
    await act(async () => finishRead('invalid collection'));
    await expect(opening).resolves.toMatchObject({ status: 'cancelled' });
    expect(useWorkColumnStore.getState().navigation.target).toMatchObject({ kind: 'external', path: '/notes/a.md' });
    expect(mocks.clearDocument).not.toHaveBeenCalled();
  });

});
