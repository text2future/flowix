'use client';

import type { ContentKind } from '@features/content/public/content-api';
import { useCollectionIdentityRepair } from './use-collection-identity-repair';
import { useNotebookTreeRename } from './use-notebook-tree-rename';
import { useNotebookTreeClipboard } from './use-notebook-tree-clipboard';

import { NotebookTreeCustomizePanel, type NotebookTreeCustomizePanelHandle } from './notebook-tree-customize-panel';

import type { TableViewType } from '@features/multidimensional-table/public/create-api';
import { useNotebookTreeSections } from './use-notebook-tree-sections';
import { useNotebookTreeSectionLayout } from './use-notebook-tree-section-layout';

import { useColumnNavigation } from '@features/workspace/public/column-navigation-api';
import { AgentTasksSection } from '@features/agent/public/shell-api';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { SquaresFourIcon } from '@phosphor-icons/react';

import {
  canonicalDirectoryPath,
  canonicalPath,
  joinNotebookMemoPath,
  notebookRelativeDirectoryPath,
  parentDirectoryPath,
  samePath,
} from '@/lib/path';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { FileTreeLoadingSkeleton } from '@shared/ui/file-tree-loading-skeleton';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { ListSurfaceViewport } from '@shared/ui/list-surface';
import { NotebookCreateContextMenuItems } from '@features/memo/components/notebook-create-context-menu';
import { useNoteStore } from '@features/memo/store/note-store';
import { useCustomFilterStore } from '@features/memo/store/custom-filter-store';
import { NotebookPinnedSection } from '@features/memo/components/notebook-file-tree-sections';
import { useNotebookPinnedNotes } from '@features/memo/components/use-notebook-pinned-notes';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import {
  flattenVisibleTree,
  type FolderTreeController,
  type FolderTreeSort,
} from '@features/memo/components/use-folder-tree';
import { NotebookTreeRow, type TreeRowClickModifiers } from '@features/memo/components/notebook-tree-row';
import { mapWorkspaceAgentRepositories, type WorkspaceAgentRepository } from '@features/agent/public/workspace-api';
import { useAgentWorkspaceStore } from '@features/agent/store/agent-workspace-store';
import {
  type DocTreeItem,
  type MediaLibraryListItem,
  type TableDocumentListItem,
} from '@platform/tauri/client';
import { useDynamicVirtualList } from '@features/memo/hooks/use-dynamic-virtual-list';
import { useNotebookViewData } from './use-notebook-view-data';
import { usePinnedEntryActions } from './use-pinned-entry-actions';
import { usePinnedSectionItems } from './use-pinned-section-items';
import {
  type NotebookTreeDraftState,
  type NotebookTreeRenderRow,
} from './notebook-tree-render-rows';
export { buildNotebookTreeRenderRows } from './notebook-tree-render-rows';
import {
  useLoadedTreeIndex,
  useNotebookTreeRenderModel,
  useTreeItemIndex,
} from './use-notebook-tree-derived';
import { AgentRepositoriesSection } from './notebook-repositories-section';
import { NotebookRepositoriesPage } from './notebook-repositories-page';
import { NotebookFilesSection } from './notebook-files-section';
import { useRepositoryFileOpen } from './use-repository-file-open';
import { NotebookMoreSection } from './notebook-more-section';
import { TREE_EDGE_GUTTER, INDENT_PER_LEVEL, TREE_ROW_GAP, TREE_ROW_HEIGHT, TREE_ROW_SIZE } from './notebook-tree-layout';
import { NotebookTreeDraft } from './notebook-tree-draft';
import { useNotebookTreeDraftActions, type NotebookFolderCreateRequest } from './use-notebook-tree-draft-actions';
import { useNotebookTreeFileActions } from './use-notebook-tree-file-actions';
import { getNotebookTreeRowPresentation } from './notebook-tree-row-model';
import { useNotebookTreeInteraction } from './use-notebook-tree-interaction';
import { useNotebookTreeDragController } from './use-notebook-tree-drag-controller';
import { useNotebookTreeImports } from './use-notebook-tree-imports';
import type { NotebookMoveResult, NotebookMoveSource } from './use-notebook-tree-drag-controller';
export type { NotebookMoveResult, NotebookMoveSource } from './use-notebook-tree-drag-controller';
import { getPopupOriginRect, NotebookTreeSectionMenu } from './notebook-tree-section-menu';
import { relativeFolderPath, useNotebookTreeCreation } from './use-notebook-tree-creation';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@shared/ui/context-menu';

const TREE_VIRTUAL_OVERSCAN = 20;
const TREE_INITIAL_RENDER_COUNT = 40;
const logger = createLogger('notebook-file-tree');
// Row gutter (6px) + inline padding (6px) + half of the 12px caret.
const FOLDER_CARET_CENTER_OFFSET = 12;

export type { NotebookFolderCreateRequest } from './use-notebook-tree-draft-actions';

interface NotebookFileTreeProps {
  notebookId?: string;
  notebookPath: string;
  notebookName: string;
  activeFilePath?: string | null;
  activeFileRevealRatio?: number;
  tree: FolderTreeController;
  isActive?: boolean;
  /** Skip only the first root read; retries and later reloads retain feedback. */
  skipInitialLoading?: boolean;
  contentClassName?: string;
  createFolderRequest?: NotebookFolderCreateRequest | null;
  onCreateFolder?: () => void;
  onNoteSelect: (filePath: string) => void;
  onFolderSelect?: (folderPath: string) => void;
  onNoteOpenInNewTab?: (filePath: string) => void;
  onCreateNote: (parentPath?: string, title?: string) => Promise<void> | void;
  onMoveNote: (
    sources: NotebookMoveSource[],
    targetDirectoryPath: string,
  ) => Promise<NotebookMoveResult>;
  onDeleteFolder?: (folderPath: string) => Promise<void | boolean>;
  onDeleteFile?: (item: DocTreeItem, options?: { silent?: boolean }) => Promise<boolean | void>;
  defaultCreateFolder?: string | null;
  onSetDefaultCreateFolder?: (folderPath: string) => void;
}


/**
 * Notebook file tree with selection, pointer dragging, and external drops.
 */
