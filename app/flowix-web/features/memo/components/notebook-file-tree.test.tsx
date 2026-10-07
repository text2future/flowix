import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { files, memos, type DocTreeItem } from '@platform/tauri/client';
import { toast } from '@/lib/toast';
import { EXTERNAL_FILE_DROP_EVENT } from '@features/document/components/use-markdown-file-drop';
import type { FolderTreeController } from './use-folder-tree';
import {
  NotebookFileTree,
  type NotebookMoveResult,
  type NotebookMoveSource,
} from './notebook-file-tree';

const repositoryTreeTestState = vi.hoisted(() => ({ loadComplete: false }));

vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
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
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuSeparator: () => <hr />,
  useContextMenuContext: () => ({ openAt: vi.fn() }),
}));
vi.mock('@features/memo/components/file-type-icon', () => ({
  FileTypeIcon: () => null,
  NotebookTreeResourceIcon: () => null,
}));
vi.mock('@features/memo/components/memo-card-actions', () => ({ MemoCardActions: () => null }));
vi.mock('@features/memo/services/note-repository', () => ({ noteRepository: { listByPath: vi.fn(async () => ({ notes: [] })) } }));
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

  it('selects a folder on single click and toggles it on double click', async () => {
    const onFolderSelect = vi.fn();
    const { root, tree } = await mount(successfulMove, undefined, onFolderSelect);
    const folderRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="folder"]')!;
    vi.useFakeTimers();

    await act(async () => folderRow.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    expect(onFolderSelect).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(220));
    expect(onFolderSelect).toHaveBeenCalledWith('/notes/projects');
    expect(tree.toggle).not.toHaveBeenCalled();

    onFolderSelect.mockClear();
    await act(async () => {
      folderRow.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      folderRow.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
      folderRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
      vi.advanceTimersByTime(220);
    });
    expect(onFolderSelect).not.toHaveBeenCalled();
    expect(tree.toggle).toHaveBeenCalledWith('/notes/projects');
    await act(async () => root.unmount());
  });

  it('scrolls an expanded repository to the top of the tree viewport after it renders', async () => {
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
      if (this.contains(repositoryButton)) return new DOMRect(0, 330, 300, 50);
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

    expect(scroller.scrollTop).toBe(244);
    await act(async () => root.unmount());
  });

  it('renders view items with the same more and context menu actions as access-space items', async () => {
    vi.spyOn(files, 'listTableDocuments').mockResolvedValue([{
      relativePath: 'views/Project.table.yml',
      collectionId: 'tbl_project',
      name: 'Project',
      modifiedMs: 1_700_000_000_000,
      fileRevision: 1,
      inViews: true,
    }]);
    const tree = {
      rootChildren: [],
      nodes: new Map(),
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
      <NotebookFileTree
        notebookId="notebook-1"
        notebookPath="/notes"
        notebookName="Notes"
        tree={tree}
        onNoteSelect={vi.fn()}
        onCreateNote={vi.fn()}
        onMoveNote={successfulMove}
      />,
    ));

    await vi.waitFor(() => expect(host.querySelector('[data-notebook-tree-kind="other"]')).not.toBeNull());
    const viewRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="other"]')!;
    expect(viewRow.textContent).toContain('Project');
    expect(viewRow.querySelector('button[aria-label="memo.fileTree.moreActions"]')).not.toBeNull();
    expect(host.textContent).toContain('memo.fileTree.newNote');
    expect(host.textContent).toContain('memo.fileTree.newFolder');
    expect(host.textContent).toContain('memo.fileTree.rename');
    expect(host.textContent).toContain('memo.fileTree.delete');
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
    const readMemo = vi.spyOn(memos, 'readMemo').mockResolvedValue(null);
    const { root } = await mount(successfulMove);

    expect(readMemo).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('renders note icon and colors from tree metadata without loading the full memo', async () => {
    const readMemo = vi.spyOn(memos, 'readMemo').mockResolvedValue(null);
    const note = {
      ...item('/notes/a.md', 'document'),
      memoMeta: {
        id: 'memo-1',
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
    expect(readMemo).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('does not pass memo ids with drag sources', async () => {
    const onMoveNote = vi.fn<TestMoveNote>(successfulMove);
    const note = {
      ...item('/notes/a.md', 'document'),
      memoMeta: {
        id: 'memo-1',
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

  async function mountDraft(kind: 'folder' | 'note', parentPath: string) {
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
    const onCreateNote = vi.fn(async () => {});
    await act(async () => root.render(
      <NotebookFileTree
        notebookPath="/notes/"
        notebookName="Notes"
        tree={tree}
        createFolderRequest={kind === 'folder' ? { id: 1, parentPath } : null}
        createNoteRequest={kind === 'note' ? { id: 1, parentPath } : null}
        onNoteSelect={vi.fn()}
        onCreateNote={onCreateNote}
        onMoveNote={vi.fn<TestMoveNote>(successfulMove)}
      />,
    ));
    return { root, onCreateNote, tree };
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

  it.each([
    ['folder', '/notes'],
    ['note', '/notes'],
    ['folder', '/notes/projects'],
    ['note', '/notes/projects'],
  ] as const)('places the %s draft before the first matching item in %s', async (kind, parentPath) => {
    const { root } = await mountDraft(kind, parentPath);
    const input = host.querySelector('input')!;
    const list = host.querySelector('[role="tree"]')!;
    const depth = parentPath === '/notes' ? 0 : 1;
    const rows = directRows(list, depth);
    const firstFolderIndex = rows.findIndex((row) => row.getAttribute('data-notebook-tree-kind') === 'folder');
    const firstNoteIndex = rows.findIndex((row) => row.getAttribute('data-notebook-tree-kind') === 'note');
    const firstMatchingRow = rows[kind === 'folder' ? firstFolderIndex : firstNoteIndex];
    const virtualRows = Array.from(host.querySelectorAll<HTMLElement>('[data-notebook-virtual-row]'));
    const draftVirtualRow = input.closest<HTMLElement>('[data-notebook-virtual-row]')!;
    const matchingVirtualRow = firstMatchingRow.closest<HTMLElement>('[data-notebook-virtual-row]')!;
    expect(virtualRows.indexOf(draftVirtualRow) + 1).toBe(virtualRows.indexOf(matchingVirtualRow));
    expect(input.parentElement?.style.marginLeft).toBe(
      parentPath === '/notes' ? '6px' : '26px',
    );
    if (kind === 'note') {
      const folderVirtualRow = rows[firstFolderIndex].closest<HTMLElement>('[data-notebook-virtual-row]')!;
      expect(virtualRows.indexOf(folderVirtualRow)).toBeLessThan(virtualRows.indexOf(draftVirtualRow));
    }
    await act(async () => root.unmount());
  });

  it.each(['note', 'folder'] as const)(
    'renders the matching %s icon beside the draft input',
    async (kind) => {
      const { root } = await mountDraft(kind, '/notes');
      const input = host.querySelector<HTMLInputElement>('input')!;
      const icon = host.querySelector<HTMLElement>(`[data-notebook-tree-draft-icon="${kind}"]`)!;

      expect(icon).not.toBeNull();
      expect(icon.nextElementSibling).toBe(input);
      expect(icon.querySelector('svg')).not.toBeNull();
      expect(input.classList.contains('ml-1.5')).toBe(true);
      await act(async () => root.unmount());
    },
  );

  it.each(['note', 'folder'] as const)(
    'keeps the new %s draft focused when Enter confirms an IME candidate',
    async (kind) => {
      const { root, onCreateNote, tree } = await mountDraft(kind, '/notes');
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
      expect(onCreateNote).not.toHaveBeenCalled();
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
      expect(onCreateNote).not.toHaveBeenCalled();
      expect(createFolder).not.toHaveBeenCalled();

      await act(async () => {
        const event = dispatchInputKey(input, 'Enter', 13);
        expect(event.defaultPrevented).toBe(true);
        await Promise.resolve();
      });

      if (kind === 'note') {
        expect(onCreateNote).toHaveBeenCalledWith('/notes', '新建');
        expect(createFolder).not.toHaveBeenCalled();
      } else {
        expect(createFolder).toHaveBeenCalledWith('/notes', '新建');
        expect(onCreateNote).not.toHaveBeenCalled();
      }
      expect(tree.refresh).toHaveBeenCalledWith('/notes');
      expect(host.querySelector('input')).toBeNull();
      await act(async () => root.unmount());
    },
  );

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
      window.dispatchEvent(new CustomEvent(EXTERNAL_FILE_DROP_EVENT, {
        detail: {
          type: 'over',
          paths: ['/external/image.png'],
          position: { x: 20, y: 20 },
        },
      }));
    });
    expect(childNoteRow.hasAttribute('data-notebook-drop-path')).toBe(false);
    expect(folderGroup.dataset.dragOver).toBe('true');

    await act(async () => {
      window.dispatchEvent(new CustomEvent(EXTERNAL_FILE_DROP_EVENT, {
        detail: {
          type: 'drop',
          paths: ['/external/image.png'],
          position: { x: 20, y: 20 },
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
      window.dispatchEvent(new CustomEvent(EXTERNAL_FILE_DROP_EVENT, {
        detail: {
          type: 'over',
          paths: ['/external/note.md'],
          position: { x: 20, y: 20 },
        },
      }));
    });
    expect(treeRoot.className).toContain('bg-[color-mix(in_oklch,var(--brand)_10%,transparent)]');

    await act(async () => {
      window.dispatchEvent(new CustomEvent(EXTERNAL_FILE_DROP_EVENT, {
        detail: {
          type: 'drop',
          paths: ['/external/note.md'],
          position: { x: 20, y: 20 },
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
      expect(host.querySelectorAll('[data-notebook-virtual-row]').length).toBeLessThan(40);
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
    expect(host.querySelectorAll('[data-notebook-virtual-row]').length).toBeLessThan(40);
    expect(host.querySelector('[title="/notes/item-000.md"]')).not.toBeNull();

    await act(async () => root.unmount());
  });
});
