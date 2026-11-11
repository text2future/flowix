import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { NotebookPinnedTreeRow, type NotebookPinnedTreeRowController } from './notebook-pinned-tree-row';
import { getNotebookTreeRowPresentation } from './notebook-tree-row-model';
import type { PinnedTreeItem } from './use-notebook-pinned-notes';
import type { NotebookTreeRow } from './notebook-tree-row';

const captured = vi.hoisted(() => ({ row: null as ComponentProps<typeof NotebookTreeRow> | null }));
vi.mock('./notebook-tree-row', () => ({
  NotebookTreeRow: (props: ComponentProps<typeof NotebookTreeRow>) => {
    captured.row = props;
    return null;
  },
}));

it('forwards shared directory feedback and retries without changing pinned expansion', async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement('div'));
  const item: PinnedTreeItem = {
    id: 'pinned-folder:/notes/folder', fullPath: '/notes/folder', name: 'folder', type: 'folder',
    pinnedEntryKind: 'folder', parentId: null, children: null,
    sizeBytes: null, modifiedMs: null, createdMs: null, memoCreatedMs: null,
  };
  const expanded = new Set([item.fullPath]);
  const retry = vi.fn();
  const render = async (loading: boolean, failed: boolean) => {
    const controller: NotebookPinnedTreeRowController = {
      notebookPath: '/notes',
      getPresentation: (row) => getNotebookTreeRowPresentation({
        item: row, activeFilePath: null, selectedFolderPath: null, selectedConversationId: null,
        selectedFilePaths: [], selectedFilePathSet: new Set(), expandedPaths: expanded,
        loadingDirectories: new Set(loading ? [item.fullPath] : []),
        directoryErrors: new Set(failed ? [item.fullPath] : []),
        dragOverFolderPath: null, moveFeedback: null,
      }),
      isCut: () => false, canDeleteSelected: () => false, hasWorkDocumentsCollection: () => false,
      onTogglePinned: () => undefined, onKeyDown: vi.fn(), onRetryChildren: retry,
      actions: {
        onToggle: vi.fn(), onOpen: vi.fn(), onCreateNote: vi.fn(), onCreateFolder: vi.fn(),
        onCreateView: vi.fn(), onCreateMediaLibrary: vi.fn(), onRename: vi.fn(), onPointerDown: vi.fn(),
      },
    };
    await act(async () => root.render(<NotebookPinnedTreeRow item={item} controller={controller} />));
  };
  try {
    await render(true, false);
    expect(captured.row).toMatchObject({ expanded: true, isLoadingChildren: true, childrenError: false });
    await render(false, true);
    expect(captured.row).toMatchObject({ expanded: true, isLoadingChildren: false, childrenError: true });
    captured.row!.onRetryChildren?.(item.fullPath);
    expect(retry).toHaveBeenCalledExactlyOnceWith(item.fullPath);
    expect(expanded.has(item.fullPath)).toBe(true);
    await render(false, false);
    expect(captured.row).toMatchObject({ expanded: true, isLoadingChildren: false, childrenError: false });
  } finally {
    await act(async () => root.unmount());
    environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
