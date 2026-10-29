'use client';

import type { ContentKind } from '@features/content/public/content-api';
import { noteRepository } from '@features/memo/services/note-repository';
import { documentIdentityFromFile, saveWorkspaceDocumentPath } from '@features/document/public/workspace-api';
import { ensureFileDisplayIdentity } from '@/lib/file-display-registry';
import { useNotebookViewActions } from './use-notebook-view-actions';
import { fileTreeCreateFailureKey } from './file-tree-failure';
import { useNotebookTreeRename } from './use-notebook-tree-rename';

import { NotebookTreeCustomizePanel, type NotebookTreeCustomizePanelHandle } from './notebook-tree-customize-panel';

import type { TableViewType } from '@features/multidimensional-table/public/create-api';
import { useNotebookTreeSections, type NotebookTreeSection } from './use-notebook-tree-sections';

import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { AgentTasksSection } from '@features/agent/public/shell-api';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import {
  ChevronRight, ChevronLeft, Plus,
} from 'lucide-react';
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
import { useComposingValue } from '@shared/hooks/use-composing-value';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { ListSurfaceViewport } from '@shared/ui/list-surface';
import { Button } from '@shared/ui/button';
import { NotebookTreeFileIcon } from '@features/memo/components/notebook-tree-file-icon';
import { NotebookCreateContextMenuItems } from '@features/memo/components/notebook-create-context-menu';
import { useNoteStore } from '@features/memo/store/note-store';
import { useCustomFilterStore } from '@features/memo/store/custom-filter-store';
import { NotebookPinnedSection, NotebookViewsSection } from '@features/memo/components/notebook-file-tree-sections';
import { useNotebookPinnedNotes } from '@features/memo/components/use-notebook-pinned-notes';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import folderIcon from '@/assets/folder-outline.svg?raw';
import {
  flattenLoadedTree,
  flattenVisibleTree,
  type FolderTreeController,
  type FolderTreeSort,
} from '@features/memo/components/use-folder-tree';
import { NotebookTreeRow } from '@features/memo/components/notebook-tree-row';
import { getWorkspaceAgentRepositories, type WorkspaceAgentRepository } from '@features/agent/public/workspace-api';
import { useAgentWorkspaceStore } from '@features/agent/store/agent-workspace-store';
import {
  files,
  collections,
  dialogs,
  type CollectionIndexItem,
  type DocTreeItem,
  type MediaLibraryListItem,
  type TableDocumentListItem,
} from '@platform/tauri/client';
import { useDynamicVirtualList } from '@features/memo/hooks/use-dynamic-virtual-list';
import { useNotebookViewData } from './use-notebook-view-data';
import { AgentRepositoriesSection } from './notebook-repositories-section';
import { useRepositoryFileOpen } from './use-repository-file-open';
import { NotebookMoreSection } from './notebook-more-section';
import { TREE_EDGE_GUTTER, INDENT_PER_LEVEL, TREE_ROW_GAP, TREE_ROW_HEIGHT, TREE_ROW_SIZE } from './notebook-tree-layout';
import { useNotebookTreeInteraction } from './use-notebook-tree-interaction';
import { useNotebookTreeDragController } from './use-notebook-tree-drag-controller';
import type { NotebookMoveResult, NotebookMoveSource } from './use-notebook-tree-drag-controller';
export type { NotebookMoveResult, NotebookMoveSource } from './use-notebook-tree-drag-controller';
import { getPopupOriginRect, NotebookTreeSectionMenu } from './notebook-tree-section-menu';
import {
  normalizeNotebookMoveFailure,
  showNotebookMoveFailureToasts,
  type NotebookMoveFailure,
} from './notebook-move-failure-toast';
import { getNotebookFolderImportErrorKey } from './notebook-folder-import';
import { relativeFolderPath, useNotebookTreeCreation } from './use-notebook-tree-creation';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@shared/ui/context-menu';

const TREE_HEADER_HEIGHT = 30;
const TREE_VIRTUAL_OVERSCAN = 20;
const logger = createLogger('notebook-file-tree');
// Row gutter (6px) + inline padding (6px) + half of the 12px caret.
const FOLDER_CARET_CENTER_OFFSET = 12;

function tableDocumentTreeItem(table: TableDocumentListItem, fullPath: string): DocTreeItem {
  const name = table.relativePath.split(/[\\/]/).pop() ?? `${table.name}.table.yml`;
  return {
    id: `table-path:${table.relativePath}`,
    fullPath,
    name,
    type: 'document',
    parentId: null,
    children: null,
    sizeBytes: null,
    modifiedMs: table.modifiedMs,
    createdMs: null,
    memoCreatedMs: null,
    resourceKind: 'other',
  };
}

function mediaLibraryTreeItem(library: MediaLibraryListItem, fullPath: string): DocTreeItem {
  const name = library.relativePath.split(/[\\/]/).pop() ?? `${library.name}.lib.yaml`;
  return {
    id: `media-library-path:${library.relativePath}`,
    fullPath,
    name,
    type: 'document',
    parentId: null,
    children: null,
    sizeBytes: null,
    modifiedMs: library.modifiedMs,
    createdMs: null,
    memoCreatedMs: null,
    resourceKind: 'other',
  };
}


function workDocumentsTreeItem(collection: CollectionIndexItem, fullPath: string): DocTreeItem {
  return {
    id: `work-documents-path:${collection.relativePath}`,
    fullPath,
    name: collection.relativePath.split(/[\\/]/).pop() ?? `${collection.name}.workdocs.yaml`,
    type: 'document',
    parentId: null,
    children: null,
    sizeBytes: collection.sizeBytes,
    modifiedMs: collection.modifiedMs,
    createdMs: null,
    memoCreatedMs: null,
    resourceKind: 'other',
  };
}


export interface NotebookFolderCreateRequest {
  id: number;
  parentPath: string;
}

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

interface NotebookTreeDraftState {
  requestId: number;
  parentPath: string;
  value: string;
}

interface NotebookTreeNodeRenderRow {
  kind: 'node';
  key: string;
  item: DocTreeItem;
  depth: number;
  parentPath: string;
  posInSet?: number;
  setSize?: number;
}

interface NotebookTreeDraftRenderRow {
  kind: 'draft';
  key: string;
  draft: NotebookTreeDraftState;
  depth: number;
  parentPath: string;
}

type NotebookTreeRenderRow = NotebookTreeNodeRenderRow | NotebookTreeDraftRenderRow;

function attachTreeSiblingMetadata(rows: NotebookTreeRenderRow[]): NotebookTreeRenderRow[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== 'node') continue;
    counts.set(row.parentPath, (counts.get(row.parentPath) ?? 0) + 1);
  }
  const positions = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== 'node') continue;
    const position = (positions.get(row.parentPath) ?? 0) + 1;
    positions.set(row.parentPath, position);
    row.posInSet = position;
    row.setSize = counts.get(row.parentPath);
  }
  return rows;
}