export function NotebookFileTree({
  notebookId: notebookIdProp,
  notebookPath,
  notebookName,
  activeFilePath = null,
  activeFileRevealRatio,
  tree,
  isActive = true,
  skipInitialLoading = false,
  contentClassName,
  createFolderRequest,
  onCreateFolder,
  onNoteSelect,
  onFolderSelect,
  onNoteOpenInNewTab,
  onCreateNote,
  onMoveNote,
  onDeleteFolder,
  onDeleteFile,
  defaultCreateFolder,
  onSetDefaultCreateFolder,
}: NotebookFileTreeProps) {
  const { t } = useI18n();
  const {
    rootChildren,
    nodes,
    expanded: expandedTreePaths,
    loading: treeLoading,
    error: treeError,
    loadingDirectories,
    directoryErrors,
    ignoreCollectionPathEvents,
    refresh: refreshTree,
    expandTo,
    toggle: toggleTree,
    loadDirectory,
    retryDirectory,
    reload: reloadTree,
  } = tree;
  const [initialLoadPending, setInitialLoadPending] = useState(treeLoading);
  useEffect(() => {
    if (!treeLoading) setInitialLoadPending(false);
  }, [treeLoading]);
  const selectedFolderPath = useColumnNavigation(0, (navigation) => {
    const target = navigation.current?.target ?? { kind: 'empty' };
    if (
      target.kind === 'folder-collection'
      && samePath(target.notebookPath, notebookPath)
      && notebookRelativeDirectoryPath(notebookPath, target.folderPath) !== null
    ) {
      return target.folderPath;
    }
    if ((target.kind === 'collection' || target.kind === 'table' || target.kind === 'media-library') && canonicalPath(target.filePath).endsWith('/.index.yaml')) {
      return parentDirectoryPath(target.filePath, target.notebookPath ?? '');
    }
    return null;
  });
  const refreshTrigger = useNoteStore((state) => state.refreshTrigger);
  const notebookIdFromStore = useNoteStore((state) => (
    state.notebooks.find((notebook) => samePath(notebook.path, notebookPath))?.id ?? null
  ));
  const notebookId = notebookIdProp ?? notebookIdFromStore;
  const loadNotebookFilters = useCustomFilterStore((state) => state.loadNotebookFilters);
  const agentWorkspaceNotebook = useAgentWorkspaceStore((state) =>
    notebookId ? state.workspace.byNotebookId[notebookId] : undefined,
  );
  const agentWorkspaceReady = useAgentWorkspaceStore((state) => state.loadState.workspace.status === 'ready');
  const agentRepositories = useMemo(
    () => mapWorkspaceAgentRepositories(agentWorkspaceNotebook),
    [agentWorkspaceNotebook],
  );
  const [showScrollTopHint, setShowScrollTopHint] = useState(false);
  const [repositoriesPageOpen, setRepositoriesPageOpen] = useState(false);

  const {
    pinnedItems,
    hasPrevious: pinnedHasPrevious,
    hasMore: pinnedHasMore,
    loadingMore: pinnedLoadingMore,
    loadingInitial: pinnedLoadingInitial,
    loadPrevious: loadPreviousPinned,
    loadMore: loadMorePinned,
    removePinnedItem,
  } = useNotebookPinnedNotes({
    notebookId,
    notebookPath,
    isActive,
    refreshTrigger,
  });
  const {
    tableDocuments,
    mediaLibraries,
    workDocumentCollections,
    refreshTables,
    refreshMediaLibraries,
    refreshWorkDocumentCollections,
    updateTableIdentity,
    updateMediaLibraryIdentity,
  } = useNotebookViewData({
    notebookId,
    notebookPath,
    isActive,
    refreshTrigger,
    ignoreCollectionPathEvents,
  });
  const {
    openNewTableDialog, openNewMediaLibraryDialog, handleCreateMediaLibraryAtPath,
    openNewWorkDocumentsDialog, creationDialog,
  } = useNotebookTreeCreation({
    notebookId,
    notebookPath,
    // Implicit destination: the folder being browsed in the Work column,
    // otherwise the notebook's stored default note folder.
    defaultCreateFolder: selectedFolderPath
      ? relativeFolderPath(notebookPath, selectedFolderPath)
      : defaultCreateFolder ?? null,
    refreshTables,
    refreshMediaLibraries,
    refreshWorkDocumentCollections,
  });
  const tableDocumentByPath = useMemo(() => {
    const byPath = new Map<string, TableDocumentListItem>();
    for (const table of tableDocuments) {
      const fullPath = joinNotebookMemoPath(notebookPath, table.relativePath);
      if (fullPath) byPath.set(canonicalPath(fullPath), table);
    }
    return byPath;
  }, [notebookPath, tableDocuments]);
  const mediaLibraryByPath = useMemo(() => {
    const byPath = new Map<string, MediaLibraryListItem>();
    for (const library of mediaLibraries) {
      const fullPath = joinNotebookMemoPath(notebookPath, library.relativePath);
      if (fullPath) byPath.set(canonicalPath(fullPath), library);
    }
    return byPath;
  }, [mediaLibraries, notebookPath]);
  const workDocumentCollectionByPath = useMemo(() => new Map(workDocumentCollections.flatMap((collection) => {
    const fullPath = joinNotebookMemoPath(notebookPath, collection.relativePath);
    return fullPath ? [[canonicalPath(fullPath), collection] as const] : [];
  })), [notebookPath, workDocumentCollections]);
  const selectionContentKinds = useMemo(() => new Map<string, ContentKind>([
    ...Array.from(tableDocumentByPath.keys(), (path) => [path, 'multidimensional-table'] as const),
    ...Array.from(mediaLibraryByPath.keys(), (path) => [path, 'media-library'] as const),
    ...Array.from(workDocumentCollectionByPath.keys(), (path) => [path, 'work-documents'] as const),
  ]), [tableDocumentByPath, mediaLibraryByPath, workDocumentCollectionByPath]);
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  // 置顶分组与文件树是同一份数据的两个入口, 展开状态按入口各自持有:
  // 在置顶里展开/收起文件夹不联动文件树, 反之亦然。目录数据缓存 (nodes)
  // 仍然共享, 两个入口各自展开时按需加载, 不重复请求。
  const [pinnedExpandedPaths, setPinnedExpandedPaths] = useState<Set<string>>(() => new Set());
  const pinnedExpandedPathKeys = useMemo(
    () => new Set([...pinnedExpandedPaths].map(canonicalPath)),
    [pinnedExpandedPaths],
  );
  const [fileTreeSort, setFileTreeSort] = useState<FolderTreeSort>('filenameAsc');
  const {
    sectionOrder,
    hiddenSections,
    pinnedFolders,
    updateSections,
    updatePinnedFolders,
  } = useNotebookTreeSections(notebookId, isActive);
  const customizePanelRef = useRef<NotebookTreeCustomizePanelHandle>(null);
  const openCustomizeDisplay = useCallback((rect: DOMRect) => customizePanelRef.current?.open(rect), []);
  const treeScrollerRef = useRef<HTMLDivElement | null>(null);
  const treeRootRef = useRef<HTMLDivElement | null>(null);
  const externalDropSurfaceRef = useRef<HTMLDivElement | null>(null);
  const {
    draft,
    inputRef: draftInputRef,
    updateDraft,
    submitDraft,
    cancelDraft,
    requestCreateFolderDraft,
  } = useNotebookTreeDraftActions({
    createFolderRequest,
    expandTo,
    refreshDirectory: refreshTree,
  });

  useEffect(() => {
    if (!isActive) return;
    if (notebookId) void loadNotebookFilters(notebookId);
  }, [isActive, loadNotebookFilters, notebookId]);

  const { handleImportFiles, handleImportFolder } = useNotebookTreeImports({
    notebookPath,
    refreshDirectory: refreshTree,
  });
  const pinnedFolderFullPaths = useMemo(() => pinnedFolders.flatMap((path) => {
    const fullPath = joinNotebookMemoPath(notebookPath, path);
    return fullPath ? [canonicalDirectoryPath(fullPath)] : [];
  }), [notebookPath, pinnedFolders]);
  const pinnedFolderPathSet = useMemo(() => new Set(pinnedFolderFullPaths), [pinnedFolderFullPaths]);
  // Loading/error flags and controller callbacks do not change tree topology.
  // 条目、路径索引、文件夹集合一次遍历产出，见 use-notebook-tree-derived。
  const loadedTreeIndex = useLoadedTreeIndex(rootChildren, nodes);
  const loadedTreeItems = loadedTreeIndex.items;
  // Pinned folders lead the pinned group with their subtree; entries follow.
  // The pinned group keeps its own expand set, independent from the files tree.
  const pinnedSectionItems = usePinnedSectionItems({
    entries: pinnedItems, folderPaths: pinnedFolderFullPaths, loadedItems: loadedTreeItems,
    nodes, expanded: pinnedExpandedPaths, sort: fileTreeSort,
  });
  const pinnedNavigationItems = useMemo(() => pinnedSectionItems.map(item => ({
    item, depth: item.pinnedDepth ?? 0,
  })), [pinnedSectionItems]);
  const {
    visibleSectionOrder,
    moreCompactTopSpacing,
    treeContentOffset,
    setMoreSectionHeight,
    handleAgentSectionHeightChange,
    handleRepositorySectionHeightChange,
    moveTreeSection,
    hideTreeSection,
  } = useNotebookTreeSectionLayout({
    notebookId,
    sectionOrder,
    hiddenSections,
    updateSections,
    pinnedItemCount: pinnedSectionItems.length,
    pinnedHasPrevious,
    pinnedHasMore,
    pinnedCollapsed,
  });
  const treeHeaderRef = useRef<HTMLDivElement | null>(null);
  const [keptAlivePaths, setKeptAlivePaths] = useState<Set<string>>(() => new Set());
  const visibleTreeItems = useMemo(
    () => flattenVisibleTree({ rootChildren, nodes, expanded: expandedTreePaths }, fileTreeSort),
    [rootChildren, nodes, expandedTreePaths, fileTreeSort],
  );
  const { rows: renderRows, rowIndexByPath: renderRowIndexByPath } =
    useNotebookTreeRenderModel(visibleTreeItems, notebookPath, draft);
  const handleShowAllAgentConversations = useCallback(() => {
    useNoteStore.getState().setMiddleColumnView('conversations');
  }, []);
  const { itemByPath: treeItemByPath, folderPaths } =
    useTreeItemIndex(loadedTreeIndex, pinnedSectionItems);
  const openMediaLibraryPath = useCallback((
    path: string,
    host: 'column-1' | 'column-2',
  ) => {
    const mediaLibrary = mediaLibraryByPath.get(canonicalPath(path));
    if (!mediaLibrary || !notebookId) return false;
    void openWorkspaceSurface({
      index: host === 'column-1' ? 0 : 1,
      target: {
        kind: 'collection-reference',
        notebookId,
        collectionId: mediaLibrary.collectionId,
        collectionKind: 'media_library',
        relativePathHint: mediaLibrary.relativePath,
      },
    }).catch((error) => {
      logger.warn('failed to open media library', { error, path, host });
      toast.error(t('memo.fileTree.openFailed'));
    });
    return true;
  }, [mediaLibraryByPath, notebookId, t]);
  // Every file-tree selection navigates through this content-aware opener.
  // Selection/anchor/policy remain exclusively owned by the interaction controller.
  const openSelectedDocument = useCallback((path: string) => {
    const key = canonicalPath(path);
    const pinnedCollection = pinnedSectionItems.find(item => item.pinnedEntryKind === 'collection' && samePath(item.fullPath, path));
    if (tableDocumentByPath.has(key) || workDocumentCollectionByPath.has(key)
      || (pinnedCollection && pinnedCollection.pinnedCollectionType !== 'media_library')) {
      void openWorkspaceSurface({
        index: 0,
        target: { kind: 'external', path, scopePath: notebookPath, transitionId: null },
        options: { notebookId },
      }).catch((error) => {
        logger.warn('failed to open collection', { error, path });
        toast.error(t('memo.fileTree.openFailed'));
      });
    } else if (!openMediaLibraryPath(path, 'column-1')) onNoteSelect(path);
  }, [tableDocumentByPath, workDocumentCollectionByPath, pinnedSectionItems, notebookPath, notebookId, t, openMediaLibraryPath, onNoteSelect]);
  const {
    focusedTreePath,
    setFocusedTreePath,
    selectedFilePaths,
    selectedConversationId,
    selectConversation,
    selectedFilePathSet,
    updateSelection,
    getSelectionAnchorPath,
    activeFileShouldReveal,
    treeFocusPath,
    handleTreeItemKeyDown,
    focusTreeItem,
    selectItem,
  } = useNotebookTreeInteraction({
    activeFilePath,
    visibleTreeItems,
    treeItemPaths: treeItemByPath,
    contentKinds: selectionContentKinds,
    pinnedItemPaths: pinnedSectionItems.map((item) => item.fullPath),
    tree,
    treeRootRef,
    treeScrollerRef,
    renderRowIndexByPath,
    treeContentOffset,
    isActive,
    activeFileRevealRatio,
    folderPaths,
    onNoteSelect: openSelectedDocument,
    onFolderSelect,
  });
  const {
    canDeleteSelectedDocuments,
    handleDeleteSelected,
    handleTogglePinnedFolder,
    handleDeleteFolder: handleDeleteFolderPath,
  } = useNotebookTreeFileActions({
    notebookId,
    notebookPath,
    selectedFilePaths,
    itemsByPath: treeItemByPath,
    onDeleteFolder,
    onDeleteFile,
    updateSelection,
    updatePinnedFolders,
  });
  const {
    dragOverFolderPath,
    isDragging,
    consumeDragClickSuppression: consumeDraggedClick,
    moveFeedback,
    startItemDrag: handlePointerDownItem,
    handlePointerMove: handleTreePointerMove,
    handlePointerUp: handleTreePointerUp,
    handlePointerCancel: handleTreePointerCancel,
    shouldSuppressOpen: shouldSuppressOpenPath,
  } = useNotebookTreeDragController({
    notebookId,
    notebookPath,
    tree,
    treeItemsByPath: treeItemByPath,
    selectedFilePaths,
    getSelectionAnchorPath,
    updateSelection,
    onMoveNote,
    treeRootRef,
    treeHeaderRef,
    treeScrollerRef,
    externalDropSurfaceRef,
    t,
  });
  const clipboard = useNotebookTreeClipboard({
    notebookPath, selectedFilePaths, selectedFolderPath, activeFilePath,
    getSelectionAnchorPath, items: treeItemByPath, tree, onMoveNote, rootRef: externalDropSurfaceRef, isActive,
  });
  const getRenderRowKey = useCallback((row: NotebookTreeRenderRow) => row.key, []);
  const estimateRenderRowSize = useCallback(() => TREE_ROW_SIZE, []);
  const keepAliveKeys = useMemo(() => {
    const keys = [...keptAlivePaths].map((path) => 'node:' + canonicalPath(path));
    if (focusedTreePath) keys.push('node:' + canonicalPath(focusedTreePath));
    if (draft) keys.push('draft:' + draft.requestId);
    return keys;
  }, [draft, focusedTreePath, keptAlivePaths]);
  const treeRowsEnabled = !filesCollapsed && (isActive || keptAlivePaths.size > 0);
  const {
    totalSize: measuredTreeSize,
    virtualItems: virtualTreeRows,
  } = useDynamicVirtualList({
    items: renderRows,
    getKey: getRenderRowKey,
    estimateSize: estimateRenderRowSize,
    scrollerRef: treeScrollerRef,
    enabled: treeRowsEnabled,
    resetKey: notebookPath,
    overscan: TREE_VIRTUAL_OVERSCAN,
    keepAliveKeys,
    scrollMargin: treeContentOffset,
    unmeasuredItemLimit: TREE_INITIAL_RENDER_COUNT,
  });
  const lastTreeSizeRef = useRef(0);
  useLayoutEffect(() => {
    if (treeRowsEnabled) lastTreeSizeRef.current = measuredTreeSize;
  }, [measuredTreeSize, treeRowsEnabled]);
  const virtualTreeSize = treeRowsEnabled
    ? measuredTreeSize
    : Math.max(lastTreeSizeRef.current, renderRows.length * TREE_ROW_SIZE);
  // Keep fallback work and mounted DOM bounded until the viewport can be measured.
  useEffect(() => {
    if (!isActive || !draft) return;
    const index = renderRows.findIndex((row) => row.key === 'draft:' + draft.requestId);
    const scroller = treeScrollerRef.current;
    if (index < 0 || !scroller) return;
    const rowTop = treeContentOffset + index * TREE_ROW_SIZE;
    const rowBottom = rowTop + TREE_ROW_HEIGHT;
    if (rowTop < scroller.scrollTop) scroller.scrollTop = rowTop;
    else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, rowBottom - scroller.clientHeight);
    }
  }, [draft, isActive, renderRows, treeContentOffset]);
  const handleRowKeepAliveChange = useCallback((path: string, active: boolean) => {
    const key = canonicalPath(path);
    setKeptAlivePaths((previous) => {
      const alreadyKept = previous.has(key);
      if (alreadyKept === active) return previous;
      const next = new Set(previous);
      if (active) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const hasVisibleItems = rootChildren.length > 0;
  const isRootDropTarget = dragOverFolderPath !== null
    && canonicalDirectoryPath(dragOverFolderPath) === canonicalDirectoryPath(notebookPath);
  const expandToRef = useRef(expandTo);
  expandToRef.current = expandTo;

  const createNoteAtPath = useCallback(async (parentPath?: string) => {
    try {
      await onCreateNote(parentPath);
    } catch (error) {
      toast.error(t(
        String(error).includes('FILE_EXISTS')
          ? 'memo.fileTree.nameConflict'
          : 'memo.fileTree.createFailed',
      ));
    }
  }, [onCreateNote, t]);

  useEffect(() => {
    if (!isActive || !activeFilePath || !activeFileShouldReveal || treeLoading) return;
    void expandToRef.current(activeFilePath);
  }, [activeFileShouldReveal, activeFilePath, isActive, treeLoading]);

  const handleRename = useNotebookTreeRename({ notebookId, notebookPath, tree, tableDocumentByPath, mediaLibraryByPath });

  const tableDocumentIdentityByPath = useCollectionIdentityRepair({
    kind: 'table', notebookId, itemsByPath: tableDocumentByPath,
    refresh: refreshTables, updateIdentity: updateTableIdentity,
  });
  const mediaLibraryIdentityByPath = useCollectionIdentityRepair({
    kind: 'media-library', notebookId, itemsByPath: mediaLibraryByPath,
    refresh: refreshMediaLibraries, updateIdentity: updateMediaLibraryIdentity,
  });

  const handleTogglePath = useCallback((path: string) => {
    if (shouldSuppressOpenPath(path)) return;
    toggleTree(path);
  }, [shouldSuppressOpenPath, toggleTree]);
  /** 置顶分组的文件夹展开: 只翻置顶自己的集合, 数据加载复用 tree 缓存。 */
  const handleTogglePinnedFolderPath = useCallback((path: string) => {
    if (shouldSuppressOpenPath(path)) return;
    const key = canonicalDirectoryPath(path);
    setPinnedExpandedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    void loadDirectory(path);
  }, [shouldSuppressOpenPath, loadDirectory]);
  // 置顶取消或目录改名后, 旧路径不再属于任何置顶子树: 清掉展开残留,
  // 避免重新置顶同名/同前缀路径时意外恢复上一次的展开态。
  useEffect(() => {
    if (pinnedFolderFullPaths.length === 0) {
      setPinnedExpandedPaths((previous) => (previous.size === 0 ? previous : new Set()));
      return;
    }
    const roots = pinnedFolderFullPaths.map((path) => canonicalPath(path));
    setPinnedExpandedPaths((previous) => {
      const next = new Set([...previous].filter((key) =>
        roots.some((root) => key === root || key.startsWith(`${root}/`))));
      return next.size === previous.size ? previous : next;
    });
  }, [pinnedFolderFullPaths]);
  const handleOpenPath = useCallback((path: string, modifiers?: TreeRowClickModifiers) => {
    if (shouldSuppressOpenPath(path)) return;
    selectItem(path, modifiers);
  }, [selectItem, shouldSuppressOpenPath]);
  const handleOpenPinnedPath = useCallback((path: string, modifiers?: TreeRowClickModifiers) => {
    if (shouldSuppressOpenPath(path)) return;
    selectItem(path, modifiers, 'pinned');
  }, [selectItem, shouldSuppressOpenPath]);

  const { openRepositoryFile, openRepositoryFileInBrowser } = useRepositoryFileOpen();

  // Documents and collections pin through the backend index; notes keep frontmatter.
  // The pinned group and the files tree both route collections through `toggleCollectionPinned`.
  const { treePinProps, pinnedRowToggle } = usePinnedEntryActions({
    notebookId, notebookPath, removePinnedItem, refreshDirectory: refreshTree,
    refreshTables, refreshMediaLibraries, refreshWorkDocumentCollections,
    tableDocumentByPath, mediaLibraryByPath, workDocumentCollectionByPath,
    toggleFolderPinned: handleTogglePinnedFolder,
  });

  const handleRetryDirectory = useCallback((path: string) => {
    void retryDirectory?.(path);
  }, [retryDirectory]);
  const handleCreateViewAtPath = useCallback((parentPath: string, viewType?: TableViewType) => {
    openNewTableDialog(parentPath, viewType);
  }, [openNewTableDialog]);
  const handleAddRepository = useCallback(async () => {
    if (!notebookId) return;
    const result = await useAgentWorkspaceStore.getState().workspaceActions.addFolderFromPicker(notebookId);
    if (!result.ok) {
      if (result.code === 'already-tracked') toast.error(t('agent.access.alreadyTracked'));
      else if (result.code === 'save-failed') toast.error(t('agent.access.saveFailed'));
      return;
    }
  }, [notebookId, t]);
  const handleRemoveRepository = useCallback(async (repository: WorkspaceAgentRepository) => {
    if (!notebookId) return;
    const access = useAgentWorkspaceStore.getState().workspaceActions;
    const saved = await access.detachFolderFromNotebook(notebookId, repository.path);
    if (saved === false) {
      toast.error(t('agent.access.saveFailed'));
      return;
    }
    if (saved === 'not-attached') return;
    toast.success(t('agent.access.folderDeleted', { name: repository.name }));
  }, [notebookId, t]);
  const handleOpenPathInNewTab = useCallback((path: string) => {
    if (openMediaLibraryPath(path, 'column-2')) return;
    onNoteOpenInNewTab?.(path);
  }, [onNoteOpenInNewTab, openMediaLibraryPath]);
  const handleCreateNoteAtPath = useCallback((parentPath: string) => {
    void createNoteAtPath(parentPath);
  }, [createNoteAtPath]);
  const handleCreateFolderAtPath = useCallback((parentPath: string) => {
    requestCreateFolderDraft(parentPath);
  }, [requestCreateFolderDraft]);
  const handleImportFilesAtPath = useCallback((path: string) => {
    void handleImportFiles(path);
  }, [handleImportFiles]);
  const handleImportFolderAtPath = useCallback((path: string) => {
    void handleImportFolder(path);
  }, [handleImportFolder]);
  const handleFocusPath = useCallback((path: string) => setFocusedTreePath(path), [setFocusedTreePath]);
  const getRowPresentation = useCallback((
    item: DocTreeItem,
    expandedPaths: ReadonlySet<string> = expandedTreePaths,
    includeTreeFeedback = true,
  ) => getNotebookTreeRowPresentation({
    item,
    activeFilePath,
    selectedFolderPath,
    selectedConversationId,
    selectedFilePaths,
    selectedFilePathSet,
    expandedPaths,
    loadingDirectories: includeTreeFeedback ? loadingDirectories : undefined,
    directoryErrors: includeTreeFeedback ? directoryErrors : undefined,
    dragOverFolderPath: includeTreeFeedback ? dragOverFolderPath : null,
    moveFeedback: includeTreeFeedback ? moveFeedback : null,
  }), [
    activeFilePath,
    directoryErrors,
    dragOverFolderPath,
    expandedTreePaths,
    loadingDirectories,
    moveFeedback,
    selectedConversationId,
    selectedFilePathSet,
    selectedFilePaths,
    selectedFolderPath,
  ]);
  const renderDraft = (draftState: NotebookTreeDraftState, depth: number) => (
    <NotebookTreeDraft
      draft={draftState}
      depth={depth}
      data-notebook-tree-depth={depth}
      inputRef={draftInputRef}
      onChange={(value) => updateDraft(draftState.requestId, value)}
      onSubmit={() => void submitDraft()}
      onCancel={cancelDraft}
    />
  );

  const renderTreeItem = (
    item: DocTreeItem,
    depth: number,
    logicalParentPath: string,
    posInSet?: number,
    setSize?: number,
  ) => {
    const itemPath = canonicalPath(item.fullPath);
    const tableDocumentIdentity = tableDocumentIdentityByPath.get(itemPath);
    const mediaLibraryIdentity = mediaLibraryIdentityByPath.get(itemPath);
    const presentation = getRowPresentation(item);

    return (
      <div
        className={cn(
          item.type === 'folder' && 'folder-file-tree__group notebook-file-tree__folder-group relative',
        )}
        data-notebook-tree-row="true"
        data-notebook-tree-depth={depth}
        data-drag-over={presentation.isDropTarget ? 'true' : 'false'}
        data-notebook-drop-path={item.type === 'folder' ? item.fullPath : undefined}
        data-notebook-parent-path={logicalParentPath}
        style={{
          '--folder-file-tree-drop-left': `${TREE_EDGE_GUTTER + depth * INDENT_PER_LEVEL}px`,
          '--folder-file-tree-drop-right': `${TREE_EDGE_GUTTER}px`,
        } as CSSProperties}
      >
        {depth > 0 && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            {Array.from({ length: depth }, (_, level) => (
              <span
                key={level}
                className="absolute inset-y-0 w-px"
                style={{
                  left: TREE_EDGE_GUTTER + level * INDENT_PER_LEVEL + FOLDER_CARET_CENTER_OFFSET,
                  backgroundColor: 'color-mix(in srgb, var(--border) 72%, transparent)',
                }}
              />
            ))}
          </div>
        )}
        <NotebookTreeRow
          item={item}
          notebookPath={notebookPath}
          parentPath={logicalParentPath}
          posInSet={posInSet}
          setSize={setSize}
          depth={depth}
          expanded={presentation.expanded}
          isLoadingChildren={presentation.isLoadingChildren}
          childrenError={presentation.childrenError}
          onRetryChildren={handleRetryDirectory}
          active={presentation.active}
          selected={presentation.selected}
          onDeleteSelected={item.type === 'document' && canDeleteSelectedDocuments && selectedFilePathSet.has(canonicalPath(item.fullPath)) ? handleDeleteSelected : undefined}
          moveStatus={presentation.moveStatus}
          cut={clipboard.isCut(item.fullPath)}
          onToggle={handleTogglePath}
          onSelectFolder={handleOpenPath}
          onOpen={handleOpenPath}
          onOpenInNewTab={onNoteOpenInNewTab ? handleOpenPathInNewTab : undefined}
          onCreateNote={handleCreateNoteAtPath}
          onCreateFolder={handleCreateFolderAtPath}
          onImportFiles={handleImportFilesAtPath}
          onImportFolder={handleImportFolderAtPath}
          onCreateView={handleCreateViewAtPath}
          onCreateMediaLibrary={handleCreateMediaLibraryAtPath}
          onCreateWorkDocuments={openNewWorkDocumentsDialog}
          tableDocumentIdentity={tableDocumentIdentity}
          mediaLibraryIdentity={mediaLibraryIdentity}
          workDocumentsCollection={workDocumentCollectionByPath.has(itemPath)}
          onRename={handleRename}
          tabIndex={treeFocusPath && samePath(treeFocusPath, item.fullPath) ? 0 : -1}
          onFocus={handleFocusPath}
          onKeyDown={handleTreeItemKeyDown}
          onDeleteFolder={item.type === 'folder' && onDeleteFolder
            ? handleDeleteFolderPath
            : undefined}
          onDeleteFile={item.type === 'document' && onDeleteFile
            ? onDeleteFile
            : undefined}
          onSetDefaultFolder={item.type === 'folder' ? onSetDefaultCreateFolder : undefined}
          isDefaultFolder={item.type === 'folder' && defaultCreateFolder === relativeFolderPath(notebookPath, item.fullPath)}
          isPinnedFolder={item.type === 'folder' && pinnedFolderPathSet.has(canonicalDirectoryPath(item.fullPath))}
          onTogglePinnedFolder={item.type === 'folder' && notebookId ? handleTogglePinnedFolder : undefined}
          {...treePinProps(item, itemPath)}
          onKeepAliveChange={handleRowKeepAliveChange}
          onPointerDown={handlePointerDownItem}
        />
      </div>
    );
  };

  const renderTreeRow = (row: NotebookTreeRenderRow) => row.kind === 'draft'
    ? renderDraft(row.draft, row.depth)
    : renderTreeItem(row.item, row.depth, row.parentPath, row.posInSet, row.setSize);

  const folderDropHighlight = useMemo(() => {
    if (!dragOverFolderPath || samePath(dragOverFolderPath, notebookPath)) return null;
    const targetIndex = renderRows.findIndex((row) => (
      row.kind === 'node'
      && row.item.type === 'folder'
      && samePath(row.item.fullPath, dragOverFolderPath)
    ));
    if (targetIndex < 0) return null;
    const targetDepth = renderRows[targetIndex].depth;
    let endIndex = targetIndex + 1;
    while (endIndex < renderRows.length && renderRows[endIndex].depth > targetDepth) {
      endIndex += 1;
    }
    return {
      top: targetIndex * TREE_ROW_SIZE,
      height: Math.max(TREE_ROW_HEIGHT, (endIndex - targetIndex) * TREE_ROW_SIZE - TREE_ROW_GAP),
      left: TREE_EDGE_GUTTER + targetDepth * INDENT_PER_LEVEL,
    };
  }, [dragOverFolderPath, notebookPath, renderRows]);

  // Local tree handlers own range selection and hierarchy. At list boundaries,
  // continue through the other visible sections in their displayed order.
  const handleSectionNavigation = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    const origin = event.target instanceof Element ? event.target : null;
    if (!origin || origin.closest('input, textarea, [contenteditable="true"]')) return;
    const current = origin.closest<HTMLElement>('[data-notebook-tree-path], [data-notebook-conversation-item]');
    if (!current || (origin.closest('button') && !origin.closest('[data-notebook-conversation-item]'))) return;
    const root = event.currentTarget;
    const entries: Array<{ element: HTMLElement | null; path?: string; select: () => void; focus: () => void }> = [];
    for (const section of sectionOrder) {
      if (section === 'agents') {
        for (const button of root.querySelectorAll<HTMLButtonElement>('[data-notebook-conversation-item]')) {
          entries.push({ element: button, select: () => button.click(), focus: () => {
            button.focus({ preventScroll: true });
            button.scrollIntoView({ block: 'nearest' });
          } });
        }
      } else if (section === 'pinned') {
        for (const row of root.querySelectorAll<HTMLElement>('[data-notebook-pinned-section] [data-notebook-tree-path]')) {
          const path = row.dataset.notebookTreePath!;
          entries.push({ element: row, select: () => selectItem(path, undefined, 'pinned'), focus: () => {
            row.focus({ preventScroll: true });
            row.scrollIntoView({ block: 'nearest' });
          } });
        }
      } else if (section === 'files' && treeRootRef.current) {
        for (const { item } of visibleTreeItems) {
          entries.push({ element: null, path: item.fullPath,
            select: () => selectItem(item.fullPath), focus: () => focusTreeItem(item.fullPath) });
        }
      }
    }
    const currentIndex = entries.findIndex(entry => entry.element === current
      || (entry.path && current.closest('[data-notebook-tree-root]')
        && samePath(entry.path, current.dataset.notebookTreePath ?? '')));
    if (currentIndex < 0) return;
    const target = entries[currentIndex + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!target) return;
    event.preventDefault();
    target.select();
    target.focus();
  };

  return (
    <div
      onKeyDown={handleSectionNavigation}
      tabIndex={-1}
      onKeyDownCapture={clipboard.handleKeyDown}
      onPointerMove={handleTreePointerMove}
      onPointerUp={handleTreePointerUp}
      onPointerCancel={handleTreePointerCancel}
      onClickCapture={(event) => {
        // 拖动结束后浏览器补发的 click 必须在到达行之前被吃掉, 否则会误选中文件夹。
        if (!consumeDraggedClick()) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      ref={externalDropSurfaceRef}
      data-notebook-external-drop-target="true"
      className={cn(
        'relative flex h-full min-h-0 flex-col select-none bg-[var(--list-bg)] text-[var(--foreground)]',
        isDragging && 'notebook-file-tree--dragging',
      )}
    >
      <ListSurfaceViewport>
        <OverlayScrollbar
          className="h-full"
          scrollerClassName="h-full overflow-y-auto pt-1 pb-1"
          scrollerRef={treeScrollerRef}
          onScroll={(event) => {
            setShowScrollTopHint(event.currentTarget.scrollTop > 0);
          }}
        >
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="flex min-h-full flex-col">
          {notebookId && !hiddenSections.includes('agents') && (
            <AgentTasksSection
              key={notebookId}
              notebookId={notebookId}
              edgeGutter={TREE_EDGE_GUTTER}
              order={sectionOrder.indexOf('agents') + 1}
              onHeightChange={handleAgentSectionHeightChange}
              onConversationSelect={selectConversation}
              selectedConversationId={selectedConversationId}
              onHideSection={() => hideTreeSection('agents')}
              onShowAllConversations={handleShowAllAgentConversations}
              sectionActions={(
                <NotebookTreeSectionMenu
                  onHideSection={() => hideTreeSection('agents')}
                  canMoveUp={visibleSectionOrder.indexOf('agents') > 0}
                  canMoveDown={visibleSectionOrder.indexOf('agents') < visibleSectionOrder.length - 1}
                  onMoveUp={() => moveTreeSection('agents', -1)}
                  onMoveDown={() => moveTreeSection('agents', 1)}
                  onCustomizeDisplay={openCustomizeDisplay}
                  onConfigureAgentConversationCount={() => window.dispatchEvent(new CustomEvent('flowix:configure-agent-conversation-count', { detail: notebookId }))}
                />
              )}
            />
          )}
          {(pinnedSectionItems.length > 0 || pinnedHasPrevious || pinnedHasMore) && !hiddenSections.includes('pinned') && (
            <NotebookPinnedSection
              order={sectionOrder.indexOf('pinned') + 1}
              items={pinnedSectionItems}
              hasPreviousPage={pinnedHasPrevious}
              hasMoreItems={pinnedHasMore}
              loadingMore={pinnedLoadingMore || pinnedLoadingInitial}
              onLoadPrevious={loadPreviousPinned}
              onLoadMore={() => { void loadMorePinned(); }}
              collapsed={pinnedCollapsed}
              onToggleCollapsed={() => setPinnedCollapsed((collapsed) => !collapsed)}
              sectionActions={(
                <NotebookTreeSectionMenu
                  onHideSection={() => hideTreeSection('pinned')}
                  canMoveUp={visibleSectionOrder.indexOf('pinned') > 0}
                  canMoveDown={visibleSectionOrder.indexOf('pinned') < visibleSectionOrder.length - 1}
                  onMoveUp={() => moveTreeSection('pinned', -1)}
                  onMoveDown={() => moveTreeSection('pinned', 1)}
                  onCustomizeDisplay={openCustomizeDisplay}
                />
              )}
              renderItem={(item) => {
                const presentation = getRowPresentation(item, pinnedExpandedPathKeys, false);
                return <NotebookTreeRow
                  key={item.id}
                  item={item}
                  notebookPath={notebookPath}
                  parentPath={parentDirectoryPath(item.fullPath, notebookPath)}
                  depth={item.pinnedDepth ?? 0}
                  expanded={presentation.expanded}
                  active={presentation.active}
                  selected={presentation.selected}
                  cut={clipboard.isCut(item.fullPath)}
                  onDeleteSelected={canDeleteSelectedDocuments && selectedFilePathSet.has(canonicalPath(item.fullPath)) ? handleDeleteSelected : undefined}
                  onToggle={handleTogglePinnedFolderPath}
                  onSelectFolder={handleOpenPinnedPath}
                  onOpen={handleOpenPinnedPath}
                  onOpenInNewTab={
                    item.pinnedEntryKind !== 'collection' && onNoteOpenInNewTab
                      ? handleOpenPathInNewTab
                      : undefined
                  }
                  onCreateNote={handleCreateNoteAtPath}
                  onCreateFolder={handleCreateFolderAtPath}
                  onImportFiles={handleImportFilesAtPath}
                  onImportFolder={handleImportFolderAtPath}
                  onCreateView={(parentPath, viewType) => openNewTableDialog(parentPath, viewType)}
                  onCreateMediaLibrary={(parentPath) => openNewMediaLibraryDialog(parentPath)}
                  onCreateWorkDocuments={(parentPath) => openNewWorkDocumentsDialog(parentPath)}
                  onRename={handleRename}
                  onDeleteFile={onDeleteFile}
                  onPointerDown={handlePointerDownItem}
                  onKeepAliveChange={handleRowKeepAliveChange}
                  workDocumentsCollection={workDocumentCollectionByPath.has(canonicalPath(item.fullPath))}
                  favoritePath={item.fullPath}
                  onFavoriteChanged={(itemId, favorited) => {
                    if (!favorited) removePinnedItem(itemId);
                  }}
                  onTogglePinned={pinnedRowToggle(item)}
                  onFocus={handleFocusPath}
                  onKeyDown={(path, event) => handleTreeItemKeyDown(path, event, {
                    items: pinnedNavigationItems,
                    tree: { expanded: pinnedExpandedPaths, toggle: handleTogglePinnedFolderPath },
                    root: event.currentTarget.closest('section'),
                    list: 'pinned',
                  })}
                  tabIndex={0}
                />;
              }}
            />
          )}
          {!hiddenSections.includes('files') && (
            <NotebookFilesSection
              order={sectionOrder.indexOf('files') + 1}
              fillsRemainingSpace={visibleSectionOrder[visibleSectionOrder.length - 1] === 'files'}
              collapsed={filesCollapsed}
              onToggleCollapsed={() => setFilesCollapsed((collapsed) => !collapsed)}
              sectionActions={(
                <NotebookTreeSectionMenu
                  onHideSection={() => hideTreeSection('files')}
                  canMoveUp={visibleSectionOrder.indexOf('files') > 0}
                  canMoveDown={visibleSectionOrder.indexOf('files') < visibleSectionOrder.length - 1}
                  onMoveUp={() => moveTreeSection('files', -1)}
                  onMoveDown={() => moveTreeSection('files', 1)}
                  onCreateFolder={onCreateFolder}
                  onCreateNote={() => { void createNoteAtPath(); }}
                  onCreateTable={(viewType) => openNewTableDialog(undefined, viewType)}
                  onCreateMediaLibrary={() => openNewMediaLibraryDialog()}
                  onCreateWorkDocuments={() => openNewWorkDocumentsDialog()}
                  onImportFiles={() => { void handleImportFiles(notebookPath); }}
                  onImportFolder={() => { void handleImportFolder(notebookPath); }}
                  sort={fileTreeSort}
                  onSort={setFileTreeSort}
                  onCustomizeDisplay={openCustomizeDisplay}
                />
              )}
              isRootDropTarget={isRootDropTarget}
              headerRef={treeHeaderRef}
              rootRef={treeRootRef}
              notebookName={notebookName}
              hasError={Boolean(treeError)}
              onRetry={() => { void reloadTree(); }}
              hasVisibleItems={hasVisibleItems}
              loading={treeLoading}
              hasDraft={Boolean(draft)}
              virtualTreeSize={virtualTreeSize}
              contentClassName={contentClassName}
              folderDropHighlight={folderDropHighlight}
              virtualRows={virtualTreeRows}
              renderRow={renderTreeRow}
            />
          )}
          {!hiddenSections.includes('repositories') && (
            <AgentRepositoriesSection
              repositories={agentRepositories}
              introEnabled={agentWorkspaceReady}
              order={sectionOrder.indexOf('repositories') + 1}
              onHeightChange={handleRepositorySectionHeightChange}
              onHideSection={() => hideTreeSection('repositories')}
              sectionActions={(
                <NotebookTreeSectionMenu
                  onHideSection={() => hideTreeSection('repositories')}
                  canMoveUp={visibleSectionOrder.indexOf('repositories') > 0}
                  canMoveDown={visibleSectionOrder.indexOf('repositories') < visibleSectionOrder.length - 1}
                  onMoveUp={() => moveTreeSection('repositories', -1)}
                  onMoveDown={() => moveTreeSection('repositories', 1)}
                  onCustomizeDisplay={openCustomizeDisplay}
                />
              )}
              onAddRepository={() => { void handleAddRepository(); }}
              onRemoveRepository={(repository) => { void handleRemoveRepository(repository); }}
              onExpandRepository={() => {}}
              canAddRepository={Boolean(notebookId)}
              onOpenFile={openRepositoryFile}
              onOpenFileInBrowserColumn={openRepositoryFileInBrowser}
              viewMode="links"
              onOpenRepositoryList={() => setRepositoriesPageOpen(true)}
            />
          )}
          {!hiddenSections.includes('more') && (
            <NotebookMoreSection
              order={sectionOrder.indexOf('more') + 1}
              onHeightChange={setMoreSectionHeight}
              compactTopSpacing={moreCompactTopSpacing}
              sectionActions={(
                <NotebookTreeSectionMenu
                  onHideSection={() => hideTreeSection('more')}
                  canMoveUp={visibleSectionOrder.indexOf('more') > 0}
                  canMoveDown={visibleSectionOrder.indexOf('more') < visibleSectionOrder.length - 1}
                  onMoveUp={() => moveTreeSection('more', -1)}
                  onMoveDown={() => moveTreeSection('more', 1)}
                  onCustomizeDisplay={openCustomizeDisplay}
                />
              )}
            />
          )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-[180px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
              <NotebookCreateContextMenuItems
                onCreateNote={() => handleCreateNoteAtPath(notebookPath)}
                onCreateFolder={() => handleCreateFolderAtPath(notebookPath)}
                onCreateTable={(viewType) => openNewTableDialog(notebookPath, viewType)}
                onCreateMediaLibrary={() => openNewMediaLibraryDialog(notebookPath)}
                onCreateWorkDocuments={() => openNewWorkDocumentsDialog(notebookPath)}
                onImportFiles={() => { void handleImportFiles(notebookPath); }}
                onImportFolder={() => { void handleImportFolder(notebookPath); }}
              />
              <ContextMenuItem keepOpenOnClick
                onClick={(event) => openCustomizeDisplay(getPopupOriginRect(event.currentTarget))}
                className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
              >
                <SquaresFourIcon className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('memo.fileTree.customizeDisplay')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </OverlayScrollbar>
        {!hasVisibleItems && treeLoading && !(skipInitialLoading && initialLoadPending) && (
          <FileTreeLoadingSkeleton
            ariaLabel={t('memo.fileTree.loading')}
            className="absolute inset-0 z-[2] bg-[var(--list-bg)]"
          />
        )}
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 z-[3] h-10 bg-gradient-to-b from-[var(--list-bg)] to-transparent transition-opacity',
            showScrollTopHint ? 'opacity-100' : 'opacity-0',
          )}
        />
      </ListSurfaceViewport>
      {creationDialog}
      <NotebookTreeCustomizePanel ref={customizePanelRef} sectionOrder={sectionOrder} hiddenSections={hiddenSections} onChange={updateSections} />
      <NotebookRepositoriesPage
        open={repositoriesPageOpen}
        repositories={agentRepositories}
        introEnabled={agentWorkspaceReady}
        canAddRepository={Boolean(notebookId)}
        onBack={() => setRepositoriesPageOpen(false)}
        onAddRepository={() => { void handleAddRepository(); }}
        onRemoveRepository={(repository) => { void handleRemoveRepository(repository); }}
        onOpenFile={openRepositoryFile}
        onOpenFileInBrowserColumn={openRepositoryFileInBrowser}
      />
    </div>
  );
}
