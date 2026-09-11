import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocTreeItem } from '@platform/tauri/client';
import type { FolderTreeController } from './use-folder-tree';
import { NotebookFileTree } from './notebook-file-tree';

vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@shared/ui/overlay-scrollbar', () => ({
  OverlayScrollbar: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@shared/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@features/memo/components/file-type-icon', () => ({ FileTypeIcon: () => null }));
vi.mock('@features/memo/components/memo-card-actions', () => ({ MemoCardActions: () => null }));
vi.mock('@features/memo/services/memo-repository', () => ({ memoRepository: {} }));
vi.mock('@features/memo', () => ({ useMemoStore: { getState: vi.fn() } }));
vi.mock('@features/memo/use-cases/open-by-target', () => ({ resolveMemoByPath: vi.fn() }));

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

  beforeEach(() => {
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    captured = false;
    HTMLElement.prototype.setPointerCapture = vi.fn(() => { captured = true; });
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => captured);
    HTMLElement.prototype.releasePointerCapture = vi.fn(() => { captured = false; });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    host.remove();
    environment.IS_REACT_ACT_ENVIRONMENT = false;
    vi.restoreAllMocks();
  });

  async function mount(onMoveNote: (source: string, target: string) => Promise<void>) {
    const folder = item('/notes/projects', 'folder');
    const note = item('/notes/a.md', 'document');
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
      <NotebookFileTree notebookPath="/notes" notebookName="Notes" tree={tree}
        onNoteSelect={vi.fn()} onCreateNote={vi.fn()} onMoveNote={onMoveNote} />,
    ));
    return { root, refresh };
  }

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
    await act(async () => root.render(
      <NotebookFileTree
        notebookPath="/notes/"
        notebookName="Notes"
        tree={tree}
        createFolderRequest={kind === 'folder' ? { id: 1, parentPath } : null}
        createNoteRequest={kind === 'note' ? { id: 1, parentPath } : null}
        onNoteSelect={vi.fn()}
        onCreateNote={vi.fn()}
        onMoveNote={vi.fn(async () => {})}
      />,
    ));
    return { root };
  }

  function directRows(list: Element): Element[] {
    return Array.from(list.children).flatMap((child) => {
      if (child.hasAttribute('data-notebook-tree-kind')) return [child];
      if (child.classList.contains('folder-file-tree__group')) {
        return Array.from(child.children).filter((nested) => nested.hasAttribute('data-notebook-tree-kind'));
      }
      return [];
    });
  }

  it.each([
    ['folder', '/notes'],
    ['note', '/notes'],
    ['folder', '/notes/projects'],
    ['note', '/notes/projects'],
  ] as const)('places the %s draft before the first matching item in %s', async (kind, parentPath) => {
    const { root } = await mountDraft(kind, parentPath);
    const input = host.querySelector('input')!;
    const list = parentPath === '/notes'
      ? host.querySelector('[role="tree"]')!
      : input.closest('.folder-file-tree__subtree-items')!;
    const rows = directRows(list);
    const draftIndex = Array.from(list.children).indexOf(input.parentElement!);
    const firstFolderIndex = rows.findIndex((row) => row.getAttribute('data-notebook-tree-kind') === 'folder');
    const firstNoteIndex = rows.findIndex((row) => row.getAttribute('data-notebook-tree-kind') === 'note');
    const rowIndex = (index: number) => {
      const row = rows[index];
      const container = row.parentElement?.classList.contains('folder-file-tree__group')
        ? row.parentElement
        : row;
      return Array.from(list.children).indexOf(container!);
    };

    expect(draftIndex).toBe(rowIndex(kind === 'folder' ? firstFolderIndex : firstNoteIndex) - 1);
    expect(input.parentElement?.style.marginLeft).toBe(
      parentPath === '/notes'
        ? '22px'
        : kind === 'folder' ? '42px' : '42px',
    );
    if (kind === 'note') expect(draftIndex).toBeGreaterThan(rowIndex(firstFolderIndex));
    await act(async () => root.unmount());
  });

  it('shows the folder target before release and moves the note on release', async () => {
    const onMoveNote = vi.fn(async () => {});
    const { root, refresh } = await mount(onMoveNote);
    const noteRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="note"]')!;
    const folderRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="folder"]')!;
    const folderGroup = folderRow.closest<HTMLElement>('.folder-file-tree__group')!;
    vi.mocked(document.elementFromPoint).mockReturnValue(folderRow);

    await act(async () => noteRow.dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    expect(HTMLElement.prototype.setPointerCapture).toHaveBeenCalledWith(7);
    await act(async () => noteRow.dispatchEvent(pointerEvent('pointermove', 20, 10)));
    expect(folderRow.className).not.toContain('bg-[color-mix(in_oklch,var(--brand)_15%,transparent)]');
    expect(folderGroup.dataset.dragOver).toBe('true');
    expect(host.textContent).not.toContain('memo.fileTree.dropToMove');
    await act(async () => noteRow.dispatchEvent(pointerEvent('pointerup', 20, 10)));

    await vi.waitFor(() => expect(onMoveNote).toHaveBeenCalledWith('/notes/a.md', '/notes/projects'));
    expect(refresh).toHaveBeenCalledWith('/notes');
    expect(refresh).toHaveBeenCalledWith('/notes/projects');
    await act(async () => root.unmount());
  });

  it('does not move a note when the pointer never crosses the drag threshold', async () => {
    const onMoveNote = vi.fn(async () => {});
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

  it('cancels the move when the pointer is released outside the tree', async () => {
    const onMoveNote = vi.fn(async () => {});
    const { root } = await mount(onMoveNote);
    const noteRow = host.querySelector<HTMLElement>('[data-notebook-tree-kind="note"]')!;
    vi.mocked(document.elementFromPoint).mockReturnValue(document.body);

    await act(async () => noteRow.dispatchEvent(pointerEvent('pointerdown', 10, 10)));
    await act(async () => noteRow.dispatchEvent(pointerEvent('pointermove', 20, 10)));
    await act(async () => noteRow.dispatchEvent(pointerEvent('pointerup', 20, 10)));

    expect(onMoveNote).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