export function buildNotebookTreeRenderRows(
  visibleItems: Array<{ item: DocTreeItem; depth: number }>,
  notebookPath: string,
  draft: NotebookTreeDraftState | null,
): NotebookTreeRenderRow[] {
  const root = canonicalDirectoryPath(notebookPath);
  const rows: NotebookTreeRenderRow[] = visibleItems.map(({ item, depth }) => ({
    kind: 'node',
    key: `node:${canonicalPath(item.fullPath)}`,
    item,
    depth,
    parentPath: parentDirectoryPath(item.fullPath, root),
  }));
  if (!draft) return attachTreeSiblingMetadata(rows);

  const parentPath = canonicalDirectoryPath(draft.parentPath);
  const parentIndex = parentPath === root
    ? -1
    : rows.findIndex((row) => row.kind === 'node' && samePath(row.item.fullPath, parentPath));
  if (parentPath !== root && parentIndex < 0) return attachTreeSiblingMetadata(rows);

  const parentDepth = parentIndex < 0 ? -1 : rows[parentIndex].depth;
  const childDepth = parentDepth + 1;
  const rangeStart = parentIndex + 1;
  let rangeEnd = rows.length;
  for (let index = rangeStart; index < rows.length; index += 1) {
    if (rows[index].depth <= parentDepth) {
      rangeEnd = index;
      break;
    }
  }

  let insertionIndex = -1;
  for (let index = rangeStart; index < rangeEnd; index += 1) {
    const row = rows[index];
    if (
      row.kind === 'node'
      && row.depth === childDepth
      && samePath(row.parentPath, parentPath)
      && row.item.type === 'folder'
    ) {
      insertionIndex = index;
      break;
    }
  }

  if (insertionIndex < 0) insertionIndex = rangeStart;

  rows.splice(insertionIndex, 0, {
    kind: 'draft',
    key: `draft:${draft.requestId}`,
    draft,
    depth: childDepth,
    parentPath,
  });
  return attachTreeSiblingMetadata(rows);
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
  const [initialLoadPending, setInitialLoadPending] = useState(tree.loading);
  useEffect(() => {
    if (!tree.loading) setInitialLoadPending(false);
  }, [tree.loading]);
  const selectedFolderPath = useWorkColumnStore((state) => {
    const target = state.navigation.target;
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
  const agentRepositories = useMemo(
    () => getWorkspaceAgentRepositories(notebookId),
    [agentWorkspaceNotebook, notebookId],
  );
  const [showScrollTopHint, setShowScrollTopHint] = useState(false);
  const [repositoriesPageOpen, setRepositoriesPageOpen] = useState(false);
  const repositoriesPageRef = useRef<HTMLDivElement | null>(null);
  const repositoriesPageWasOpen = useRef(false);
  const interruptedRepositoriesTransform = useRef<string | null>(null);
  useLayoutEffect(() => {
    const page = repositoriesPageRef.current;
    if (!page) return;
    const wasOpen = repositoriesPageWasOpen.current;
    repositoriesPageWasOpen.current = repositoriesPageOpen;
    if (!repositoriesPageOpen && !wasOpen) {
      page.style.visibility = 'hidden';
      return;
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || typeof page.animate !== 'function') {
      page.style.transform = repositoriesPageOpen ? 'translateX(0)' : 'translateX(100%)';
      page.style.visibility = repositoriesPageOpen ? 'visible' : 'hidden';
      interruptedRepositoriesTransform.current = null;
      return;
    }
    const from = interruptedRepositoriesTransform.current
      ?? (wasOpen ? 'translateX(0)' : 'translateX(100%)');
    interruptedRepositoriesTransform.current = null;
    page.style.visibility = 'visible';
    const animation = page.animate(
      [{ transform: from }, { transform: repositoriesPageOpen ? 'translateX(0)' : 'translateX(100%)' }],
      // Keep in sync with --flowix-motion-duration / --flowix-motion-easing
      // in styles/index.css.
      { duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
    animation.onfinish = () => {
      page.style.visibility = repositoriesPageOpen ? 'visible' : 'hidden';
    };
    return () => {
      if (animation.playState === 'running') {
        interruptedRepositoriesTransform.current = window.getComputedStyle(page).transform;
      }
      animation.onfinish = null;
      animation.cancel();
    };
  }, [repositoriesPageOpen]);
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
    ignoreCollectionPathEvents: tree.ignoreCollectionPathEvents,
  });
  const {
    openNewTableDialog, openNewMediaLibraryDialog, handleCreateMediaLibraryAtPath,
    openNewWorkDocumentsDialog, creationDialog,
  } = useNotebookTreeCreation({ notebookId, notebookPath, defaultCreateFolder, refreshTables, refreshMediaLibraries, refreshWorkDocumentCollections });
  const viewTableDocuments = useMemo(() => tableDocuments.filter((table) => table.inViews), [tableDocuments]);
  const viewMediaLibraries = useMemo(() => mediaLibraries.filter((library) => library.inViews), [mediaLibraries]);
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
  const viewWorkDocuments = useMemo(() => workDocumentCollections.filter((collection) =>
    collection.inViews && collection.parseState === 'valid' && !collection.identityConflict && collection.collectionId,
  ), [workDocumentCollections]);
  const setWorkDocumentsInViews = useCallback(async (collectionId: string, inViews: boolean) => {
    if (!notebookId) return;
    try {
      await collections.setInViews(notebookId, collectionId, inViews);
      await refreshWorkDocumentCollections();
    } catch (error) {
      logger.warn('failed to update work documents view membership', { error, notebookId, collectionId });
      toast.error(t('multidimensionalTable.viewMembership.saveFailed'));
    }
  }, [notebookId, refreshWorkDocumentCollections, t]);
  const workDocumentsViewVisibilityByPath = useMemo(() => new Map([...workDocumentCollectionByPath].flatMap(([path, collection]) => {
    const collectionId = collection.collectionId;
    return collectionId ? [[path, {
      inViews: collection.inViews,
      disabled: collection.identityConflict || collection.parseState !== 'valid',
      onChange: (inViews: boolean) => { void setWorkDocumentsInViews(collectionId, inViews); },
    }] as const] : [];
  })), [setWorkDocumentsInViews, workDocumentCollectionByPath]);
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [viewsCollapsed, setViewsCollapsed] = useState(false);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [fileTreeSort, setFileTreeSort] = useState<FolderTreeSort>('createdAt');
  const [repositorySectionHeight, setRepositorySectionHeight] = useState(0);
  const [moreSectionHeight, setMoreSectionHeight] = useState(0);
  const {
    sectionOrder,
    hiddenSections,
    pinnedFolders,
    updateSections,
    updatePinnedFolders,
  } = useNotebookTreeSections(notebookId, isActive);
  const customizePanelRef = useRef<NotebookTreeCustomizePanelHandle>(null);
  const openCustomizeDisplay = useCallback((rect: DOMRect) => customizePanelRef.current?.open(rect), []);
  const [agentSectionHeight, setAgentSectionHeight] = useState(0);
  const [draft, setDraft] = useState<NotebookTreeDraftState | null>(null);
  const treeScrollerRef = useRef<HTMLDivElement | null>(null);
  const treeRootRef = useRef<HTMLDivElement | null>(null);
  const externalDropSurfaceRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isActive) return;
    if (notebookId) void loadNotebookFilters(notebookId);
  }, [isActive, loadNotebookFilters, notebookId]);

  const visibleSectionOrder = useMemo(() => sectionOrder.filter((section) => (
    !hiddenSections.includes(section) && (section === 'files'
    || section === 'repositories'
    || section === 'more'
    || (section === 'agents' && Boolean(notebookId) && agentSectionHeight > 0)
    || (section === 'pinned' && (pinnedItems.length > 0 || pinnedHasPrevious || pinnedHasMore))
    || section === 'views')
  )), [agentSectionHeight, hiddenSections, notebookId, pinnedHasMore, pinnedHasPrevious, pinnedItems.length, sectionOrder]);

  const moveTreeSection = useCallback((section: NotebookTreeSection, direction: -1 | 1) => {
    if (!notebookId) return;
    const visibleIndex = visibleSectionOrder.indexOf(section);
    const targetSection = visibleSectionOrder[visibleIndex + direction];
    if (visibleIndex < 0 || !targetSection) return;
    const index = sectionOrder.indexOf(section);
    const targetIndex = sectionOrder.indexOf(targetSection);
    const next = [...sectionOrder];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    updateSections(next, hiddenSections);
  }, [notebookId, sectionOrder, visibleSectionOrder, hiddenSections, updateSections]);
  const hideTreeSection = useCallback((section: NotebookTreeSection) => {
    if (!notebookId || hiddenSections.includes(section)) return;
    updateSections(sectionOrder, [...hiddenSections, section]);
  }, [hiddenSections, notebookId, sectionOrder, updateSections]);
  const treeHeaderRef = useRef<HTMLDivElement | null>(null);
  const handledFolderRequestIdRef = useRef<number | null>(null);
  const cancelledDraftRequestIdRef = useRef<number | null>(null);
  const submittingDraftRef = useRef(false);
  const draftInputRef = useRef<HTMLInputElement | null>(null);
  const [keptAlivePaths, setKeptAlivePaths] = useState<Set<string>>(() => new Set());
  const { rootChildren, nodes, expanded } = tree;
  const pinnedFolderFullPaths = useMemo(() => pinnedFolders.flatMap((path) => {
    const fullPath = joinNotebookMemoPath(notebookPath, path);
    return fullPath ? [canonicalDirectoryPath(fullPath)] : [];
  }), [notebookPath, pinnedFolders]);
  const pinnedFolderPathSet = useMemo(() => new Set(pinnedFolderFullPaths), [pinnedFolderFullPaths]);
  // Loading/error flags and controller callbacks do not change tree topology.
  const loadedTreeItems = useMemo(
    () => flattenLoadedTree({ rootChildren, nodes }),
    [rootChildren, nodes],
  );
  const visibleTreeItems = useMemo(
    () => flattenVisibleTree({ rootChildren, nodes, expanded }, fileTreeSort, pinnedFolderFullPaths),
    [rootChildren, nodes, expanded, fileTreeSort, pinnedFolderFullPaths],
  );
  const renderRows = useMemo(
    () => buildNotebookTreeRenderRows(visibleTreeItems, notebookPath, draft),
    [draft, notebookPath, visibleTreeItems],
  );
  const moreSectionPosition = visibleSectionOrder.indexOf('more');
  const moreCompactTopSpacing = moreSectionPosition > 0
    && visibleSectionOrder[moreSectionPosition - 1] === 'repositories';
  const pinnedSectionHeight = pinnedItems.length > 0 || pinnedHasPrevious || pinnedHasMore
    ? TREE_HEADER_HEIGHT + (pinnedCollapsed ? 0 : pinnedItems.length * TREE_ROW_SIZE + (pinnedHasPrevious || pinnedHasMore ? TREE_ROW_SIZE : 0)) + 12
    : 0;
  const viewsSectionHeight = TREE_HEADER_HEIGHT + (viewsCollapsed ? 0 : (viewTableDocuments.length + viewMediaLibraries.length) * TREE_ROW_SIZE) + 12;
  const sectionHeights: Record<NotebookTreeSection, number> = {
    agents: notebookId ? agentSectionHeight : 0,
    pinned: pinnedSectionHeight,
    views: viewsSectionHeight,
    files: TREE_HEADER_HEIGHT,
    repositories: repositorySectionHeight,
    more: moreSectionHeight - (moreCompactTopSpacing ? 10 : 0),
  };
  const treeContentOffset = TREE_HEADER_HEIGHT + sectionOrder
    .slice(0, sectionOrder.indexOf('files'))
    .reduce((height, section) => height + (hiddenSections.includes(section) ? 0 : sectionHeights[section]), 0);
  const handleAgentSectionHeightChange = useCallback((height: number) => {
    setAgentSectionHeight((current) => current === height ? current : height);
  }, []);
  const handleShowAllAgentConversations = useCallback(() => {
    useNoteStore.getState().setMiddleColumnView('conversations');
  }, []);
  const handleRepositorySectionHeightChange = useCallback((height: number) => {
    setRepositorySectionHeight((current) => current === height ? current : height);
  }, []);
  const renderRowIndexByPath = useMemo(() => new Map(
    renderRows.flatMap((row, index) => row.kind === 'node'
      ? [[canonicalPath(row.item.fullPath), index] as const]
      : []),
  ), [renderRows]);
  const treeItemByPath = useMemo(
    () => new Map([...pinnedItems, ...loadedTreeItems].map((item) => [canonicalPath(item.fullPath), item] as const)),
    [loadedTreeItems, pinnedItems],
  );
  const treeItemPaths = useMemo(() => new Set(treeItemByPath.keys()), [treeItemByPath]);
  const openMediaLibraryPath = useCallback((
    path: string,
    host: 'main-third' | 'browser-column',
  ) => {
    const mediaLibrary = mediaLibraryByPath.get(canonicalPath(path));
    if (!mediaLibrary || !notebookId) return false;
    void openWorkspaceSurface({
      host,
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
    if (!openMediaLibraryPath(path, 'main-third')) onNoteSelect(path);
  }, [openMediaLibraryPath, onNoteSelect]);
  const {
    focusedTreePath,
    setFocusedTreePath,
    selectedFilePaths,
    selectedFilePathSet,
    updateSelection,
    getSelectionAnchorPath,
    setNavigationPolicy,
    navigateToNote,
    activeFileShouldReveal,
    treeFocusPath,
    handleTreeItemKeyDown,
    selectNote,
  } = useNotebookTreeInteraction({
    activeFilePath,
    visibleTreeItems,
    treeItemPaths,
    contentKinds: selectionContentKinds,
    pinnedDocumentPaths: pinnedItems.map((item) => item.fullPath),
    tree,
    treeRootRef,
    treeScrollerRef,
    renderRowIndexByPath,
    treeContentOffset,
    isActive,
    activeFileRevealRatio,
    onNoteSelect: openSelectedDocument,
  });
  const {
    dragOverFolderPath,
    dragPreview,
    dragPreviewRef,
    dragPreviewPositionRef,
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
  const getRenderRowKey = useCallback((row: NotebookTreeRenderRow) => row.key, []);
  const estimateRenderRowSize = useCallback(() => TREE_ROW_SIZE, []);
  const keepAliveKeys = useMemo(() => {
    const keys = [...keptAlivePaths].map((path) => 'node:' + canonicalPath(path));
    if (focusedTreePath) keys.push('node:' + canonicalPath(focusedTreePath));
    if (draft) keys.push('draft:' + draft.requestId);
    return keys;
  }, [draft, focusedTreePath, keptAlivePaths]);
  const {
    totalSize: virtualTreeSize,
    virtualItems: virtualTreeRows,
  } = useDynamicVirtualList({
    items: renderRows,
    getKey: getRenderRowKey,
    estimateSize: estimateRenderRowSize,
    scrollerRef: treeScrollerRef,
    enabled: !filesCollapsed,
    resetKey: notebookPath,
    overscan: TREE_VIRTUAL_OVERSCAN,
    keepAliveKeys,
    scrollMargin: treeContentOffset,
  });
  useEffect(() => {
    if (!draft) return;
    const index = renderRows.findIndex((row) => row.key === 'draft:' + draft.requestId);
    const scroller = treeScrollerRef.current;
    if (index < 0 || !scroller) return;
    const rowTop = treeContentOffset + index * TREE_ROW_SIZE;
    const rowBottom = rowTop + TREE_ROW_HEIGHT;
    if (rowTop < scroller.scrollTop) scroller.scrollTop = rowTop;
    else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, rowBottom - scroller.clientHeight);
    }
  }, [draft, renderRows, treeContentOffset]);
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
  const hasVisibleItems = tree.rootChildren.length > 0;
  const isRootDropTarget = dragOverFolderPath !== null
    && canonicalDirectoryPath(dragOverFolderPath) === canonicalDirectoryPath(notebookPath);
  const expandToRef = useRef(tree.expandTo);
  expandToRef.current = tree.expandTo;

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
    if (!isActive || !activeFilePath || !activeFileShouldReveal || tree.loading) return;
    void expandToRef.current(activeFilePath);
  }, [activeFileShouldReveal, activeFilePath, isActive, tree.loading]);

  useEffect(() => {
    if (!createFolderRequest || handledFolderRequestIdRef.current === createFolderRequest.id) return;
    handledFolderRequestIdRef.current = createFolderRequest.id;
    void tree.expandTo(`${createFolderRequest.parentPath}/__new-folder__`);
    setDraft({
      requestId: createFolderRequest.id,
      parentPath: createFolderRequest.parentPath,
      value: '',
    });
  }, [createFolderRequest, tree.expandTo]);

  const submitDraft = useCallback(async () => {
    if (!draft) return;
    if (cancelledDraftRequestIdRef.current === draft.requestId) {
      cancelledDraftRequestIdRef.current = null;
      return;
    }
    if (submittingDraftRef.current) return;
    submittingDraftRef.current = true;
    const { parentPath, value } = draft;
    const name = value.trim();
    if (!name) {
      setDraft(null);
      submittingDraftRef.current = false;
      return;
    }
    try {
      await files.createFolder(parentPath, name);
      await tree.refresh(parentPath);
      setDraft(null);
    } catch (error) {
      // 失焦触发的提交已把焦点交给点击处, 失败时把光标还给输入框并全选文本。
      toast.error(t(fileTreeCreateFailureKey(error)));
      draftInputRef.current?.focus();
      draftInputRef.current?.select();
    } finally {
      submittingDraftRef.current = false;
    }
  }, [draft, t, tree.refresh]);

  const cancelDraft = useCallback(() => {
    if (!draft) return;
    cancelledDraftRequestIdRef.current = draft.requestId;
    setDraft(null);
  }, [draft]);

  const requestCreateFolderDraft = useCallback((parentPath: string) => {
    void tree.expandTo(`${parentPath}/__new-folder__`);
    setDraft({ requestId: Date.now(), parentPath, value: '' });
  }, [tree.expandTo]);

  const handleRename = useNotebookTreeRename({ notebookId, notebookPath, tree, tableDocumentByPath, mediaLibraryByPath });

  const { deleteItem: handleDeleteTableDocument, renameTable: handleRenameTableDocument, visibilityByPath: tableViewVisibilityByPath } = useNotebookViewActions({
    kind: 'table', notebookId, notebookPath, itemsByPath: tableDocumentByPath,
    refresh: refreshTables, updateIdentity: updateTableIdentity, onDeleteFile,
  });
  const { deleteItem: handleDeleteMediaLibrary, visibilityByPath: mediaLibraryViewVisibilityByPath } = useNotebookViewActions({
    kind: 'media-library', notebookId, notebookPath, itemsByPath: mediaLibraryByPath,
    refresh: refreshMediaLibraries, updateIdentity: updateMediaLibraryIdentity, onDeleteFile,
  });

  const handleTogglePath = useCallback((path: string) => {
    if (shouldSuppressOpenPath(path)) return;
    tree.toggle(path);
  }, [shouldSuppressOpenPath, tree.toggle]);
  const handleOpenPath = useCallback((path: string, event?: ReactMouseEvent<HTMLDivElement>) => {
    if (shouldSuppressOpenPath(path)) return;
    selectNote(path, event);
  }, [selectNote, shouldSuppressOpenPath]);
  const handleOpenPinnedPath = useCallback((path: string, event?: ReactMouseEvent<HTMLDivElement>) => {
    if (shouldSuppressOpenPath(path)) return;
    selectNote(path, event, 'pinned');
  }, [selectNote, shouldSuppressOpenPath]);
  const handleDeleteSelected = useCallback(async () => {
    const failedPaths: string[] = [];
    for (const path of selectedFilePaths) {
      try {
        const item = treeItemByPath.get(canonicalPath(path));
        if (!item) throw new Error('Selected document is no longer loaded');
        if (item.resourceKind === 'note' || /\.(md|markdown)$/i.test(item.name)) {
          const saved = await saveWorkspaceDocumentPath(
            documentIdentityFromFile(ensureFileDisplayIdentity(path)), path, notebookPath,
          );
          if (!saved) throw new Error('Could not save selected document');
          await noteRepository.delete(path);
        } else {
          if (!onDeleteFile || await onDeleteFile(item, { silent: true }) === false) {
            throw new Error('Could not delete selected document');
          }
        }
      } catch (error) {
        failedPaths.push(path);
        logger.warn('batch document deletion failed', { error, path });
      }
    }
    updateSelection(failedPaths, failedPaths[0] ?? null);
    useNoteStore.getState().triggerRefresh();
    const message = t('memo.fileTree.deleteSelectedResult', {
      deleted: selectedFilePaths.length - failedPaths.length, failed: failedPaths.length,
    });
    if (failedPaths.length > 0) toast.error(message);
    else toast.success(message);
  }, [selectedFilePaths, treeItemByPath, notebookPath, onDeleteFile, t, updateSelection]);

  const { openRepositoryFileInBrowser, openRepositoryFileInWork } = useRepositoryFileOpen();
  const handleOpenTableDocument = useCallback((relativePath: string) => {
    const path = joinNotebookMemoPath(notebookPath, relativePath);
    if (!path) return;
    setNavigationPolicy(path, 'preserve');
    void openWorkspaceSurface({
      host: 'main-third',
      target: { kind: 'external', path, scopePath: notebookPath, transitionId: null },
      options: { notebookId },
    }).catch((error) => {
      logger.warn('failed to open table document', { error, path });
      toast.error(t('memo.fileTree.openFailed'));
    });
  }, [notebookId, notebookPath, setNavigationPolicy, t]);
  const handleOpenMediaLibraryFromViews = useCallback((path: string) => {
    updateSelection([], null);
    navigateToNote(path, 'preserve');
  }, [navigateToNote, updateSelection]);
  const handleOpenWorkDocumentsFromViews = useCallback((path: string) => {
    if (!notebookId) return;
    setNavigationPolicy(path, 'preserve');
    void openWorkspaceSurface({
      host: 'main-third',
      target: { kind: 'external', path, scopePath: notebookPath, transitionId: null },
      options: { notebookId },
    }).catch((error) => {
      logger.warn('failed to open work documents from Views', { error, path });
      toast.error(t('memo.fileTree.openFailed'));
    });
  }, [notebookId, notebookPath, setNavigationPolicy, t]);
  const handleRetryDirectory = useCallback((path: string) => {
    void tree.retryDirectory?.(path);
  }, [tree.retryDirectory]);
  const handleTogglePinnedFolder = useCallback(async (folderPath: string) => {
    if (!notebookId) return;
    const relativePath = notebookRelativeDirectoryPath(notebookPath, folderPath);
    if (relativePath === null || relativePath === '') return;
    const key = canonicalPath(relativePath);
    try {
      await updatePinnedFolders((paths) => (
        paths.some((path) => canonicalPath(path) === key)
          ? paths.filter((path) => canonicalPath(path) !== key)
          : [relativePath, ...paths]
      ));
    } catch {
      toast.error(t('memo.fileTree.pinnedFolderSaveFailed'));
    }
  }, [notebookId, notebookPath, t, updatePinnedFolders]);
  const removePinnedFolderSubtree = useCallback(async (folderPath: string) => {
    const relativePath = notebookRelativeDirectoryPath(notebookPath, folderPath);
    if (relativePath === null || relativePath === '') return;
    const key = canonicalPath(relativePath);
    try {
      await updatePinnedFolders((paths) => {
        const next = paths.filter((path) => {
          const candidate = canonicalPath(path);
          return candidate !== key && !candidate.startsWith(`${key}/`);
        });
        return next.length === paths.length ? null : next;
      });
    } catch {
      toast.error(t('memo.fileTree.pinnedFolderSaveFailed'));
    }
  }, [notebookPath, t, updatePinnedFolders]);
  const handleCreateViewAtPath = useCallback((parentPath: string, viewType?: TableViewType) => {
    openNewTableDialog(false, parentPath, viewType);
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
    if (openMediaLibraryPath(path, 'browser-column')) return;
    onNoteOpenInNewTab?.(path);
  }, [onNoteOpenInNewTab, openMediaLibraryPath]);
  const handleCreateNoteAtPath = useCallback((parentPath: string) => {
    void createNoteAtPath(parentPath);
  }, [createNoteAtPath]);
  const handleCreateFolderAtPath = useCallback((parentPath: string) => {
    requestCreateFolderDraft(parentPath);
  }, [requestCreateFolderDraft]);
  const handleFocusPath = useCallback((path: string) => setFocusedTreePath(path), []);
  const handleDeleteFolderPath = useCallback(async (path: string) => {
    const deleted = await onDeleteFolder?.(path);
    if (deleted !== false) await removePinnedFolderSubtree(path);
  }, [onDeleteFolder, removePinnedFolderSubtree]);
  const renderDraft = (draftState: NotebookTreeDraftState, depth: number) => (
    <NotebookTreeDraft
      draft={draftState}
      depth={depth}
      data-notebook-tree-depth={depth}
      inputRef={draftInputRef}
      onChange={(value) => setDraft({ ...draftState, value })}
      onSubmit={() => void submitDraft()}
      onCancel={cancelDraft}
    />
  );

  const handleImportFiles = useCallback(async (targetDirectoryPath: string) => {
    const selectedPaths = await dialogs.selectFiles({ multiple: true });
    if (!selectedPaths?.length) return;
    const failures: NotebookMoveFailure[] = [];
    for (const sourcePath of selectedPaths) {
      try {
        await files.importFile(sourcePath, targetDirectoryPath, notebookPath);
      } catch (error) {
        logger.warn('importing file into notebook tree failed', { error, sourcePath, targetDirectoryPath });
        failures.push(normalizeNotebookMoveFailure(error));
      }
    }
    await tree.refresh(targetDirectoryPath);
    if (failures.length > 0) {
      showNotebookMoveFailureToasts(
        t,
        selectedPaths.length - failures.length,
        failures.length,
        failures,
      );
    }
  }, [notebookPath, t, tree.refresh]);

  const handleImportFolder = useCallback(async (targetDirectoryPath: string) => {
    let sourceDirectoryPath: string | null | undefined;
    let progressToastId: string | number | undefined;
    try {
      sourceDirectoryPath = await dialogs.selectImportDirectory();
      if (!sourceDirectoryPath) return;
      progressToastId = toast.info(t('memo.fileTree.importFolderInProgress'), { duration: Number.POSITIVE_INFINITY });
      await files.importFolder(sourceDirectoryPath, targetDirectoryPath, notebookPath);
      await tree.refresh(targetDirectoryPath);
      toast.dismiss(progressToastId);
      progressToastId = undefined;
      toast.success(t('memo.fileTree.importFolderSuccess'));
    } catch (error) {
      logger.warn('importing folder into notebook tree failed', { error, sourceDirectoryPath, targetDirectoryPath });
      if (sourceDirectoryPath) {
        try {
          await tree.refresh(targetDirectoryPath);
        } catch (refreshError) {
          logger.warn('refreshing notebook tree after folder import failed', { refreshError, targetDirectoryPath });
        }
      }
      toast.error(t(getNotebookFolderImportErrorKey(error)));
    } finally {
      if (progressToastId !== undefined) toast.dismiss(progressToastId);
    }
  }, [notebookPath, t, tree.refresh]);

  const renderTreeItem = (
    item: DocTreeItem,
    depth: number,
    logicalParentPath: string,
    posInSet?: number,
    setSize?: number,
  ) => {
    const itemPath = canonicalPath(item.fullPath);
    const tableViewVisibility = tableViewVisibilityByPath.get(itemPath);
    const mediaLibraryViewVisibility = mediaLibraryViewVisibilityByPath.get(itemPath);
    const expanded = item.type === 'folder' && tree.expanded.has(canonicalPath(item.fullPath));
    const isDropTarget = item.type === 'folder'
      && dragOverFolderPath !== null
      && canonicalDirectoryPath(item.fullPath) === canonicalDirectoryPath(dragOverFolderPath);
    const isMovingTarget = item.type === 'folder'
      && moveFeedback !== null
      && samePath(item.fullPath, moveFeedback.targetDirectoryPath);
    const isMovingSource = moveFeedback !== null
      && moveFeedback.paths.some((path) => samePath(path, item.fullPath));
    const moveStatus = isMovingTarget || isMovingSource ? moveFeedback?.status : undefined;

    return (
      <div
        className={cn(
          item.type === 'folder' && 'folder-file-tree__group notebook-file-tree__folder-group relative',
        )}
        data-notebook-tree-row="true"
        data-notebook-tree-depth={depth}
        data-drag-over={isDropTarget ? 'true' : 'false'}
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
          expanded={expanded}
          isLoadingChildren={tree.loadingDirectories?.has(canonicalDirectoryPath(item.fullPath)) ?? false}
          childrenError={tree.directoryErrors?.has(canonicalDirectoryPath(item.fullPath)) ?? false}
          onRetryChildren={handleRetryDirectory}
          active={item.type === 'folder'
            ? Boolean(selectedFolderPath) && canonicalPath(item.fullPath) === canonicalPath(selectedFolderPath!)
            : !selectedFolderPath && Boolean(activeFilePath) && canonicalPath(item.fullPath) === canonicalPath(activeFilePath!)}
          selected={item.type === 'document' && selectedFilePathSet.has(canonicalPath(item.fullPath))}
          onDeleteSelected={item.type === 'document' && selectedFilePaths.length > 1 && selectedFilePathSet.has(canonicalPath(item.fullPath)) ? handleDeleteSelected : undefined}
          moveStatus={moveStatus}
          onToggle={handleTogglePath}
          onSelectFolder={onFolderSelect}
          onOpen={handleOpenPath}
          onOpenInNewTab={onNoteOpenInNewTab ? handleOpenPathInNewTab : undefined}
          onCreateNote={handleCreateNoteAtPath}
          onCreateFolder={handleCreateFolderAtPath}
          onImportFiles={handleImportFiles}
          onImportFolder={handleImportFolder}
          onCreateView={handleCreateViewAtPath}
          onCreateMediaLibrary={handleCreateMediaLibraryAtPath}
          onCreateWorkDocuments={openNewWorkDocumentsDialog}
          tableViewVisibility={tableViewVisibility}
          mediaLibraryViewVisibility={mediaLibraryViewVisibility}
          workDocumentsCollection={workDocumentCollectionByPath.has(itemPath)}
          workDocumentsViewVisibility={workDocumentsViewVisibilityByPath.get(itemPath)}
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

  return (
    <div
      onPointerMove={handleTreePointerMove}
      onPointerUp={handleTreePointerUp}
      onPointerCancel={handleTreePointerCancel}
      ref={externalDropSurfaceRef}
      data-notebook-external-drop-target="true"
      className={cn(
        'relative flex h-full min-h-0 flex-col select-none bg-[var(--list-bg)] text-[var(--foreground)]',
        dragPreview && 'notebook-file-tree--dragging',
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
              notebookId={notebookId}
              edgeGutter={TREE_EDGE_GUTTER}
              order={sectionOrder.indexOf('agents') + 1}
              onHeightChange={handleAgentSectionHeightChange}
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
          {(pinnedItems.length > 0 || pinnedHasPrevious || pinnedHasMore) && !hiddenSections.includes('pinned') && (
            <NotebookPinnedSection
              order={sectionOrder.indexOf('pinned') + 1}
              items={pinnedItems}
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
              renderItem={(item) => (
                <NotebookTreeRow
                  key={item.fullPath}
                  item={item}
                  notebookPath={notebookPath}
                  parentPath={parentDirectoryPath(item.fullPath, notebookPath)}
                  depth={0}
                  expanded={false}
                  active={!selectedFolderPath && Boolean(activeFilePath) && samePath(item.fullPath, activeFilePath!)}
                  selected={selectedFilePathSet.has(canonicalPath(item.fullPath))}
                  onDeleteSelected={selectedFilePaths.length > 1 && selectedFilePathSet.has(canonicalPath(item.fullPath)) ? handleDeleteSelected : undefined}
                  onToggle={handleTogglePath}
                  onOpen={handleOpenPinnedPath}
                  onOpenInNewTab={onNoteOpenInNewTab ? handleOpenPathInNewTab : undefined}
                  onCreateNote={handleCreateNoteAtPath}
                  onCreateFolder={handleCreateFolderAtPath}
                  onImportFiles={(path) => { void handleImportFiles(path); }}
                  onImportFolder={(path) => { void handleImportFolder(path); }}
                  onCreateView={(parentPath, viewType) => openNewTableDialog(false, parentPath, viewType)}
                  onCreateMediaLibrary={(parentPath) => openNewMediaLibraryDialog(false, parentPath)}
                  onCreateWorkDocuments={(parentPath) => openNewWorkDocumentsDialog(parentPath)}
                  onRename={handleRename}
                  onDeleteFile={onDeleteFile}
                  onPointerDown={handlePointerDownItem}
                  onKeepAliveChange={handleRowKeepAliveChange}
                  workDocumentsCollection={workDocumentCollectionByPath.has(canonicalPath(item.fullPath))}
                  workDocumentsViewVisibility={workDocumentsViewVisibilityByPath.get(canonicalPath(item.fullPath))}
                  favoritePath={item.fullPath}
                  onFavoriteChanged={(itemId, favorited) => {
                    if (!favorited) removePinnedItem(itemId);
                  }}
                  tabIndex={0}
                />
              )}
            />
          )}
          {!hiddenSections.includes('views') && (
            <NotebookViewsSection
              order={sectionOrder.indexOf('views') + 1}
              tables={viewTableDocuments}
              mediaLibraries={viewMediaLibraries}
              workDocuments={viewWorkDocuments}
              collapsed={viewsCollapsed}
              onToggleCollapsed={() => setViewsCollapsed((collapsed) => !collapsed)}
              onHideSection={() => hideTreeSection('views')}
              sectionActions={(
                <NotebookTreeSectionMenu
                  onHideSection={() => hideTreeSection('views')}
                  canMoveUp={visibleSectionOrder.indexOf('views') > 0}
                  canMoveDown={visibleSectionOrder.indexOf('views') < visibleSectionOrder.length - 1}
                  onMoveUp={() => moveTreeSection('views', -1)}
                  onMoveDown={() => moveTreeSection('views', 1)}
                  onCreateTable={(viewType) => openNewTableDialog(true, undefined, viewType)}
                  onCreateMediaLibrary={() => openNewMediaLibraryDialog(true)}
                  onCreateWorkDocuments={() => openNewWorkDocumentsDialog()}
                  onCustomizeDisplay={openCustomizeDisplay}
                />
              )}
              renderTable={(table) => {
                const tablePath = joinNotebookMemoPath(notebookPath, table.relativePath);
                if (!tablePath) return null;
                const active = Boolean(!selectedFolderPath && activeFilePath && samePath(activeFilePath, tablePath));
                const tableItem = tableDocumentTreeItem(table, tablePath);
                return (
                  <NotebookTreeRow
                    key={table.relativePath}
                    item={tableItem}
                    notebookPath={notebookPath}
                    parentPath={parentDirectoryPath(tablePath, notebookPath)}
                    depth={0}
                    expanded={false}
                    active={active}
                    selected={active}
                    onToggle={() => {}}
                    onOpen={() => handleOpenTableDocument(table.relativePath)}
                    onOpenInNewTab={onNoteOpenInNewTab ? handleOpenPathInNewTab : undefined}
                    onCreateNote={handleCreateNoteAtPath}
                    onCreateFolder={handleCreateFolderAtPath}
                    onCreateView={(parentPath, viewType) => openNewTableDialog(true, parentPath, viewType)}
                    onCreateMediaLibrary={(parentPath) => openNewMediaLibraryDialog(true, parentPath)}
                    onCreateWorkDocuments={(parentPath) => openNewWorkDocumentsDialog(parentPath)}
                    tableViewVisibility={tableViewVisibilityByPath.get(canonicalPath(tablePath))}
                    onRename={handleRenameTableDocument}
                    onDeleteFile={handleDeleteTableDocument}
                    onPointerDown={handlePointerDownItem}
                    onFocus={handleFocusPath}
                    tabIndex={0}
                  />
                );
              }}
              renderWorkDocuments={(collection) => {
                const collectionPath = joinNotebookMemoPath(notebookPath, collection.relativePath);
                if (!collectionPath) return null;
                const active = Boolean(!selectedFolderPath && activeFilePath && samePath(activeFilePath, collectionPath));
                return (
                  <NotebookTreeRow
                    key={collection.relativePath}
                    item={workDocumentsTreeItem(collection, collectionPath)}
                    notebookPath={notebookPath}
                    parentPath={parentDirectoryPath(collectionPath, notebookPath)}
                    depth={0}
                    expanded={false}
                    active={active}
                    selected={active}
                    onToggle={() => {}}
                    onOpen={() => handleOpenWorkDocumentsFromViews(collectionPath)}
                    onOpenInNewTab={onNoteOpenInNewTab ? handleOpenPathInNewTab : undefined}
                    onCreateNote={handleCreateNoteAtPath}
                    onCreateFolder={handleCreateFolderAtPath}
                    onCreateView={(parentPath, viewType) => openNewTableDialog(true, parentPath, viewType)}
                    onCreateMediaLibrary={(parentPath) => openNewMediaLibraryDialog(true, parentPath)}
                    onCreateWorkDocuments={(parentPath) => openNewWorkDocumentsDialog(parentPath)}
                    workDocumentsCollection
                    workDocumentsViewVisibility={workDocumentsViewVisibilityByPath.get(canonicalPath(collectionPath))}
                    onRename={handleRename}
                    onDeleteFile={onDeleteFile}
                    onPointerDown={handlePointerDownItem}
                    onFocus={handleFocusPath}
                    tabIndex={0}
                  />
                );
              }}
              renderMediaLibrary={(library) => {
                const libraryPath = joinNotebookMemoPath(notebookPath, library.relativePath);
                if (!libraryPath) return null;
                const active = Boolean(!selectedFolderPath && activeFilePath && samePath(activeFilePath, libraryPath));
                const libraryItem = mediaLibraryTreeItem(library, libraryPath);
                return (
                  <NotebookTreeRow
                    key={library.relativePath}
                    item={libraryItem}
                    notebookPath={notebookPath}
                    parentPath={parentDirectoryPath(libraryPath, notebookPath)}
                    depth={0}
                    expanded={false}
                    active={active}
                    selected={active}
                    onToggle={() => {}}
                    onOpen={() => handleOpenMediaLibraryFromViews(libraryPath)}
                    onOpenInNewTab={onNoteOpenInNewTab ? handleOpenPathInNewTab : undefined}
                    onCreateNote={handleCreateNoteAtPath}
                    onCreateFolder={handleCreateFolderAtPath}
                    onCreateView={(parentPath, viewType) => openNewTableDialog(true, parentPath, viewType)}
                    onCreateMediaLibrary={(parentPath) => openNewMediaLibraryDialog(true, parentPath)}
                    onCreateWorkDocuments={(parentPath) => openNewWorkDocumentsDialog(parentPath)}
                    mediaLibraryViewVisibility={mediaLibraryViewVisibilityByPath.get(canonicalPath(libraryPath))}
                    onRename={handleRename}
                    onDeleteFile={handleDeleteMediaLibrary}
                    onPointerDown={handlePointerDownItem}
                    onFocus={handleFocusPath}
                    tabIndex={0}
                  />
                );
              }}
            />
          )}
          {!hiddenSections.includes('files') && <section
            className="flex min-h-0 flex-col pb-3"
            aria-label={t('memo.fileTree.sectionTitle')}
            data-notebook-files-section="true"
            style={{
              order: sectionOrder.indexOf('files') + 1,
              flexGrow: visibleSectionOrder[visibleSectionOrder.length - 1] === 'files' ? 1 : 0,
            }}
          >
          <div
            ref={treeHeaderRef}
            className={cn(
              'notebook-file-tree__section-header group mb-0.5 flex h-7 shrink-0 items-center gap-1 rounded-lg px-1.5 transition-colors duration-150 hover:bg-[var(--muted)]',
              isRootDropTarget && 'bg-[color-mix(in_oklch,var(--brand)_10%,transparent)]',
            )}
            style={{
              marginLeft: TREE_EDGE_GUTTER,
              width: `calc(100% - ${TREE_EDGE_GUTTER * 2}px)`,
            }}
          >
            <button
              type="button"
              className="flex h-full items-center gap-0.5 text-[0.82rem] font-medium text-[var(--muted-foreground)] opacity-90 hover:text-[var(--foreground)] focus-visible:outline-none"
              aria-label={t(filesCollapsed ? 'memo.fileTree.expandFiles' : 'memo.fileTree.collapseFiles')}
              title={t(filesCollapsed ? 'memo.fileTree.expandFiles' : 'memo.fileTree.collapseFiles')}
              onClick={() => setFilesCollapsed((collapsed) => !collapsed)}
            >
              <span>{t('memo.fileTree.sectionTitle')}</span>
              <ChevronRight className={cn('h-3.5 w-3.5 opacity-0 transition-[opacity,transform] group-hover:opacity-100 group-focus-within:opacity-100', filesCollapsed && 'opacity-100', !filesCollapsed && 'rotate-90')} />
            </button>
            <div className="ml-auto flex items-center">
              <NotebookTreeSectionMenu
                onHideSection={() => hideTreeSection('files')}
                canMoveUp={visibleSectionOrder.indexOf('files') > 0}
                canMoveDown={visibleSectionOrder.indexOf('files') < visibleSectionOrder.length - 1}
                onMoveUp={() => moveTreeSection('files', -1)}
                onMoveDown={() => moveTreeSection('files', 1)}
                onCreateFolder={onCreateFolder}
                onCreateNote={() => { void createNoteAtPath(); }}
                onCreateTable={(viewType) => openNewTableDialog(false, undefined, viewType)}
                onCreateMediaLibrary={() => openNewMediaLibraryDialog()}
                onCreateWorkDocuments={() => openNewWorkDocumentsDialog()}
                onImportFiles={() => { void handleImportFiles(notebookPath); }}
                onImportFolder={() => { void handleImportFolder(notebookPath); }}
                sort={fileTreeSort}
                onSort={setFileTreeSort}
                onCustomizeDisplay={openCustomizeDisplay}
              />
            </div>
          </div>
              {!filesCollapsed && <div
            ref={treeRootRef}
            role="tree"
            aria-multiselectable="true"
            aria-label={notebookName}
            data-notebook-tree-root="true"
            style={{ minHeight: virtualTreeSize || TREE_ROW_HEIGHT }}
            className={cn(
              'relative min-h-0 flex-1 rounded-lg transition-colors duration-150',
              isRootDropTarget && 'bg-[color-mix(in_oklch,var(--brand)_10%,transparent)]',
            )}
          >
            {tree.error && (
              <div className="flex items-center justify-center gap-2 px-4 py-4 text-center text-xs text-[var(--muted-foreground)]" role="alert">
                <span>{t('memo.fileTree.unreadableHint')}</span>
                <Button type="button" size="xs" variant="ghost" className="rounded-lg" onClick={() => void tree.reload()}>
                  {t('error.retry')}
                </Button>
              </div>
            )}
            {!hasVisibleItems && !tree.loading && !tree.error && !draft && (
              <div className="px-4 py-6 text-center text-xs text-[var(--muted-foreground)]">
                {t('memo.fileTree.empty')}
              </div>
            )}
            <div
              className={cn(
                'notebook-file-tree__virtual-items relative min-h-full',
                hasVisibleItems && contentClassName,
              )}
              data-notebook-tree-virtualized="true"
              style={{ height: virtualTreeSize }}
            >
              {folderDropHighlight && (
                <div
                  aria-hidden="true"
                  className="notebook-file-tree__drop-range pointer-events-none absolute right-[6px] z-[1] rounded-lg bg-[color-mix(in_oklch,var(--brand)_15%,transparent)]"
                  style={folderDropHighlight}
                />
              )}
              {virtualTreeRows.map(({ key, item: row, start, size }) => (
                <div
                  key={key}
                  className="absolute inset-x-0 top-0 z-[2]"
                  data-notebook-virtual-row={key}
                  data-notebook-tree-row="true"
                  data-notebook-drop-path={row.kind === 'node' && row.item.type === 'folder'
                    ? row.item.fullPath
                    : undefined}
                  data-notebook-parent-path={row.parentPath}
                  style={{ height: size, transform: `translateY(${start}px)` }}
                >
                  {renderTreeRow(row)}
                </div>
              ))}
            </div>
          </div>}
          </section>}
          {!hiddenSections.includes('repositories') && (
            <AgentRepositoriesSection
              repositories={agentRepositories}
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
              onOpenFile={openRepositoryFileInBrowser}
              onOpenFileInMainColumn={openRepositoryFileInWork}
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
                onCreateTable={(viewType) => openNewTableDialog(false, notebookPath, viewType)}
                onCreateMediaLibrary={() => openNewMediaLibraryDialog(false, notebookPath)}
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
        {!hasVisibleItems && tree.loading && !(skipInitialLoading && initialLoadPending) && (
          <FileTreeLoadingSkeleton
            ariaLabel={t('memo.fileTree.loading')}
            className="absolute inset-0 z-[2] bg-[var(--list-bg)]"
          />
        )}
        {dragPreview && (
          <div
            aria-hidden="true"
            className="pointer-events-none fixed left-0 top-0 z-[100] flex h-8 max-w-[220px] items-center gap-1.5 rounded-lg border border-[var(--border-popup)] bg-[color-mix(in_oklch,var(--card)_88%,transparent)] px-2 text-sm text-[var(--foreground)] opacity-90 shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.35)] backdrop-blur-sm will-change-transform"
            ref={(node) => {
              dragPreviewRef.current = node;
              if (node) {
                const { x, y } = dragPreviewPositionRef.current;
                node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
              }
            }}
          >
            <NotebookTreeFileIcon className="notebook-file-tree__default-file-icon h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
            <span className="truncate">
              {dragPreview.count > 1 ? t('memo.fileTree.draggingNotes', { count: dragPreview.count }) : dragPreview.name}
            </span>
          </div>
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
      <div
        ref={repositoriesPageRef}
        className="sidebar-content-page sidebar-content-page--detail absolute inset-0 z-30 flex min-h-0 flex-col bg-[var(--list-bg)]"
        data-page-active={repositoriesPageOpen}
        inert={!repositoriesPageOpen}
        aria-hidden={!repositoriesPageOpen}
        aria-label={t('memo.fileTree.repositoriesTitle')}
      >
          <div className="flex items-center justify-between gap-2 px-3 pb-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <button type="button" onClick={() => setRepositoriesPageOpen(false)} aria-label={t('memo.navigation.backToFileTree')}
                title={t('memo.navigation.backToFileTree')}
                className="group flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-transparent p-0 text-sm text-[var(--foreground)] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]">
                <ChevronLeft className="h-4 w-4 transition-[filter] duration-150 group-hover:brightness-125" aria-hidden="true" />
              </button>
              <span className="text-sm font-medium">{t('memo.fileTree.repositoriesTitle')}</span>
              <span className="text-xs text-[var(--muted-foreground)]">{agentRepositories.length}</span>
            </div>
            <button type="button" onClick={() => { void handleAddRepository(); }} disabled={!notebookId}
              aria-label={t('agent.workspace.addRepository')} title={t('agent.workspace.addRepository')}
              className="group flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--card)] p-0 text-[var(--foreground)] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-40">
              <Plus className="h-3.5 w-3.5 transition-[filter] duration-150 group-hover:brightness-125" aria-hidden="true" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <AgentRepositoriesSection
              repositories={agentRepositories}
              order={1}
              onHeightChange={() => {}}
              onAddRepository={() => { void handleAddRepository(); }}
              onRemoveRepository={(repository) => { void handleRemoveRepository(repository); }}
              onExpandRepository={() => {}}
              canAddRepository={Boolean(notebookId)}
              onOpenFile={openRepositoryFileInBrowser}
              onOpenFileInMainColumn={openRepositoryFileInWork}
              hideSectionHeader
            />
          </div>
      </div>
    </div>
  );
}

function NotebookTreeDraft({
  draft,
  depth,
  onChange,
  onSubmit,
  onCancel,
  inputRef,
  style,
  'data-notebook-tree-depth': dataDepth,
}: {
  draft: { requestId: number; value: string };
  depth: number;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  style?: CSSProperties;
  'data-notebook-tree-depth'?: number;
}) {
  const { t } = useI18n();
  const draftInput = useComposingValue(draft.value, onChange);
  return (
    <div
      data-notebook-tree-depth={dataDepth}
      className="flex h-8 items-center px-1.5"
      style={{
        marginLeft: TREE_EDGE_GUTTER
          + depth * INDENT_PER_LEVEL,
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        data-notebook-tree-draft-icon="folder"
        className="relative flex h-[18px] w-[18px] shrink-0 items-center justify-center text-[var(--brand)]"
      >
        <span
          className="absolute inset-0 flex items-center justify-center"
          dangerouslySetInnerHTML={{ __html: folderIcon }}
        />
      </span>
      <input
        key={draft.requestId}
        ref={inputRef}
        autoFocus
        value={draftInput.value}
        placeholder={t('memo.fileTree.newFolder')}
        onChange={draftInput.onChange}
        onCompositionStart={draftInput.onCompositionStart}
        onCompositionEnd={draftInput.onCompositionEnd}
        onBlur={onSubmit}
        onKeyDown={(event) => {
          if (draftInput.isComposingKeyboardEvent(event.nativeEvent)) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            onSubmit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        className="ml-1.5 h-5 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm outline-none"
      />
    </div>
  );
}
