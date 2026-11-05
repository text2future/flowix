import { seedWorkColumn } from '@features/workspace/test-support/workspace-fixtures';
import { act } from 'react';
import { FOLDER_SINGLE_CLICK_DELAY_MS } from './notebook-tree-row';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collections, files, notes, type DocTreeItem } from '@platform/tauri/client';
import { pinnedEntries, type PinnedEntry } from '@platform/tauri/client/pinned';
import { toast } from '@/lib/toast';
import { EXTERNAL_FILE_DROP_EVENT } from '@features/document/components/use-external-file-drop';
import type { FolderTreeController } from './use-folder-tree';
import * as folderTreeModule from './use-folder-tree';
import { noteMetadata } from '../services/note-metadata-service';
import * as openSurfaceApi from '@features/workspace/public/open-surface-api';
import { useNotebookTreeSelectionStore } from '../store/notebook-tree-selection-store';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import {
  NotebookFileTree,
  type NotebookMoveResult,
  type NotebookMoveSource,
} from './notebook-file-tree';

const repositoryTreeTestState = vi.hoisted(() => ({ loadComplete: false }));
const pinnedNote = (relativePath: string, title: string): PinnedEntry => ({
  entryKind: 'note', relativePath, title, createdAt: 1, modifiedMs: 1,
  kind: 'note', collectionId: null, sizeBytes: 0,
});
const translationTestState = vi.hoisted(() => ({ t: (key: string) => key }));

vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ t: translationTestState.t }),
}));
vi.mock('@platform/tauri/notebook-change-events', async (importOriginal) => ({
  ...await importOriginal<typeof import('@platform/tauri/notebook-change-events')>(),
  subscribeNotebookChanges: () => () => {},
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@features/memo/services/note-link-rewriter', () => ({ updateNoteLinksAfterMove: vi.fn() }));
vi.mock('@shared/ui/overlay-scrollbar', () => ({
  OverlayScrollbar: ({
    children,
    scrollerRef,
    onScroll,
  }: {
    children: React.ReactNode;
    scrollerRef?: React.MutableRefObject<HTMLDivElement | null> | React.RefCallback<HTMLDivElement>;
    onScroll?: React.UIEventHandler<HTMLDivElement>;
  }) => (
    <div
      data-test-tree-scroller="true"
      ref={(node) => {
        if (typeof scrollerRef === 'function') scrollerRef(node);
        else if (scrollerRef) scrollerRef.current = node;
      }}
      onScroll={onScroll}
    >
      {children}
    </div>
  ),
}));
vi.mock('@shared/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div role="menu">{children}</div>,
  ContextMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: React.MouseEventHandler<HTMLDivElement> }) => <div onClick={onClick}>{children}</div>,
  ContextMenuSubmenu: ({ label, children }: { label: string; children: React.ReactNode }) => <div>{label}{children}</div>,
  ContextMenuSeparator: () => <hr />,
  useContextMenuContext: () => ({ openAt: vi.fn() }),
}));
vi.mock('@features/memo/components/file-type-icon', () => ({
  FileTypeIcon: () => null,
  NotebookTreeResourceIcon: () => null,
}));
vi.mock('@features/memo/components/memo-card-actions', () => ({ MemoCardActions: () => null }));
vi.mock('@platform/tauri/client/pinned', () => ({
  pinnedEntries: { list: vi.fn(async () => ({ entries: [], nextCursor: null, hasMore: false })) },
  listenToPinnedChanges: () => Promise.resolve(() => {}),
}));
vi.mock('@features/agent/public/workspace-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@features/agent/public/workspace-api')>(),
  getWorkspaceAgentRepositories: () => [{ path: '/repos/project', name: 'project', missing: false }],
}));
vi.mock('@features/memo/components/use-folder-tree', async (importOriginal) => ({
  ...await importOriginal<typeof import('@features/memo/components/use-folder-tree')>(),
  useFolderTree: (_path: string, { enabled = true }: { enabled?: boolean } = {}) => ({
    rootChildren: [],
    nodes: new Map(),
    expanded: new Set(),
    loading: enabled && !repositoryTreeTestState.loadComplete,
    error: null,
    loadingDirectories: new Set(),
    directoryErrors: new Set(),
    toggle: vi.fn(),
    expandTo: vi.fn(async () => {}),
    collapseAll: vi.fn(),
    refresh: vi.fn(async () => {}),
    refreshDirectories: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
  }),
}));
vi.mock('@features/memo', () => ({
  NOTE_COLOR_HEX: { blue: '#0000ff' },
  useNoteStore: Object.assign(
    (selector: (state: { memos: never[]; selectedMemo: null }) => unknown) => selector({ memos: [], selectedMemo: null }),
    { getState: () => ({ memos: [], selectedMemo: null }) },
  ),
}));

type TestMoveNote = (
  sources: NotebookMoveSource[],
  target: string,
) => Promise<NotebookMoveResult>;

const successfulMove: TestMoveNote = async (sources, target) => ({
  movedPaths: sources.map((source) => (
    `${target}/${source.path.slice(source.path.lastIndexOf('/') + 1)}`
  )),
  failedPaths: [],
});

const moveSource = (path: string): NotebookMoveSource => ({ path });

function item(fullPath: string, type: 'folder' | 'document'): DocTreeItem {
  return {
    id: fullPath,
    fullPath,
    name: fullPath.slice(fullPath.lastIndexOf('/') + 1),
    type,
    parentId: null,
    children: type === 'folder' ? [] : null,
    sizeBytes: type === 'document' ? 0 : null,
    modifiedMs: null,
    createdMs: null,
    memoCreatedMs: null,
  };
}

function pointerEvent(type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: 7 });
  return event;
}

describe('NotebookFileTree pointer dragging', () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  let host: HTMLDivElement;
  let captured = false;
  let capturedElement: HTMLElement | null = null;

  beforeEach(() => {
    noteMetadata.clear();
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    repositoryTreeTestState.loadComplete = false;
    captured = false;
    capturedElement = null;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(204);
    HTMLElement.prototype.setPointerCapture = vi.fn(function (this: HTMLElement) {
      captured = true;
      capturedElement = this;
    });
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => captured);
    HTMLElement.prototype.releasePointerCapture = vi.fn(() => { captured = false; });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    host.remove();
    environment.IS_REACT_ACT_ENVIRONMENT = false;
    vi.restoreAllMocks();
  });

  async function mount(
    onMoveNote: TestMoveNote,
    noteOverride?: DocTreeItem,
    onFolderSelect?: (path: string) => void,
  ) {
    const folder = item('/notes/projects', 'folder');
    const note = noteOverride ?? item('/notes/a.md', 'document');
    const refresh = vi.fn(async () => {});
    const tree = {
      rootChildren: [folder, note],
      nodes: new Map([[folder.fullPath, folder], [note.fullPath, note]]),
      expanded: new Set<string>(),
      loading: false,
      error: null,
      toggle: vi.fn(),
      expandTo: vi.fn(async () => {}),
      collapseAll: vi.fn(),
      refresh,
      refreshDirectories: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
    } as unknown as FolderTreeController;
    const root = createRoot(host);
    await act(async () => root.render(
      <NotebookFileTree notebookPath="/notes" notebookName="Notes" tree={{ ...tree } as FolderTreeController}
        onNoteSelect={vi.fn()} onFolderSelect={onFolderSelect} onCreateNote={vi.fn()} onMoveNote={onMoveNote} />,
    ));
    return { root, refresh, tree };
  }

  it('renders hidden folders with 80% opacity on the icon and the label', async () => {
    const hiddenFolder = item('/notes/.trash', 'folder');
    const visibleFolder = item('/notes/projects', 'folder');
    const tree = {
      rootChildren: [hiddenFolder, visibleFolder],
      nodes: new Map([[hiddenFolder.fullPath, hiddenFolder], [visibleFolder.fullPath, visibleFolder]]),
      expanded: new Set<string>(), loading: false, error: null,
      toggle: vi.fn(), expandTo: vi.fn(async () => {}), collapseAll: vi.fn(),
      refresh: vi.fn(async () => {}), refreshDirectories: vi.fn(async () => {}), reload: vi.fn(async () => {}),
    } as unknown as FolderTreeController;
    const root = createRoot(host);
    try {
      await act(async () => root.render(
        <NotebookFileTree notebookPath="/notes" notebookName="Notes" tree={tree}
          onNoteSelect={vi.fn()} onCreateNote={vi.fn()} onMoveNote={successfulMove} />,
      ));
      const row = (path: string) => host.querySelector<HTMLElement>(`[data-notebook-tree-path="${path}"]`)!;
      const label = (path: string) => row(path).querySelector<HTMLElement>('span.truncate')!;

      // 隐藏文件夹: 图标套 0.5 类, 文案是 0.82 × 0.8 (行内样式压过 opacity-[0.82])。
      const hiddenIcon = (path: string) => row(path).querySelector('button')?.querySelector('.opacity-50') ?? null;
      expect(hiddenIcon('/notes/.trash')).not.toBeNull();
      expect(Number.parseFloat(label('/notes/.trash').style.opacity)).toBeCloseTo(0.656, 3);
      // 普通文件夹不受影响。
      expect(hiddenIcon('/notes/projects')).toBeNull();
      expect(label('/notes/projects').style.opacity).toBe('');
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each([false, true])('restores retry feedback after initial loading (skip=%s)', async (skipInitialLoading) => {
    const tree = {
      rootChildren: [],
      nodes: new Map(),
      expanded: new Set(),
      loading: true,
      error: null,
      toggle: vi.fn(),
      expandTo: vi.fn(async () => {}),
      collapseAll: vi.fn(),
      refresh: vi.fn(async () => {}),
      refreshDirectories: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
    } as unknown as FolderTreeController;
    const root = createRoot(host);
    const render = () => root.render(
      <NotebookFileTree
        notebookPath="/notes" notebookName="Notes" tree={{ ...tree }}
        skipInitialLoading={skipInitialLoading} contentClassName="flowix-list-content-enter"
        onNoteSelect={vi.fn()} onCreateNote={vi.fn()} onMoveNote={successfulMove}
      />,
    );
    const skeleton = () => host.querySelector('[data-file-tree-loading-skeleton]');
    try {
      await act(async () => render());
      expect(Boolean(skeleton())).toBe(!skipInitialLoading);

      tree.loading = false;
      tree.error = 'unreadable';
      await act(async () => render());
      expect(skeleton()).toBeNull();

      tree.loading = true;
      tree.error = null;
      await act(async () => render());
      expect(skeleton()).not.toBeNull();

      const note = item('/notes/a.md', 'document');
      tree.loading = false;
      tree.rootChildren = [note];
      tree.nodes = new Map([[note.fullPath, note]]);
      await act(async () => render());
      const content = host.querySelector('.notebook-file-tree__virtual-items');
      expect(content?.classList.contains('flowix-list-content-enter')).toBe(true);

      // Refreshing visible data keeps the same animation-bearing element.
      tree.loading = true;
      await act(async () => render());
      expect(host.querySelector('.notebook-file-tree__virtual-items')).toBe(content);
      expect(content?.classList.contains('flowix-list-content-enter')).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });

  async function mountNested(onMoveNote: TestMoveNote) {
    const folder = item('/notes/projects', 'folder');
    const childNote = item('/notes/projects/child.md', 'document');
    const rootNote = item('/notes/root.md', 'document');
    const tree = {
      rootChildren: [folder, rootNote],
      nodes: new Map([[folder.fullPath, { ...folder, children: [childNote] }]]),
      expanded: new Set([folder.fullPath]),
      loading: false,
      error: null,
      toggle: vi.fn(),
      expandTo: vi.fn(async () => {}),
      collapseAll: vi.fn(),
      refresh: vi.fn(async () => {}),
      refreshDirectories: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
    } as unknown as FolderTreeController;
    const root = createRoot(host);
    await act(async () => root.render(
      <NotebookFileTree notebookPath="/notes" notebookName="Notes" tree={tree}
        onNoteSelect={vi.fn()} onCreateNote={vi.fn()} onMoveNote={onMoveNote} />,
    ));
    return { root, tree };
  }

  async function mountFlatNotes(onMoveNote: TestMoveNote) {
    const folder = item('/notes/projects', 'folder');
    const notes = ['a', 'b', 'c', 'd'].map((name) => item(`/notes/${name}.md`, 'document'));
    const tree = {
      rootChildren: [folder, ...notes],
      nodes: new Map([[folder.fullPath, folder]]),
      expanded: new Set([folder.fullPath]),
      loading: false,
      error: null,
      toggle: vi.fn(),
      expandTo: vi.fn(async () => {}),
      collapseAll: vi.fn(),
      refresh: vi.fn(async () => {}),
      refreshDirectories: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
    } as unknown as FolderTreeController;
    const root = createRoot(host);
    const onNoteSelect = vi.fn();
    const render = () => root.render(
      <NotebookFileTree notebookPath="/notes" notebookName="Notes" tree={{ ...tree } as FolderTreeController}
        onNoteSelect={onNoteSelect} onCreateNote={vi.fn()} onMoveNote={onMoveNote} />,
    );
    await act(async () => render());
    return {
      root,
      tree,
      onNoteSelect,
      rerender: async () => { await act(async () => render()); },
    };
  }

  function clickEvent(modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}) {
    return new MouseEvent('click', { bubbles: true, button: 0, ...modifiers });
  }

  it('reuses flattened data for status changes and invalidates only affected tree inputs', async () => {
    const loadedSpy = vi.spyOn(folderTreeModule, 'flattenLoadedTree');
    const visibleSpy = vi.spyOn(folderTreeModule, 'flattenVisibleTree');
    const { root, tree } = await mount(successfulMove);
    const roots = tree.rootChildren;
    const loadedCalls = () => loadedSpy.mock.calls.filter(([state]) => state.rootChildren === roots).length;
    const visibleCalls = () => visibleSpy.mock.calls.filter(([state]) => state.rootChildren === roots).length;
    const render = async (next: FolderTreeController) => {
      await act(async () => root.render(
        <NotebookFileTree notebookPath="/notes" notebookName="Notes" tree={next}
          onNoteSelect={vi.fn()} onCreateNote={vi.fn()} onMoveNote={successfulMove} />,
      ));
    };
    try {
      const initialLoaded = loadedCalls();
      const initialVisible = visibleCalls();
      await render({ ...tree, loading: true, error: 'read failed',
        loadingDirectories: new Set(['/notes/projects']), directoryErrors: new Set(['/notes/projects']),
        refresh: vi.fn(async () => {}) });
      expect(loadedCalls()).toBe(initialLoaded);
      expect(visibleCalls()).toBe(initialVisible);

      const expanded = new Set(['/notes/projects']);
      await render({ ...tree, expanded });
      expect(loadedCalls()).toBe(initialLoaded);
      expect(visibleCalls()).toBe(initialVisible + 1);

      const child = item('/notes/projects/child.md', 'document');
      const nodes = new Map(tree.nodes);
      nodes.set('/notes/projects', { ...roots[0], children: [child] });
      await render({ ...tree, expanded, nodes });
      expect(loadedCalls()).toBe(initialLoaded + 1);
      expect(visibleCalls()).toBe(initialVisible + 2);
      expect(host.querySelector('[data-notebook-tree-path="/notes/projects/child.md"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('creates from the files section header without a fixed destination', async () => {
    const { root, tree } = await mount(successfulMove);
    const onCreateNote = vi.fn(async () => {});
    try {
      await act(async () => root.render(
        <NotebookFileTree notebookPath="/notes" notebookName="Notes" tree={tree}
          onNoteSelect={vi.fn()} onCreateNote={onCreateNote} onMoveNote={successfulMove} />,
      ));
      const header = Array.from(host.querySelectorAll<HTMLElement>('.notebook-file-tree__section-header'))
        .find((element) => element.textContent?.includes('memo.fileTree.sectionTitle'));
      const trigger = header?.querySelector<HTMLButtonElement>(
        'button[aria-label="memo.fileTree.moreSectionActions"]',
      );
      expect(trigger).not.toBeNull();
      await act(async () => trigger!.click());
      const create = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((element) => element.textContent === 'memo.fileTree.newNote');
      expect(create).toBeDefined();
      await act(async () => create!.click());
      expect(onCreateNote).toHaveBeenCalledExactlyOnceWith(undefined);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('keeps the expanded folder visible while Enter saves its new name', async () => {
    const { root, tree } = await mount(successfulMove);
    const folder = tree.rootChildren[0];
    const renameFolder = vi.fn<(path: string, name: string, scope: string) => Promise<string>>();
    const base = { ...tree, renameFolder, loadingDirectories: new Set<string>(), directoryErrors: new Set<string>() };
    const render = (current: FolderTreeController) => root.render(
      <NotebookFileTree notebookPath="/notes" notebookName="Notes" tree={current}
        onNoteSelect={vi.fn()} onCreateNote={vi.fn()} onMoveNote={successfulMove} />,
    );
    let finishRename!: (path: string) => void;
    renameFolder.mockImplementationOnce(() => new Promise((resolve) => { finishRename = resolve; }));
    try {
      await act(async () => render(base));
      const child = item(`${folder.fullPath}/child.md`, 'document');
      const expanded = {
        ...base,
        expanded: new Set([folder.fullPath]),
        nodes: new Map([[folder.fullPath, { ...folder, children: [child] }]]),
      };
      await act(async () => render(expanded));
      const rename = Array.from(host.querySelectorAll('div')).find((element) => element.textContent === 'memo.fileTree.rename');
      expect(rename).toBeDefined();
      await act(async () => rename!.dispatchEvent(clickEvent()));
      const input = host.querySelector<HTMLInputElement>('input');
      expect(input).not.toBeNull();
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'renamed');
        input!.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => input!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })));
      expect(renameFolder).toHaveBeenCalledWith(folder.fullPath, 'renamed', '/notes');
      expect(host.querySelector('[data-notebook-tree-path="/notes/projects/child.md"]')).not.toBeNull();
      expect(host.querySelector('[aria-label="memo.fileTree.loading"]')).not.toBeNull();
      await act(async () => finishRename('/notes/renamed'));
      expect(base.toggle).not.toHaveBeenCalled();
      expect(expanded.expanded.has(folder.fullPath)).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each(['table', 'media_library', 'work_documents'])('uses shared selection for a pinned %s', async (kind) => {
    const { root, tree } = await mount(successfulMove);
    const openSurface = vi.spyOn(openSurfaceApi, 'openWorkspaceSurface').mockResolvedValue({ status: 'cancelled', host: 'column-1', reason: 'navigation-cancelled' });
    const relativePath = kind === 'media_library' ? 'pinned.lib.yaml' : 'pinned.index.yaml';
    vi.mocked(pinnedEntries.list).mockResolvedValueOnce({
      entries: [{ entryKind: 'collection', relativePath, title: 'Pinned collection',
        createdAt: 1, modifiedMs: 1, kind, collectionId: 'pinned-collection', sizeBytes: 1 }],
      nextCursor: null, hasMore: false,
    });
    const onNoteSelect = vi.fn();
    try {
      await act(async () => root.render(
        <NotebookFileTree notebookId="notebook-1" notebookPath="/notes" notebookName="Notes" tree={tree}
          onNoteSelect={onNoteSelect} onCreateNote={vi.fn()} onMoveNote={successfulMove} />,
      ));
      const row = host.querySelector<HTMLElement>(`[data-notebook-pinned-section] [data-notebook-tree-path="/notes/${relativePath}"]`)!;
      expect(row).not.toBeNull();
      await act(async () => row.dispatchEvent(clickEvent()));
      expect(useNotebookTreeSelectionStore.getState().paths).toEqual([`/notes/${relativePath}`]);
      expect(row.getAttribute('aria-selected')).toBe('true');
      if (kind !== 'media_library') expect(openSurface).toHaveBeenCalledTimes(1);
      else expect(onNoteSelect).toHaveBeenCalledWith(`/notes/${relativePath}`);
      // Modifier clicks change selection without reopening the collection.
      openSurface.mockClear();
      onNoteSelect.mockClear();
      await act(async () => row.dispatchEvent(clickEvent({ metaKey: true })));
      expect(useNotebookTreeSelectionStore.getState().paths).toEqual([]);
      expect(openSurface).not.toHaveBeenCalled();
      expect(onNoteSelect).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      openSurface.mockRestore();
    }
  });

  it('opens a pinned note using its complete nested notebook path', async () => {
    const { root, tree } = await mount(successfulMove);
    const onNoteSelect = vi.fn();
    vi.mocked(pinnedEntries.list).mockResolvedValueOnce({
      entries: [pinnedNote('projects/nested/note.md', 'note')],
      nextCursor: null, hasMore: false,
    });
    try {
      await act(async () => root.render(
        <NotebookFileTree notebookId="notebook-1" notebookPath="/notes" notebookName="Notes" tree={tree}
          onNoteSelect={onNoteSelect} onCreateNote={vi.fn()} onMoveNote={successfulMove} />,
      ));
      const row = host.querySelector<HTMLElement>('[data-notebook-tree-path="/notes/projects/nested/note.md"]');
      expect(row).not.toBeNull();
      await act(async () => row!.dispatchEvent(clickEvent()));
      expect(onNoteSelect.mock.calls[0]?.[0]).toBe('/notes/projects/nested/note.md');
      await act(async () => root.render(
        <NotebookFileTree notebookId="notebook-1" notebookPath="/notes" notebookName="Notes" tree={tree}
          activeFilePath="/notes/projects/nested/note.md"
          onNoteSelect={onNoteSelect} onCreateNote={vi.fn()} onMoveNote={successfulMove} />,
      ));
      expect(tree.expandTo).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('selects a folder after a single click and toggles without selecting on double click', async () => {
    vi.useFakeTimers();
    const onFolderSelect = vi.fn();
    const { root, tree } = await mount(successfulMove, undefined, onFolderSelect);
    const folderRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="folder"]')!;
    await act(async () => {
      folderRow.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      folderRow.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
      folderRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    });
    expect(onFolderSelect).not.toHaveBeenCalled();
    expect(folderRow.getAttribute('aria-selected')).toBe('false');
    expect(tree.toggle).toHaveBeenCalledWith('/notes/projects');

    await act(async () => folderRow.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    expect(onFolderSelect).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(FOLDER_SINGLE_CLICK_DELAY_MS + 1));
    expect(folderRow.getAttribute('aria-selected')).toBe('true');
    expect(onFolderSelect).toHaveBeenCalledWith('/notes/projects');

    // detail 0 是程序化 / 辅助技术激活, 没有双击窗口, 立即生效且不用等定时器。
    onFolderSelect.mockClear();
    await act(async () => folderRow.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onFolderSelect).toHaveBeenCalledWith('/notes/projects');
    await act(async () => root.unmount());
  });

  it('drops the pending folder click when another row is clicked within the double-click window', async () => {
    vi.useFakeTimers();
    const onFolderSelect = vi.fn();
    const { root } = await mount(successfulMove, undefined, onFolderSelect);
    const folderRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="folder"]')!;
    const noteRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="note"]')!;

    // 单击文件夹后立刻点另一行: 后一次交互必须作废前一次待定的选中/打开。
    await act(async () => folderRow.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    await act(async () => noteRow.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    expect(useNotebookTreeSelectionStore.getState().paths).toEqual(['/notes/a.md']);
    await act(async () => vi.advanceTimersByTime(FOLDER_SINGLE_CLICK_DELAY_MS + 1));
    expect(onFolderSelect).not.toHaveBeenCalled();
    expect(useNotebookTreeSelectionStore.getState().paths).toEqual(['/notes/a.md']);
    await act(async () => root.unmount());
  });

  it.each(['collection', 'table', 'media-library'] as const)('highlights the folder owning an active %s including damaged file surfaces', async (kind) => {
    const previousNavigation = useWorkColumnStore.getState().navigation;
    const { root } = await mount(successfulMove);
    try {
      await act(async () => seedWorkColumn({ navigation: {
        ...previousNavigation,
        target: kind === 'collection' ? {
          kind: 'collection', displayId: 'collection:projects', notebookId: 'notes',
          collectionId: 'projects', viewId: null, collectionType: 'table',
          filePath: '/notes/projects/.index.yaml', notebookPath: '/notes', name: 'Projects',
        } : {
          kind, filePath: '/notes/projects/.index.yaml', notebookPath: '/notes', notebookId: 'notes', unavailableReason: '集合文件格式无效',
        },
      } }));
      const folderRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="folder"]')!;
      expect(folderRow.getAttribute('aria-selected')).toBe('true');
      expect(folderRow.classList.contains('bg-[var(--muted)]')).toBe(true);

      await act(async () => seedWorkColumn({ navigation: {
        ...previousNavigation, target: { kind: 'empty' },
      } }));
      expect(folderRow.getAttribute('aria-selected')).toBe('false');
      expect(folderRow.classList.contains('bg-[var(--muted)]')).toBe(false);
    } finally {
      await act(async () => {
        root.unmount();
        seedWorkColumn({ navigation: previousNavigation });
      });
    }
  });

  // 期望行为：展开仓库分区后自动把该分区顶端滚到树视口顶部（36px = 树头高度）。
  // 实测 notebook-file-tree.tsx 没有任何驱动这段滚动的代码，基线版本同样没有，
  // 属于“功能未实现”而不是测试环境问题。用 it.fails 标记已知缺失，避免常驻红榜；
  // 一旦实现补上，这条会变成“意外通过”并提醒把 it.fails 改回 it。
  it.fails('scrolls an expanded repository to the top of the tree viewport after it renders', async () => {
    const { root, tree } = await mount(successfulMove);
    const scroller = host.querySelector<HTMLDivElement>('[data-test-tree-scroller="true"]')!;
    const repositoryButton = host.querySelector<HTMLButtonElement>('button[title="/repos/project"]')!;
    let scrollTop = 10;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        // Before the expanded tree finishes loading, the browser clamps the
        // requested position to the old content's smaller scroll range.
        scrollTop = Math.min(value, repositoryTreeTestState.loadComplete ? 500 : 80);
      },
    });

    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === scroller) return new DOMRect(0, 50, 320, 204);
      // Viewport coordinates move with scrollTop, just as they do in the browser.
      if (this.contains(repositoryButton)) return new DOMRect(0, 330 - (scrollTop - 10), 300, 50);
      return originalGetBoundingClientRect.call(this);
    });

    await act(async () => {
      repositoryButton.dispatchEvent(clickEvent());
    });

    expect(repositoryButton.getAttribute('aria-expanded')).toBe('true');
    expect(scroller.scrollTop).toBe(10);

    repositoryTreeTestState.loadComplete = true;
    await act(async () => root.render(
      <NotebookFileTree notebookPath="/notes" notebookName="Notes" tree={tree}
        onNoteSelect={vi.fn()} onCreateNote={vi.fn()} onMoveNote={successfulMove} />,
    ));
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    const repositoryTop = repositoryButton.parentElement!.getBoundingClientRect().top;
    expect(repositoryTop - scroller.getBoundingClientRect().top).toBe(36);
    await act(async () => root.unmount());
  });

  it('captures a drag on the clicked row so a normal click can still open it', async () => {
    const { root } = await mount(successfulMove);
    const noteRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="note"]')!;
    const treeRoot = host.querySelector<HTMLElement>('[data-notebook-tree-root="true"]')!;

    await act(async () => noteRow.dispatchEvent(pointerEvent('pointerdown', 10, 10)));

    expect(capturedElement).toBe(noteRow);
    expect(capturedElement).not.toBe(treeRoot);
    await act(async () => root.unmount());
  });

  it('does not load full note metadata while the tree is mounted', async () => {
    const readDocument = vi.spyOn(notes, 'readDocument').mockResolvedValue(null as never);
    const { root } = await mount(successfulMove);

    expect(readDocument).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('renders note icon and colors from tree metadata without loading the full memo', async () => {
    const readDocument = vi.spyOn(notes, 'readDocument').mockResolvedValue(null as never);
    const note = {
      ...item('/notes/a.md', 'document'),
      memoMeta: {
        icon: 'flashlight',
        colors: ['blue'],
        favorited: false,
      },
    } satisfies DocTreeItem;
    const { root } = await mount(successfulMove, note);
    const noteRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="note"]')!;

    expect(noteRow.querySelector('img')).not.toBeNull();
    expect(noteRow.querySelector('.lucide-file')).toBeNull();
    expect(noteRow.querySelector('[aria-label="Note colors"]')).not.toBeNull();
    expect(readDocument).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('does not pass memo ids with drag sources', async () => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const note = {
      ...item('/notes/a.md', 'document'),
      memoMeta: {
        icon: null,
        colors: [],
        favorited: false,
      },
    } satisfies DocTreeItem;
    const { root } = await mount(onMoveNote, note);
    const noteRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="note"]')!;
    const folderRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="folder"]')!;
    vi.mocked(document.elementFromPoint).mockReturnValue(folderRow);

    await act(async () => noteRow.dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    await act(async () => noteRow.dispatchEvent(pointerEvent('pointermove', 20, 10)));
    await act(async () => noteRow.dispatchEvent(pointerEvent('pointerup', 20, 10)));

    await vi.waitFor(() => expect(onMoveNote).toHaveBeenCalledWith(
      [{ path: '/notes/a.md' }],
      '/notes/projects',
    ));
    await act(async () => root.unmount());
  });

  async function mountFolderDraft(parentPath: string) {
    const rootFolder = item('/notes/projects', 'folder');
    const childFolder = item('/notes/projects/archive', 'folder');
    const childNote = item('/notes/projects/child.md', 'document');
    const rootNote = item('/notes/root.md', 'document');
    const folderWithChildren = { ...rootFolder, children: [childFolder, childNote] };
    const tree = {
      rootChildren: parentPath === '/notes' ? [rootFolder, rootNote] : [rootFolder],
      nodes: new Map([[rootFolder.fullPath, folderWithChildren]]),
      expanded: new Set(parentPath === '/notes/projects' ? [rootFolder.fullPath] : []),
      loading: false,
      error: null,
      toggle: vi.fn(),
      expandTo: vi.fn(async () => {}),
      collapseAll: vi.fn(),
      refresh: vi.fn(async () => {}),
      refreshDirectories: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
    } as unknown as FolderTreeController;
    const root = createRoot(host);
    await act(async () => root.render(
      <NotebookFileTree
        notebookPath="/notes/"
        notebookName="Notes"
        tree={tree}
        createFolderRequest={{ id: 1, parentPath }}
        onNoteSelect={vi.fn()}
        onCreateNote={vi.fn()}
        onMoveNote={vi.fn<TestMoveNote>(successfulMove)}
      />,
    ));
    return { root, tree };
  }

  function setInputValue(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
  }

  function dispatchInputKey(input: HTMLInputElement, key: string, keyCode: number): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { value: keyCode });
    input.dispatchEvent(event);
    return event;
  }

  function directRows(list: Element, depth: number): Element[] {
    return Array.from(list.querySelectorAll<HTMLElement>('[data-notebook-tree-kind]'))
      .filter((row) => row.parentElement?.dataset.notebookTreeDepth === String(depth));
  }

  it.each(['/notes', '/notes/projects'])('places a folder draft before sibling folders in %s', async (parentPath) => {
    const { root } = await mountFolderDraft(parentPath);
    const input = host.querySelector('input')!;
    const list = host.querySelector('[role="tree"]')!;
    const depth = parentPath === '/notes' ? 0 : 1;
    const rows = directRows(list, depth);
    const firstFolderIndex = rows.findIndex((row) => row.getAttribute('data-notebook-tree-kind') === 'folder');
    const firstMatchingRow = rows[firstFolderIndex];
    const virtualRows = Array.from(host.querySelectorAll<HTMLElement>('[data-notebook-virtual-row]'));
    const draftVirtualRow = input.closest<HTMLElement>('[data-notebook-virtual-row]')!;
    const matchingVirtualRow = firstMatchingRow.closest<HTMLElement>('[data-notebook-virtual-row]')!;
    expect(virtualRows.indexOf(draftVirtualRow) + 1).toBe(virtualRows.indexOf(matchingVirtualRow));
    expect(input.parentElement?.style.marginLeft).toBe(
      parentPath === '/notes' ? '6px' : '26px',
    );
    await act(async () => root.unmount());
  });

  it('renders a folder icon beside the folder draft input', async () => {
    const { root } = await mountFolderDraft('/notes');
    const input = host.querySelector<HTMLInputElement>('input')!;
    const icon = host.querySelector<HTMLElement>('[data-notebook-tree-draft-icon="folder"]')!;

    expect(icon).not.toBeNull();
    expect(icon.nextElementSibling).toBe(input);
    expect(icon.querySelector('svg')).not.toBeNull();
    expect(input.classList.contains('ml-1.5')).toBe(true);
    await act(async () => root.unmount());
  });

  it('keeps the folder draft focused when Enter confirms an IME candidate', async () => {
    const { root, tree } = await mountFolderDraft('/notes');
    const createFolder = vi.spyOn(files, 'createFolder').mockResolvedValue(
      item('/notes/新建', 'folder'),
    );
    const input = host.querySelector<HTMLInputElement>('input')!;

    expect(document.activeElement).toBe(input);

      await act(async () => {
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        setInputValue(input, 'xin');
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'xin' }));
        dispatchInputKey(input, 'Enter', 229);
      });

      expect(host.querySelector('input')).toBe(input);
      expect(input.value).toBe('xin');
      expect(document.activeElement).toBe(input);
      expect(createFolder).not.toHaveBeenCalled();

      await act(async () => {
        setInputValue(input, '新建');
        input.dispatchEvent(new CompositionEvent('compositionend', {
          bubbles: true,
          data: '新建',
        }));
      });

      expect(host.querySelector('input')).toBe(input);
      expect(input.value).toBe('新建');
      expect(document.activeElement).toBe(input);
      expect(createFolder).not.toHaveBeenCalled();

    await act(async () => {
      const event = dispatchInputKey(input, 'Enter', 13);
      expect(event.defaultPrevented).toBe(true);
      await Promise.resolve();
    });

    expect(createFolder).toHaveBeenCalledWith('/notes', '新建');
    expect(tree.refresh).toHaveBeenCalledWith('/notes');
    expect(host.querySelector('input')).toBeNull();
    await act(async () => root.unmount());
  });

  it('shows the folder target before release and moves the note on release', async () => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const { root, refresh } = await mount(onMoveNote);
    const noteRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="note"]')!;
    const folderRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="folder"]')!;
    const folderGroup = folderRow.closest<HTMLElement>('.folder-file-tree__group')!;
    expect(noteRow.classList.contains('folder-file-tree__item')).toBe(true);
    expect(folderRow.classList.contains('folder-file-tree__item')).toBe(true);
    expect(noteRow.querySelector('button[aria-label="memo.fileTree.moreActions"]')).not.toBeNull();
    expect(folderRow.querySelector('button[aria-label="memo.fileTree.moreActions"]')).not.toBeNull();
    vi.mocked(document.elementFromPoint).mockReturnValue(folderRow);

    await act(async () => noteRow.dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    expect(HTMLElement.prototype.setPointerCapture).toHaveBeenCalledWith(7);
    await act(async () => noteRow.dispatchEvent(pointerEvent('pointermove', 20, 10)));
    expect(folderRow.className).not.toContain('bg-[color-mix(in_oklch,var(--brand)_15%,transparent)]');
    expect(folderGroup.dataset.dragOver).toBe('true');
    expect(host.textContent).not.toContain('memo.fileTree.dropToMove');
    await act(async () => noteRow.dispatchEvent(pointerEvent('pointerup', 20, 10)));

    await vi.waitFor(() => expect(onMoveNote).toHaveBeenCalledWith([moveSource('/notes/a.md')], '/notes/projects'));
    expect(refresh).toHaveBeenCalledWith('/notes');
    expect(refresh).toHaveBeenCalledWith('/notes/projects');
    await act(async () => root.unmount());
  });

  it('renders the drag preview under the pointer', async () => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const { root } = await mount(onMoveNote);
    const noteRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="note"]')!;
    const folderRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="folder"]')!;
    vi.mocked(document.elementFromPoint).mockReturnValue(folderRow);

    await act(async () => noteRow.dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    await act(async () => noteRow.dispatchEvent(pointerEvent('pointermove', 20, 10)));

    const preview = host.querySelector<HTMLElement>('.fixed.left-0.top-0');
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toContain('a');
    expect(preview?.style.transform).toBe('translate3d(32px, 22px, 0)');

    await act(async () => noteRow.dispatchEvent(pointerEvent('pointercancel', 20, 10)));
    await act(async () => root.unmount());
  });

  it('auto-expands a collapsed folder after a sustained drag hover', async () => {
    vi.useFakeTimers();
    const { root, tree } = await mount(successfulMove);
    const noteRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="note"]')!;
    const folderRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="folder"]')!;
    vi.mocked(document.elementFromPoint).mockReturnValue(folderRow);

    await act(async () => noteRow.dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    await act(async () => noteRow.dispatchEvent(pointerEvent('pointermove', 20, 10)));
    expect(folderRow.closest<HTMLElement>('.folder-file-tree__group')?.dataset.dragOver).toBe('true');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await act(async () => { vi.advanceTimersByTime(650); });

    expect(tree.toggle).toHaveBeenCalledWith('/notes/projects');
    await act(async () => noteRow.dispatchEvent(pointerEvent('pointercancel', 20, 10)));
    await act(async () => root.unmount());
  });

  it('auto-scrolls the virtual viewport while dragging near its lower edge', async () => {
    const { root } = await mount(successfulMove);
    const noteRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="note"]')!;
    const folderRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="folder"]')!;
    const scroller = host.querySelector<HTMLElement>('[data-test-tree-scroller="true"]')!;
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 240,
      bottom: 204,
      left: 0,
      width: 240,
      height: 204,
      toJSON: () => ({}),
    });
    vi.mocked(document.elementFromPoint).mockReturnValue(folderRow);

    await act(async () => noteRow.dispatchEvent(pointerEvent('pointerdown', 10, 180)));
    await act(async () => {
      noteRow.dispatchEvent(pointerEvent('pointermove', 20, 200));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    expect(scroller.scrollTop).toBeGreaterThan(0);
    await act(async () => noteRow.dispatchEvent(pointerEvent('pointercancel', 20, 200)));
    await act(async () => root.unmount());
  });

  it('prefers the nested folder target over the root target', async () => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const { root } = await mountNested(onMoveNote);
    const noteRows = host.querySelectorAll<HTMLElement>('[data-notebook-tree-kind="note"]');
    const childNoteRow = noteRows[0];
    const rootNoteRow = noteRows[1];
    const folderGroup = host.querySelector<HTMLElement>('.folder-file-tree__group')!;
    const treeRoot = host.querySelector<HTMLElement>('[data-notebook-tree-root="true"]')!;
    vi.mocked(document.elementFromPoint).mockReturnValue(childNoteRow);

    await act(async () => rootNoteRow.dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    await act(async () => rootNoteRow.dispatchEvent(pointerEvent('pointermove', 20, 10)));

    expect(folderGroup.dataset.dragOver).toBe('true');
    expect(treeRoot.className).not.toContain('bg-[color-mix(in_oklch,var(--brand)_10%,transparent)]');
    expect(childNoteRow.hasAttribute('data-notebook-drop-path')).toBe(false);
    const dropRange = host.querySelector<HTMLElement>('.notebook-file-tree__drop-range')!;
    expect(dropRange.style.top).toBe('0px');
    expect(dropRange.style.height).toBe('66px');

    await act(async () => rootNoteRow.dispatchEvent(pointerEvent('pointerup', 20, 10)));
    await vi.waitFor(() => expect(onMoveNote).toHaveBeenCalledWith([moveSource('/notes/root.md')], '/notes/projects'));
    await act(async () => root.unmount());
  });

  it('uses the parent folder when the pointer is over a child note', async () => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const { root } = await mountNested(onMoveNote);
    const noteRows = host.querySelectorAll<HTMLElement>('[data-notebook-tree-kind="note"]');
    const childNoteRow = noteRows[0];
    const rootNoteRow = noteRows[1];
    const folderGroup = host.querySelector<HTMLElement>('.folder-file-tree__group')!;
    vi.mocked(document.elementFromPoint).mockReturnValue(childNoteRow);

    await act(async () => rootNoteRow.dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    await act(async () => rootNoteRow.dispatchEvent(pointerEvent('pointermove', 20, 10)));

    expect(childNoteRow.hasAttribute('data-notebook-drop-path')).toBe(false);
    expect(folderGroup.dataset.dragOver).toBe('true');

    await act(async () => rootNoteRow.dispatchEvent(pointerEvent('pointerup', 20, 10)));
    await vi.waitFor(() => expect(onMoveNote).toHaveBeenCalledWith([moveSource('/notes/root.md')], '/notes/projects'));
    await act(async () => root.unmount());
  });

  it('uses the parent folder when an external file is over a child note', async () => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const { root } = await mountNested(onMoveNote);
    const childNoteRow = host.querySelectorAll<HTMLElement>('[data-notebook-tree-kind="note"]')[0];
    const folderGroup = host.querySelector<HTMLElement>('.folder-file-tree__group')!;
    vi.mocked(document.elementFromPoint).mockReturnValue(childNoteRow);

    await act(async () => {
      childNoteRow.dispatchEvent(new CustomEvent(EXTERNAL_FILE_DROP_EVENT, {
        bubbles: true,
        detail: {
          type: 'over',
          paths: ['/external/image.png'],
        },
      }));
    });
    expect(childNoteRow.hasAttribute('data-notebook-drop-path')).toBe(false);
    expect(folderGroup.dataset.dragOver).toBe('true');

    await act(async () => {
      childNoteRow.dispatchEvent(new CustomEvent(EXTERNAL_FILE_DROP_EVENT, {
        bubbles: true,
        detail: {
          type: 'drop',
          paths: ['/external/image.png'],
        },
      }));
    });
    await vi.waitFor(() => expect(onMoveNote).toHaveBeenCalledWith(
      [{ path: '/external/image.png', resourceKind: 'image' }],
      '/notes/projects',
    ));
    await act(async () => root.unmount());
  });

  it('accepts an external file across the whole file-tree panel', async () => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const { root } = await mount(onMoveNote);
    const dropSurface = host.querySelector<HTMLElement>('[data-notebook-external-drop-target="true"]')!;
    const treeRoot = host.querySelector<HTMLElement>('[data-notebook-tree-root="true"]')!;
    vi.mocked(document.elementFromPoint).mockReturnValue(dropSurface);

    await act(async () => {
      dropSurface.dispatchEvent(new CustomEvent(EXTERNAL_FILE_DROP_EVENT, {
        detail: {
          type: 'over',
          paths: ['/external/note.md'],
        },
      }));
    });
    expect(treeRoot.className).toContain('bg-[color-mix(in_oklch,var(--brand)_10%,transparent)]');

    await act(async () => {
      dropSurface.dispatchEvent(new CustomEvent(EXTERNAL_FILE_DROP_EVENT, {
        detail: {
          type: 'drop',
          paths: ['/external/note.md'],
        },
      }));
    });
    await vi.waitFor(() => expect(onMoveNote).toHaveBeenCalledWith(
      [{ path: '/external/note.md', resourceKind: 'note' }],
      '/notes',
    ));
    await act(async () => root.unmount());
  });

  it('does not show a target or move a note when it is already in root', async () => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const { root } = await mount(onMoveNote);
    const noteRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="note"]')!;
    const treeRoot = host.querySelector<HTMLElement>('[data-notebook-tree-root="true"]')!;
    vi.mocked(document.elementFromPoint).mockReturnValue(noteRow);

    await act(async () => noteRow.dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    await act(async () => noteRow.dispatchEvent(pointerEvent('pointermove', 20, 10)));
    await act(async () => noteRow.dispatchEvent(pointerEvent('pointerup', 20, 10)));

    expect(treeRoot.className).not.toContain('bg-[color-mix(in_oklch,var(--brand)_10%,transparent)]');
    expect(onMoveNote).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('does not show a target or move a note when it is already in the same folder', async () => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const { root } = await mountNested(onMoveNote);
    const childNoteRow = host.querySelectorAll<HTMLElement>('[data-notebook-tree-kind="note"]')[0];
    const folderGroup = host.querySelector<HTMLElement>('.folder-file-tree__group')!;
    vi.mocked(document.elementFromPoint).mockReturnValue(childNoteRow);

    await act(async () => childNoteRow.dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    await act(async () => childNoteRow.dispatchEvent(pointerEvent('pointermove', 20, 10)));
    await act(async () => childNoteRow.dispatchEvent(pointerEvent('pointerup', 20, 10)));

    expect(folderGroup.dataset.dragOver).toBe('false');
    expect(onMoveNote).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('keeps root as a valid target when moving a note out of a folder', async () => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const { root } = await mountNested(onMoveNote);
    const childNoteRow = host.querySelectorAll<HTMLElement>('[data-notebook-tree-kind="note"]')[0];
    const treeRoot = host.querySelector<HTMLElement>('[data-notebook-tree-root="true"]')!;
    vi.mocked(document.elementFromPoint).mockReturnValue(treeRoot);

    await act(async () => childNoteRow.dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    await act(async () => childNoteRow.dispatchEvent(pointerEvent('pointermove', 20, 10)));

    expect(treeRoot.className).toContain('bg-[color-mix(in_oklch,var(--brand)_10%,transparent)]');
    await act(async () => childNoteRow.dispatchEvent(pointerEvent('pointerup', 20, 10)));
    await vi.waitFor(() => expect(onMoveNote).toHaveBeenCalledWith([moveSource('/notes/projects/child.md')], '/notes'));
    await act(async () => root.unmount());
  });

  it.each(['false', 'throw', 'success'] as const)('retains only failed batch deletions (%s)', async (outcome) => {
    const { root, tree } = await mountFlatNotes(successfulMove);
    const documents = ['a', 'b', 'c'].map(name => item(`/notes/${name}.txt`, 'document'));
    const onDeleteFile = vi.fn(async (document: DocTreeItem) => {
      if (document.fullPath.endsWith('b.txt') && outcome !== 'success') {
        if (outcome === 'throw') throw new Error('permission denied');
        return false;
      }
      return true;
    });
    await act(async () => root.render(
      <NotebookFileTree notebookPath="/notes" notebookName="Notes"
        tree={{ ...tree, rootChildren: documents }} onNoteSelect={vi.fn()}
        onCreateNote={vi.fn()} onMoveNote={successfulMove} onDeleteFile={onDeleteFile} />,
    ));
    const rows = host.querySelectorAll<HTMLElement>('[data-notebook-tree-path$=".txt"]');
    await act(async () => rows[0].dispatchEvent(clickEvent()));
    await act(async () => rows[2].dispatchEvent(clickEvent({ shiftKey: true })));
    const menu = host.querySelector('[role="menu"]')!;
    const deleteAction = Array.from(menu.children).find(child => child.textContent === 'memo.fileTree.delete')!;
    await act(async () => deleteAction.dispatchEvent(clickEvent()));
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'memo.fileTree.delete')!;
    expect(confirm).toBeDefined();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
    await act(async () => confirm.click());
    expect(onDeleteFile.mock.calls.map(([document]) => document.fullPath)).toEqual(documents.map(document => document.fullPath));
    expect(onDeleteFile).toHaveBeenCalledWith(documents[0], { silent: true });
    const selected = Array.from(host.querySelectorAll<HTMLElement>('[data-notebook-tree-path$=".txt"][aria-selected="true"]'));
    expect(selected.map(row => row.dataset.notebookTreePath)).toEqual(outcome === 'success' ? [] : ['/notes/b.txt']);
    expect(outcome === 'success' ? toast.success : toast.error).toHaveBeenCalledWith('memo.fileTree.deleteSelectedResult');
    expect(outcome === 'success' ? toast.error : toast.success).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it.each([
    { ctrlKey: true }, { metaKey: true }, { shiftKey: true },
  ])('includes media libraries in multi-selection (%o)', async (modifiers) => {
    vi.spyOn(files, 'listTableDocuments').mockResolvedValue([]);
    vi.spyOn(collections, 'list').mockResolvedValue([]);
    vi.spyOn(files, 'listMediaLibraries').mockResolvedValue([{
      relativePath: 'library.lib.yaml', collectionId: 'media-1', name: 'Library',
      modifiedMs: 1, inViews: false,
    }]);
    const openSurface = vi.spyOn(openSurfaceApi, 'openWorkspaceSurface').mockResolvedValue({ status: 'cancelled', host: 'column-1', reason: 'navigation-cancelled' });
    const { root, tree } = await mountFlatNotes(successfulMove);
    const first = item('/notes/a.md', 'document');
    const library = item('/notes/library.lib.yaml', 'document');
    const onNoteSelect = vi.fn();
    try {
      await act(async () => root.render(
        <NotebookFileTree notebookId="notebook-1" notebookPath="/notes" notebookName="Notes"
          tree={{ ...tree, rootChildren: [first, library] }} activeFilePath={first.fullPath} onNoteSelect={onNoteSelect}
          onCreateNote={vi.fn()} onMoveNote={successfulMove} />,
      ));
      const rows = host.querySelectorAll<HTMLElement>('[data-notebook-tree-path]');
      const noteRow = Array.from(rows).find(row => row.dataset.notebookTreePath === first.fullPath)!;
      const libraryRow = Array.from(rows).find(row => row.dataset.notebookTreePath === library.fullPath)!;
      await act(async () => noteRow.dispatchEvent(clickEvent()));
      await act(async () => libraryRow.dispatchEvent(clickEvent(modifiers)));
      expect(useNotebookTreeSelectionStore.getState().paths).toEqual([first.fullPath, library.fullPath]);
      expect(libraryRow.getAttribute('aria-selected')).toBe('true');
      expect(useNotebookTreeSelectionStore.getState().contentKinds.get(library.fullPath)).toBe('media-library');
      expect(openSurface).not.toHaveBeenCalled();
      expect(onNoteSelect).toHaveBeenCalledTimes(1);
      if (!modifiers.shiftKey) {
        await act(async () => libraryRow.dispatchEvent(clickEvent(modifiers)));
        expect(useNotebookTreeSelectionStore.getState().paths).toEqual([first.fullPath]);
      }
      // A normal media-library click sets the anchor for the next Shift range.
      await act(async () => libraryRow.dispatchEvent(clickEvent()));
      expect(openSurface).toHaveBeenCalledTimes(1);
      expect(useNotebookTreeSelectionStore.getState().paths).toEqual([library.fullPath]);
      await act(async () => noteRow.dispatchEvent(clickEvent({ shiftKey: true })));
      expect(useNotebookTreeSelectionStore.getState().paths).toEqual([first.fullPath, library.fullPath]);
      expect(onNoteSelect).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('keeps only deletion in the multi-selection menu without clipboard entries', async () => {
    const { root } = await mountFlatNotes(successfulMove);
    const rows = host.querySelectorAll<HTMLElement>('[data-notebook-tree-kind="note"]');
    await act(async () => rows[0].dispatchEvent(clickEvent()));
    await act(async () => rows[2].dispatchEvent(clickEvent({ shiftKey: true })));
    await act(async () => rows[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })));
    const menus = Array.from(host.querySelectorAll('[role="menu"]'));
    expect(menus.filter(menu => menu.textContent === 'memo.fileTree.delete')).toHaveLength(3);
    expect(useNotebookTreeSelectionStore.getState().paths).toEqual(Array.from(rows).slice(0, 3).map(row => row.dataset.notebookTreePath));
    await act(async () => root.unmount());
  });

  it('keeps the original range anchor across repeated Shift clicks', async () => {
    const { root } = await mountFlatNotes(successfulMove);
    const rows = host.querySelectorAll<HTMLElement>('[data-notebook-tree-kind="note"]');
    await act(async () => rows[0].dispatchEvent(clickEvent()));
    await act(async () => rows[2].dispatchEvent(clickEvent({ shiftKey: true })));
    await act(async () => rows[1].dispatchEvent(clickEvent({ shiftKey: true })));
    expect(Array.from(rows).map(row => row.getAttribute('aria-selected'))).toEqual(['true', 'true', 'false', 'false']);
    await act(async () => root.unmount());
  });

  it('selects and drags a range from the pinned list', async () => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const { root, tree } = await mount(onMoveNote);
    vi.mocked(pinnedEntries.list).mockResolvedValueOnce({
      entries: ['a', 'b', 'c'].map(name => pinnedNote(`pinned/${name}.md`, name)),
      nextCursor: null, hasMore: false,
    });
    const render = (activeFilePath?: string) => root.render(
      <NotebookFileTree notebookId="notebook-1" notebookPath="/notes" notebookName="Notes" tree={tree}
        activeFilePath={activeFilePath} onNoteSelect={vi.fn()} onCreateNote={vi.fn()} onMoveNote={onMoveNote} />,
    );
    await act(async () => render());
    const rows = host.querySelectorAll<HTMLElement>('[data-notebook-tree-path^="/notes/pinned/"]');
    expect(rows).toHaveLength(3);
    await act(async () => rows[0].dispatchEvent(clickEvent()));
    await act(async () => render('/notes/pinned/a.md'));
    await act(async () => rows[2].dispatchEvent(clickEvent({ shiftKey: true })));
    expect(Array.from(rows).every(row => row.getAttribute('aria-selected') === 'true')).toBe(true);
    const folder = host.querySelector<HTMLElement>('[data-notebook-tree-kind="folder"]')!;
    vi.mocked(document.elementFromPoint).mockReturnValue(folder);
    await act(async () => rows[1].dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    await act(async () => rows[1].dispatchEvent(pointerEvent('pointermove', 20, 10)));
    await act(async () => rows[1].dispatchEvent(pointerEvent('pointerup', 20, 10)));
    await vi.waitFor(() => expect(onMoveNote).toHaveBeenCalledWith(
      ['a', 'b', 'c'].map(name => ({ path: `/notes/pinned/${name}.md`, resourceKind: 'note' })), '/notes/projects',
    ));
    await act(async () => root.unmount());
  });

  it('selects a visible range with Shift and drags all selected notes', async () => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const { root, tree, onNoteSelect } = await mountFlatNotes(onMoveNote);
    const noteRows = host.querySelectorAll<HTMLElement>('[data-notebook-tree-kind="note"]');
    const folderRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="folder"]')!;
    vi.mocked(document.elementFromPoint).mockReturnValue(folderRow);

    await act(async () => noteRows[0].dispatchEvent(clickEvent()));
    await act(async () => noteRows[2].dispatchEvent(clickEvent({ shiftKey: true })));
    onNoteSelect.mockClear();

    expect(Array.from(noteRows).map((row) => row.getAttribute('aria-selected'))).toEqual([
      'true', 'true', 'true', 'false',
    ]);
    expect(noteRows[1].className).toContain('bg-[var(--muted)]');
    expect(noteRows[1].className).not.toContain('bg-[color-mix(in_oklch,var(--brand)_12%,transparent)]');

    await act(async () => noteRows[1].dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    await act(async () => noteRows[1].dispatchEvent(pointerEvent('pointermove', 20, 10)));
    await act(async () => {
      noteRows[1].dispatchEvent(pointerEvent('pointerup', 20, 10));
      // This models the browser's click generated immediately after pointerup.
      // A multi-drag must suppress it for every selected source row.
      noteRows[0].dispatchEvent(clickEvent());
    });

    await vi.waitFor(() => expect(onMoveNote).toHaveBeenCalledWith(
      [moveSource('/notes/a.md'), moveSource('/notes/b.md'), moveSource('/notes/c.md')],
      '/notes/projects',
    ));
    expect(onNoteSelect).not.toHaveBeenCalled();
    expect(tree.refresh).toHaveBeenCalledWith('/notes');
    expect(tree.refresh).toHaveBeenCalledWith('/notes/projects');
    await act(async () => root.unmount());
  });

  it('keeps the moved notes selected in their new folder', async () => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const { root, tree, rerender } = await mountFlatNotes(onMoveNote);
    const noteRows = host.querySelectorAll<HTMLElement>('[data-notebook-tree-kind="note"]');
    const folderRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="folder"]')!;
    const folder = tree.rootChildren.find((item) => item.type === 'folder')!;

    await act(async () => noteRows[0].dispatchEvent(clickEvent()));
    await act(async () => noteRows[2].dispatchEvent(clickEvent({ shiftKey: true })));
    onMoveNote.mockImplementation(async (sourcePaths, targetPath) => {
      tree.rootChildren = tree.rootChildren.filter((item) => item.type === 'folder');
      tree.nodes.set(folder.fullPath, {
        ...folder,
        children: sourcePaths.map((source) => item(
          `${targetPath}/${source.path.slice(source.path.lastIndexOf('/') + 1)}`,
          'document',
        )),
      });
      return {
        movedPaths: sourcePaths.map((source) => (
          `${targetPath}/${source.path.slice(source.path.lastIndexOf('/') + 1)}`
        )),
        failedPaths: [],
      };
    });
    vi.mocked(document.elementFromPoint).mockReturnValue(folderRow);

    await act(async () => noteRows[1].dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    await act(async () => noteRows[1].dispatchEvent(pointerEvent('pointermove', 20, 10)));
    await act(async () => noteRows[1].dispatchEvent(pointerEvent('pointerup', 20, 10)));

    await vi.waitFor(() => expect(onMoveNote).toHaveBeenCalled());
    await rerender();

    await vi.waitFor(() => {
      const selectedRows = host.querySelectorAll<HTMLElement>(
        '[data-notebook-tree-kind="note"][aria-selected="true"]',
      );
      expect(Array.from(selectedRows).map((row) => row.title)).toEqual([
        '/notes/projects/a.md',
        '/notes/projects/b.md',
        '/notes/projects/c.md',
      ]);
    });
    await act(async () => root.unmount());
  });

  it('keeps moved and failed notes selected and reports partial failures', async () => {
    vi.mocked(toast.error).mockClear();
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const { root, tree, rerender } = await mountFlatNotes(onMoveNote);
    const noteRows = host.querySelectorAll<HTMLElement>('[data-notebook-tree-kind="note"]');
    const folderRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="folder"]')!;
    const folder = tree.rootChildren.find((item) => item.type === 'folder')!;

    await act(async () => noteRows[0].dispatchEvent(clickEvent()));
    await act(async () => noteRows[2].dispatchEvent(clickEvent({ shiftKey: true })));
    onMoveNote.mockImplementation(async () => {
      const movedNote = item('/notes/projects/a.md', 'document');
      tree.rootChildren = [folder, item('/notes/b.md', 'document'), item('/notes/c.md', 'document')];
      tree.nodes.set(folder.fullPath, { ...folder, children: [movedNote] });
      return {
        movedPaths: ['/notes/projects/a.md'],
        failedPaths: ['/notes/b.md', '/notes/c.md'],
      };
    });
    vi.mocked(document.elementFromPoint).mockReturnValue(folderRow);

    await act(async () => noteRows[1].dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    await act(async () => noteRows[1].dispatchEvent(pointerEvent('pointermove', 20, 10)));
    await act(async () => noteRows[1].dispatchEvent(pointerEvent('pointerup', 20, 10)));

    await vi.waitFor(() => expect(onMoveNote).toHaveBeenCalled());
    await rerender();

    await vi.waitFor(() => {
      const selectedRows = host.querySelectorAll<HTMLElement>(
        '[data-notebook-tree-kind="note"][aria-selected="true"]',
      );
      expect(Array.from(selectedRows).map((row) => row.title)).toEqual([
        '/notes/projects/a.md',
        '/notes/b.md',
        '/notes/c.md',
      ]);
    });
    expect(toast.error).toHaveBeenCalledWith('memo.fileTree.movePartialFailed');
    await act(async () => root.unmount());
  });

  it.each([
    { name: 'Ctrl', modifiers: { ctrlKey: true } },
    { name: 'Cmd', modifiers: { metaKey: true } },
  ])('selects non-contiguous notes with $name and drags them together', async ({ modifiers }) => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const { root } = await mountFlatNotes(onMoveNote);
    const noteRows = host.querySelectorAll<HTMLElement>('[data-notebook-tree-kind="note"]');
    const folderRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="folder"]')!;
    vi.mocked(document.elementFromPoint).mockReturnValue(folderRow);

    await act(async () => noteRows[0].dispatchEvent(clickEvent()));
    await act(async () => noteRows[2].dispatchEvent(clickEvent(modifiers)));

    expect(Array.from(noteRows).map((row) => row.getAttribute('aria-selected'))).toEqual([
      'true', 'false', 'true', 'false',
    ]);

    await act(async () => noteRows[2].dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    await act(async () => noteRows[2].dispatchEvent(pointerEvent('pointermove', 20, 10)));
    await act(async () => noteRows[2].dispatchEvent(pointerEvent('pointerup', 20, 10)));

    await vi.waitFor(() => expect(onMoveNote).toHaveBeenCalledWith(
      [moveSource('/notes/a.md'), moveSource('/notes/c.md')],
      '/notes/projects',
    ));
    await act(async () => root.unmount());
  });

  it('does not move a note when the pointer never crosses the drag threshold', async () => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const { root } = await mount(onMoveNote);
    const noteRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="note"]')!;
    const folderRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="folder"]')!;
    vi.mocked(document.elementFromPoint).mockReturnValue(folderRow);

    await act(async () => noteRow.dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    await act(async () => noteRow.dispatchEvent(pointerEvent('pointermove', 12, 11)));
    await act(async () => noteRow.dispatchEvent(pointerEvent('pointerup', 12, 11)));
    expect(onMoveNote).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('does not select or open an unselected note when a drag is abandoned', async () => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const { root, onNoteSelect } = await mountFlatNotes(onMoveNote);
    const noteRows = host.querySelectorAll<HTMLElement>('[data-notebook-tree-kind="note"]');
    vi.mocked(document.elementFromPoint).mockReturnValue(document.body);

    await act(async () => noteRows[1].dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    await act(async () => noteRows[1].dispatchEvent(pointerEvent('pointermove', 20, 10)));
    await act(async () => {
      noteRows[1].dispatchEvent(pointerEvent('pointerup', 20, 10));
      noteRows[1].dispatchEvent(clickEvent());
    });

    expect(onMoveNote).not.toHaveBeenCalled();
    expect(onNoteSelect).not.toHaveBeenCalled();
    expect(Array.from(noteRows).map((row) => row.getAttribute('aria-selected'))).toEqual([
      'false', 'false', 'false', 'false',
    ]);
    await act(async () => root.unmount());
  });

  it('does not select an unselected note after a successful drag', async () => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const { root, onNoteSelect } = await mountFlatNotes(onMoveNote);
    const noteRows = host.querySelectorAll<HTMLElement>('[data-notebook-tree-kind="note"]');
    const folderRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="folder"]')!;
    vi.mocked(document.elementFromPoint).mockReturnValue(folderRow);

    await act(async () => noteRows[1].dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    await act(async () => noteRows[1].dispatchEvent(pointerEvent('pointermove', 20, 10)));
    await act(async () => {
      noteRows[1].dispatchEvent(pointerEvent('pointerup', 20, 10));
      noteRows[1].dispatchEvent(clickEvent());
    });

    await vi.waitFor(() => expect(onMoveNote).toHaveBeenCalled());
    expect(onNoteSelect).not.toHaveBeenCalled();
    expect(Array.from(noteRows).map((row) => row.getAttribute('aria-selected'))).toEqual([
      'false', 'false', 'false', 'false',
    ]);
    await act(async () => root.unmount());
  });

  it('supports keyboard navigation across visible tree items', async () => {
    const { root } = await mountFlatNotes(successfulMove);
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const folderRow = rows[0];
    const firstNoteRow = rows[1];
    const lastNoteRow = rows[rows.length - 1];

    expect(rows.filter((row) => row.tabIndex === 0)).toEqual([folderRow]);
    folderRow.focus();
    await act(async () => folderRow.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowDown', bubbles: true, cancelable: true,
    })));
    expect(document.activeElement).toBe(firstNoteRow);

    await act(async () => firstNoteRow.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'End', bubbles: true, cancelable: true,
    })));
    expect(document.activeElement).toBe(lastNoteRow);

    await act(async () => lastNoteRow.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Home', bubbles: true, cancelable: true,
    })));
    expect(document.activeElement).toBe(folderRow);
    await act(async () => root.unmount());
  });

  it('uses folder navigation keys for expanded nested trees', async () => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const { root, tree } = await mountNested(onMoveNote);
    const folderRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="folder"]')!;
    const childNoteRow = host.querySelectorAll<HTMLElement>('[data-notebook-tree-kind="note"]')[0];

    folderRow.focus();
    await act(async () => folderRow.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight', bubbles: true, cancelable: true,
    })));
    expect(document.activeElement).toBe(childNoteRow);

    await act(async () => childNoteRow.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowLeft', bubbles: true, cancelable: true,
    })));
    expect(document.activeElement).toBe(folderRow);

    await act(async () => folderRow.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowLeft', bubbles: true, cancelable: true,
    })));
    expect(tree.toggle).toHaveBeenCalledWith('/notes/projects');
    await act(async () => root.unmount());
  });

  it('cancels the move when the pointer is released outside the tree', async () => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const { root } = await mount(onMoveNote);
    const noteRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="note"]')!;
    vi.mocked(document.elementFromPoint).mockReturnValue(document.body);

    await act(async () => noteRow.dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    await act(async () => noteRow.dispatchEvent(pointerEvent('pointermove', 20, 10)));
    await act(async () => noteRow.dispatchEvent(pointerEvent('pointerup', 20, 10)));

    expect(onMoveNote).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('bounds mounted rows for a large mixed file tree and updates the window on scroll', async () => {
    const rootChildren = Array.from({ length: 500 }, (_, index) => ({
      ...item(`/notes/item-${String(index).padStart(3, '0')}.md`, 'document'),
      resourceKind: index % 3 === 0 ? 'image' as const : index % 3 === 1 ? 'video' as const : 'note' as const,
    }));
    const tree = {
      rootChildren,
      nodes: new Map(rootChildren.map((child) => [child.fullPath, child])),
      expanded: new Set<string>(),
      loading: false,
      error: null,
      toggle: vi.fn(),
      expandTo: vi.fn(async () => {}),
      collapseAll: vi.fn(),
      refresh: vi.fn(async () => {}),
      refreshDirectories: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
    } as unknown as FolderTreeController;
    const root = createRoot(host);

    await act(async () => root.render(
      <NotebookFileTree notebookPath="/notes" notebookName="Notes" tree={tree}
        onNoteSelect={vi.fn()} onCreateNote={vi.fn()} onMoveNote={successfulMove} />,
    ));
    await vi.waitFor(() => {
      expect(host.querySelectorAll('[data-notebook-virtual-row]').length).toBeLessThan(80);
    });
    expect(host.querySelector('[title="/notes/item-000.md"]')).not.toBeNull();
    expect(host.querySelector('[title="/notes/item-300.md"]')).toBeNull();

    const scroller = host.querySelector<HTMLElement>('[data-test-tree-scroller="true"]')!;
    await act(async () => {
      scroller.scrollTop = 300 * 34;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[title="/notes/item-300.md"]')).not.toBeNull();
    });
    // Keep upcoming rows mounted before another ~680px touchpad scroll arrives.
    expect(host.querySelector('[title="/notes/item-280.md"]')).not.toBeNull();
    expect(host.querySelector('[title="/notes/item-320.md"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-notebook-virtual-row]').length).toBeLessThan(80);
    expect(host.querySelector('[title="/notes/item-000.md"]')).not.toBeNull();

    // Exercise consecutive bursts and a direction change without waiting a frame.
    for (const index of [320, 300, 280]) {
      expect(host.querySelector(`[title="/notes/item-${index}.md"]`)).not.toBeNull();
      await act(async () => {
        scroller.scrollTop = index * 34;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      expect(host.querySelector(`[title="/notes/item-${index - 20}.md"]`)).not.toBeNull();
      expect(host.querySelector(`[title="/notes/item-${index + 20}.md"]`)).not.toBeNull();
      expect(host.querySelectorAll('[data-notebook-virtual-row]').length).toBeLessThan(80);
    }

    await act(async () => root.unmount());
  }, 15_000);
});
