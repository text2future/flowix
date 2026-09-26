'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { File } from 'lucide-react';
import { FolderPlus } from 'lucide-react';

import {
  canonicalDirectoryPath,
  canonicalPath,
  parentDirectoryPath,
  pathInDirectory,
  samePath,
  uniquePaths,
} from '@/lib/path';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { cn, displayTitleFromFilename } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useComposingValue } from '@shared/hooks/use-composing-value';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { FileTypeIcon } from '@features/memo/components/file-type-icon';
import { useMemoStore } from '@features/memo/store/memo-store';
import { useDocumentStore } from '@features/document/store';
import {
  elementFromExternalDropPosition,
  EXTERNAL_FILE_DROP_EVENT,
  type ExternalDropPosition,
  type ExternalFileDropDetail,
} from '@features/document/components/use-markdown-file-drop';
import { resolveMemoByPath } from '@features/memo/use-cases/open-by-target';
import folderIcon from '@/assets/folder-outline.svg?raw';
import {
  flattenLoadedTree,
  flattenVisibleTree,
  type FolderTreeController,
} from '@features/memo/components/use-folder-tree';
import { NotebookTreeRow } from '@features/memo/components/notebook-tree-row';
import { files, memos, type DocTreeItem, type DocTreeResourceKind } from '@platform/tauri/client';
import { resourceKindFromPath } from '@features/editor/code-file';
import { useDynamicVirtualList } from '@features/memo/components/memo-list/use-dynamic-virtual-list';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@shared/ui/context-menu';

const TREE_EDGE_GUTTER = 6;
const INDENT_PER_LEVEL = 20;
const TREE_ROW_HEIGHT = 32;
const TREE_ROW_GAP = 2;
const TREE_ROW_SIZE = TREE_ROW_HEIGHT + TREE_ROW_GAP;
const TREE_HEADER_HEIGHT = 24;
const TREE_VIRTUAL_OVERSCAN = 10;
const TREE_DRAG_SCROLL_EDGE = 40;
const TREE_DRAG_SCROLL_MAX_STEP = 18;
const TREE_DRAG_EXPAND_DELAY_MS = 650;
const logger = createLogger('notebook-file-tree');
// Row gutter (6px) + inline padding (6px) + half of the 12px caret.
const FOLDER_CARET_CENTER_OFFSET = 12;

function relativeFolderPath(notebookPath: string, folderPath: string): string {
  const root = canonicalDirectoryPath(notebookPath);
  const folder = canonicalPath(folderPath);
  return folder.startsWith(`${root}/`) ? folder.slice(root.length + 1) : folder;
}

function resolveDropDirectory(
  hit: Element | null,
  treeRoot: HTMLElement,
  notebookPath: string,
): string | null {
  if (!hit || !treeRoot.contains(hit)) return null;

  // Rows are flat and may be virtualized. Resolve the destination from row
  // metadata rather than from DOM ancestry: a folder targets itself, while a
  // file targets its logical parent. The surrounding surface falls back to
  // the notebook root.
  const row = hit.closest<HTMLElement>('[data-notebook-tree-row="true"]');
  if (row && treeRoot.contains(row)) {
    return row.dataset.notebookDropPath
      ?? row.dataset.notebookParentPath
      ?? notebookPath;
  }
  return notebookPath;
}

function resolveExternalDropDirectory(
  position: ExternalDropPosition | null,
  treeRoot: HTMLElement,
  notebookPath: string,
): string | null {
  const hit = elementFromExternalDropPosition(position);
  return hit ? resolveDropDirectory(hit, treeRoot, notebookPath) : null;
}


export interface NotebookFolderCreateRequest {
  id: number;
  parentPath: string;
}

export interface NotebookNoteCreateRequest {
  id: number;
  parentPath: string;
}

export interface NotebookMoveResult {
  movedPaths: string[];
  failedPaths: string[];
}

export interface NotebookMoveSource {
  path: string;
  memoId?: string;
  resourceKind?: DocTreeResourceKind | null;
  isFolder?: boolean;
}

interface NotebookFileTreeProps {
  notebookPath: string;
  notebookName: string;
  activeFilePath?: string | null;
  tree: FolderTreeController;
  createFolderRequest?: NotebookFolderCreateRequest | null;
  createNoteRequest?: NotebookNoteCreateRequest | null;
  onCreateFolder?: () => void;
  onNoteSelect: (filePath: string) => void;
  onNoteOpenInNewTab?: (filePath: string) => void;
  onCreateNote: (parentPath: string, title: string) => Promise<void> | void;
  onMoveNote: (
    sources: NotebookMoveSource[],
    targetDirectoryPath: string,
  ) => Promise<NotebookMoveResult>;
  onDeleteFolder?: (folderPath: string) => Promise<void>;
  onDeleteResource?: (item: DocTreeItem) => Promise<void>;
  hiddenListFolders?: string[];
  onToggleListFolderVisibility?: (folderPath: string) => void;
}

interface PointerNoteDrag {
  sourceType: 'folder' | 'document';
  sourcePath: string;
  sourcePaths: string[];
  sourceItems: NotebookMoveSource[];
  preserveSelectionAfterMove: boolean;
  sourceName: string;
  pointerId: number;
  captureElement: HTMLElement;
  startX: number;
  startY: number;
  active: boolean;
  targetDirectoryPath: string | null;
}

interface NotebookTreeDraftState {
  requestId: number;
  parentPath: string;
  kind: 'note' | 'folder';
  value: string;
}

interface NotebookMoveFeedback {
  paths: string[];
  targetDirectoryPath: string;
  status: 'moving' | 'success';
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

  const requestedType = draft.kind === 'folder' ? 'folder' : 'document';
  let insertionIndex = -1;
  for (let index = rangeStart; index < rangeEnd; index += 1) {
    const row = rows[index];
    if (
      row.kind === 'node'
      && row.depth === childDepth
      && samePath(row.parentPath, parentPath)
      && row.item.type === requestedType
    ) {
      insertionIndex = index;
      break;
    }
  }

  if (insertionIndex < 0) {
    if (draft.kind === 'folder') {
      insertionIndex = rangeStart;
    } else {
      insertionIndex = rangeEnd;
    }
  }

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
  notebookPath,
  notebookName,
  activeFilePath = null,
  tree,
  createFolderRequest,
  createNoteRequest,
  onCreateFolder,
  onNoteSelect,
  onNoteOpenInNewTab,
  onCreateNote,
  onMoveNote,
  onDeleteFolder,
  onDeleteResource,
  hiddenListFolders = [],
  onToggleListFolderVisibility,
}: NotebookFileTreeProps) {
  const { t } = useI18n();
  const [showScrollTopHint, setShowScrollTopHint] = useState(false);
  const [draft, setDraft] = useState<NotebookTreeDraftState | null>(null);
  const [selectedFilePaths, setSelectedFilePaths] = useState<string[]>([]);
  const [focusedTreePath, setFocusedTreePath] = useState<string | null>(null);
  const selectedFilePathsRef = useRef<string[]>([]);
  const selectionAnchorPathRef = useRef<string | null>(null);
  const pointerDragRef = useRef<PointerNoteDrag | null>(null);
  const dropPendingRef = useRef(false);
  const externalDropTargetPathRef = useRef<string | null>(null);
  const treeScrollerRef = useRef<HTMLDivElement | null>(null);
  const pendingActiveFileScrollPathRef = useRef<string | null>(
    activeFilePath ? canonicalPath(activeFilePath) : null,
  );
  const externalDropSurfaceRef = useRef<HTMLDivElement | null>(null);
  const treeHeaderRef = useRef<HTMLDivElement | null>(null);
  const treeRootRef = useRef<HTMLDivElement | null>(null);
  const dragPreviewRef = useRef<HTMLDivElement | null>(null);
  const dragPreviewPositionRef = useRef({ x: 0, y: 0 });
  const moveFeedbackTimerRef = useRef<number | null>(null);
  const dragScrollFrameRef = useRef<number | null>(null);
  const dragPointerPositionRef = useRef<{ x: number; y: number } | null>(null);
  const dragExpandTimerRef = useRef<number | null>(null);
  const dragExpandPathRef = useRef<string | null>(null);
  const suppressOpenPathsRef = useRef<Set<string>>(new Set());
  const handledFolderRequestIdRef = useRef<number | null>(null);
  const handledNoteRequestIdRef = useRef<number | null>(null);
  const cancelledDraftRequestIdRef = useRef<number | null>(null);
  const submittingDraftRef = useRef(false);
  const [dragOverFolderPath, setDragOverFolderPath] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<{
    name: string;
    path: string;
    count: number;
  } | null>(null);
  const [moveFeedback, setMoveFeedback] = useState<NotebookMoveFeedback | null>(null);
  const [keptAlivePaths, setKeptAlivePaths] = useState<Set<string>>(() => new Set());

  const clearMoveFeedbackTimer = useCallback(() => {
    if (moveFeedbackTimerRef.current === null) return;
    window.clearTimeout(moveFeedbackTimerRef.current);
    moveFeedbackTimerRef.current = null;
  }, []);

  useEffect(() => clearMoveFeedbackTimer, [clearMoveFeedbackTimer]);

  const updateDragPreviewPosition = useCallback((x: number, y: number) => {
    dragPreviewPositionRef.current = { x, y };
    dragPreviewRef.current?.style.setProperty(
      'transform',
      `translate3d(${x}px, ${y}px, 0)`,
    );
  }, []);
  const selectedFilePathSet = useMemo(
    () => new Set(selectedFilePaths.map((path) => canonicalPath(path))),
    [selectedFilePaths],
  );
  const loadedTreeItems = useMemo(() => flattenLoadedTree(tree), [tree]);
  const visibleTreeItems = useMemo(() => flattenVisibleTree(tree), [tree]);
  const renderRows = useMemo(
    () => buildNotebookTreeRenderRows(visibleTreeItems, notebookPath, draft),
    [draft, notebookPath, visibleTreeItems],
  );
  const getRenderRowKey = useCallback((row: NotebookTreeRenderRow) => row.key, []);
  const estimateRenderRowSize = useCallback(() => TREE_ROW_SIZE, []);
  const keepAliveKeys = useMemo(() => {
    const keys = [...keptAlivePaths].map((path) => `node:${canonicalPath(path)}`);
    if (focusedTreePath) keys.push(`node:${canonicalPath(focusedTreePath)}`);
    if (draft) keys.push(`draft:${draft.requestId}`);
    return keys;
  }, [draft, focusedTreePath, keptAlivePaths]);
  const {
    totalSize: virtualTreeSize,
    virtualItems: virtualTreeRows,
    onScroll: onVirtualTreeScroll,
  } = useDynamicVirtualList({
    items: renderRows,
    getKey: getRenderRowKey,
    estimateSize: estimateRenderRowSize,
    scrollerRef: treeScrollerRef,
    enabled: true,
    resetKey: notebookPath,
    overscan: TREE_VIRTUAL_OVERSCAN,
    keepAliveKeys,
  });
  const renderRowIndexByPath = useMemo(() => new Map(
    renderRows.flatMap((row, index) => row.kind === 'node'
      ? [[canonicalPath(row.item.fullPath), index] as const]
      : []),
  ), [renderRows]);
  useEffect(() => {
    if (!draft) return;
    const index = renderRows.findIndex((row) => row.key === `draft:${draft.requestId}`);
    const scroller = treeScrollerRef.current;
    if (index < 0 || !scroller) return;
    const rowTop = TREE_HEADER_HEIGHT + index * TREE_ROW_SIZE;
    const rowBottom = rowTop + TREE_ROW_HEIGHT;
    if (rowTop < scroller.scrollTop) scroller.scrollTop = rowTop;
    else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, rowBottom - scroller.clientHeight);
    }
  }, [draft, renderRows]);
  useEffect(() => {
    const activePath = activeFilePath ? canonicalPath(activeFilePath) : null;
    pendingActiveFileScrollPathRef.current = activePath;
  }, [activeFilePath]);
  // Folder expansion changes the row index map; only honor a pending request
  // from an active-file change, and keep it pending until that row is loaded.
  useEffect(() => {
    if (!activeFilePath) return;
    const activePath = canonicalPath(activeFilePath);
    if (pendingActiveFileScrollPathRef.current !== activePath) return;
    const index = renderRowIndexByPath.get(activePath);
    const scroller = treeScrollerRef.current;
    if (index === undefined || !scroller) return;
    const rowTop = TREE_HEADER_HEIGHT + index * TREE_ROW_SIZE;
    const rowBottom = rowTop + TREE_ROW_HEIGHT;
    if (rowTop < scroller.scrollTop) scroller.scrollTop = rowTop;
    else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, rowBottom - scroller.clientHeight);
    }
    pendingActiveFileScrollPathRef.current = null;
  }, [activeFilePath, renderRowIndexByPath]);
  const visibleDocumentPaths = useMemo(
    () => visibleTreeItems
      .filter(({ item }) => item.type === 'document')
      .map(({ item }) => item.fullPath),
    [visibleTreeItems],
  );
  const memoIdByPath = useMemo(
    () => new Map(
      loadedTreeItems
        .filter((item) => item.memoMeta?.id)
        .map((item) => [canonicalPath(item.fullPath), item.memoMeta!.id] as const),
    ),
    [loadedTreeItems],
  );
  const treeItemByPath = useMemo(() => {
    return new Map(loadedTreeItems.map((item) => [canonicalPath(item.fullPath), item] as const));
  }, [loadedTreeItems]);
  const treeItemPaths = useMemo(() => new Set(treeItemByPath.keys()), [treeItemByPath]);
  const updateSelection = useCallback((paths: string[], anchorPath: string | null) => {
    const nextPaths = uniquePaths(paths);
    selectedFilePathsRef.current = nextPaths;
    selectionAnchorPathRef.current = anchorPath;
    setSelectedFilePaths(nextPaths);
  }, []);
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
  useEffect(() => {
    const currentPaths = selectedFilePathsRef.current;
    const nextPaths = currentPaths.filter((path) => treeItemPaths.has(canonicalPath(path)));
    if (nextPaths.length === currentPaths.length) return;
    const anchorPath = selectionAnchorPathRef.current;
    updateSelection(
      nextPaths,
      anchorPath && nextPaths.some((path) => samePath(path, anchorPath))
        ? anchorPath
        : nextPaths[nextPaths.length - 1] ?? null,
    );
  }, [treeItemPaths, updateSelection]);
  const focusTreeItem = useCallback((path: string) => {
    setFocusedTreePath(path);
    const focusMountedRow = () => {
      const row = Array.from(
        treeRootRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
      ).find((candidate) => samePath(candidate.dataset.notebookTreePath ?? '', path));
      row?.focus();
      return Boolean(row);
    };
    if (focusMountedRow()) return;

    const index = renderRowIndexByPath.get(canonicalPath(path));
    const scroller = treeScrollerRef.current;
    if (index === undefined || !scroller) return;
    const rowTop = TREE_HEADER_HEIGHT + index * TREE_ROW_SIZE;
    const rowBottom = rowTop + TREE_ROW_HEIGHT;
    if (rowTop < scroller.scrollTop) scroller.scrollTop = rowTop;
    else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, rowBottom - scroller.clientHeight);
    }
    window.requestAnimationFrame(() => { focusMountedRow(); });
  }, [renderRowIndexByPath]);
  const handleTreeItemKeyDown = useCallback((
    path: string,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const currentIndex = visibleTreeItems.findIndex(({ item }) => samePath(item.fullPath, path));
    if (currentIndex < 0) return;
    const current = visibleTreeItems[currentIndex];
    const nextVisibleItem = (step: number) => visibleTreeItems[currentIndex + step];

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const target = nextVisibleItem(event.key === 'ArrowDown' ? 1 : -1);
      if (!target) return;
      event.preventDefault();
      focusTreeItem(target.item.fullPath);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      const target = event.key === 'Home'
        ? visibleTreeItems[0]
        : visibleTreeItems[visibleTreeItems.length - 1];
      if (!target) return;
      event.preventDefault();
      focusTreeItem(target.item.fullPath);
      return;
    }

    if (event.key === 'ArrowRight' && current.item.type === 'folder') {
      const expanded = tree.expanded.has(canonicalPath(current.item.fullPath));
      if (!expanded) {
        event.preventDefault();
        tree.toggle(current.item.fullPath);
        return;
      }
      const child = nextVisibleItem(1);
      if (child && child.depth > current.depth) {
        event.preventDefault();
        focusTreeItem(child.item.fullPath);
      }
      return;
    }

    if (event.key === 'ArrowLeft') {
      if (current.item.type === 'folder'
        && tree.expanded.has(canonicalPath(current.item.fullPath))) {
        event.preventDefault();
        tree.toggle(current.item.fullPath);
        return;
      }
      const parent = visibleTreeItems
        .slice(0, currentIndex)
        .reverse()
        .find(({ item, depth }) => item.type === 'folder' && depth < current.depth);
      if (parent) {
        event.preventDefault();
        focusTreeItem(parent.item.fullPath);
      }
    }
  }, [focusTreeItem, tree, visibleTreeItems]);
  useEffect(() => {
    const hasFocusedItem = focusedTreePath
      && visibleTreeItems.some(({ item }) => samePath(item.fullPath, focusedTreePath));
    if (hasFocusedItem) return;
    const fallback = activeFilePath && visibleTreeItems.some(({ item }) => samePath(item.fullPath, activeFilePath))
      ? activeFilePath
      : visibleTreeItems[0]?.item.fullPath ?? null;
    if (fallback !== focusedTreePath) setFocusedTreePath(fallback);
  }, [activeFilePath, focusedTreePath, visibleTreeItems]);
  const selectNote = useCallback((filePath: string, event?: ReactMouseEvent<HTMLDivElement>) => {
    const currentPaths = selectedFilePathsRef.current;
    const isToggle = Boolean(event?.ctrlKey || event?.metaKey);
    const anchorPath = selectionAnchorPathRef.current;
    const targetIndex = visibleDocumentPaths.findIndex((path) => samePath(path, filePath));
    const anchorIndex = anchorPath
      ? visibleDocumentPaths.findIndex((path) => samePath(path, anchorPath))
      : -1;

    if (event?.shiftKey && anchorIndex >= 0 && targetIndex >= 0) {
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const range = visibleDocumentPaths.slice(start, end + 1);
      updateSelection(isToggle ? [...currentPaths, ...range] : range, filePath);
    } else if (isToggle) {
      const nextPaths = currentPaths.some((path) => samePath(path, filePath))
        ? currentPaths.filter((path) => !samePath(path, filePath))
        : [...currentPaths, filePath];
      updateSelection(nextPaths, filePath);
    } else {
      updateSelection([filePath], filePath);
      onNoteSelect(filePath);
    }
  }, [onNoteSelect, updateSelection, visibleDocumentPaths]);
  const hasVisibleItems = tree.rootChildren.length > 0;
  const isRootDropTarget = dragOverFolderPath !== null
    && canonicalDirectoryPath(dragOverFolderPath) === canonicalDirectoryPath(notebookPath);
  const treeFocusPath = focusedTreePath
    ?? (activeFilePath && visibleTreeItems.some(({ item }) => samePath(item.fullPath, activeFilePath))
      ? activeFilePath
      : visibleTreeItems[0]?.item.fullPath ?? null);
  const expandToRef = useRef(tree.expandTo);
  expandToRef.current = tree.expandTo;

  useEffect(() => {
    if (!activeFilePath || tree.loading) return;
    void expandToRef.current(activeFilePath);
  }, [activeFilePath, tree.loading]);

  useEffect(() => {
    if (!createFolderRequest || handledFolderRequestIdRef.current === createFolderRequest.id) return;
    handledFolderRequestIdRef.current = createFolderRequest.id;
    void tree.expandTo(`${createFolderRequest.parentPath}/__new-folder__`);
    setDraft({
      requestId: createFolderRequest.id,
      parentPath: createFolderRequest.parentPath,
      kind: 'folder',
      value: '',
    });
  }, [createFolderRequest, tree.expandTo]);

  useEffect(() => {
    if (!createNoteRequest || handledNoteRequestIdRef.current === createNoteRequest.id) return;
    handledNoteRequestIdRef.current = createNoteRequest.id;
    void tree.expandTo(`${createNoteRequest.parentPath}/__new-note__`);
    setDraft({
      requestId: createNoteRequest.id,
      parentPath: createNoteRequest.parentPath,
      kind: 'note',
      value: '',
    });
  }, [createNoteRequest, tree.expandTo]);

  const submitDraft = useCallback(async () => {
    if (!draft) return;
    if (cancelledDraftRequestIdRef.current === draft.requestId) {
      cancelledDraftRequestIdRef.current = null;
      return;
    }
    if (submittingDraftRef.current) return;
    submittingDraftRef.current = true;
    const { parentPath, kind, value } = draft;
    const name = value.trim();
    if (!name) {
      setDraft(null);
      submittingDraftRef.current = false;
      return;
    }
    try {
      if (kind === 'note') {
        await onCreateNote(parentPath, name);
        await tree.refresh(parentPath);
        setDraft(null);
        return;
      }
      const created = await files.createFolder(parentPath, name);
      if (!created) {
        toast.error(t('memo.fileTree.createFailed'));
        return;
      }
      await tree.refresh(parentPath);
      setDraft(null);
    } catch (error) {
      toast.error(t(
        String(error).includes('FILE_EXISTS')
          ? 'memo.fileTree.nameConflict'
          : 'memo.fileTree.createFailed',
      ));
    } finally {
      submittingDraftRef.current = false;
    }
  }, [draft, onCreateNote, t, tree.refresh]);

  const cancelDraft = useCallback(() => {
    if (!draft) return;
    cancelledDraftRequestIdRef.current = draft.requestId;
    setDraft(null);
  }, [draft]);

  const requestCreateDraft = useCallback((parentPath: string, kind: 'note' | 'folder') => {
    void tree.expandTo(`${parentPath}/__new-${kind}__`);
    setDraft({ requestId: Date.now(), parentPath, kind, value: '' });
  }, [tree.expandTo]);

  const handleRename = useCallback(async (item: DocTreeItem, nextName: string) => {
    const trimmed = nextName.trim();
    const isNote = item.type === 'document'
      && (item.resourceKind ?? resourceKindFromPath(item.name)) === 'note';
    const currentName = item.type === 'folder'
      ? item.name
      : isNote ? displayTitleFromFilename(item.name) : item.name;
    if (!trimmed || trimmed === currentName) return;

    try {
      if (item.type === 'folder') {
        await files.renameFolder(item.fullPath, trimmed, notebookPath);
      } else {
        const memoId = isNote
          ? item.memoMeta?.id ?? (await resolveMemoByPath(item.fullPath))?.memoId
          : null;
        if (memoId) {
          // Indexed notes use the memo path so the index and active editor
          // keep the same identity after the rename. Unindexed Markdown files
          // still use the generic file rename API.
          const result = await memos.renameMemoTitle({
            id: memoId,
            title: trimmed,
            expectedFilename: item.name,
          });
          useMemoStore.getState().handleMemoUpdated(result.memo);
          useDocumentStore.getState().replaceActiveMemoPath(result.memo.id, result.path);
        } else {
          const extension = isNote ? item.name.match(/\.(md|markdown)$/i)?.[0] ?? '' : '';
          await files.rename(item.fullPath, `${trimmed}${extension}`, notebookPath);
        }
      }

      const normalizedPath = canonicalPath(item.fullPath);
      const parent = normalizedPath.slice(0, normalizedPath.lastIndexOf('/'));
      await tree.refresh(parent || notebookPath);
      toast.success(t('memo.fileTree.renamed', { name: trimmed }));
    } catch (error) {
      toast.error(t(String(error).includes('FILE_EXISTS')
        ? 'memo.fileTree.nameConflict'
        : 'memo.fileTree.renameFailed'));
    }
  }, [notebookPath, t, tree.refresh]);

  const handleTogglePath = useCallback((path: string) => {
    if (suppressOpenPathsRef.current.has(canonicalPath(path))) return;
    tree.toggle(path);
  }, [tree.toggle]);
  const handleOpenPath = useCallback((path: string, event?: ReactMouseEvent<HTMLDivElement>) => {
    if (suppressOpenPathsRef.current.has(canonicalPath(path))) return;
    selectNote(path, event);
  }, [selectNote]);
  const handleOpenPathInNewTab = useCallback((path: string) => {
    onNoteOpenInNewTab?.(path);
  }, [onNoteOpenInNewTab]);
  const handleCreateNoteAtPath = useCallback((parentPath: string) => {
    requestCreateDraft(parentPath, 'note');
  }, [requestCreateDraft]);
  const handleCreateFolderAtPath = useCallback((parentPath: string) => {
    requestCreateDraft(parentPath, 'folder');
  }, [requestCreateDraft]);
  const handleFocusPath = useCallback((path: string) => setFocusedTreePath(path), []);
  const handleDeleteFolderPath = useCallback(async (path: string) => {
    await onDeleteFolder?.(path);
  }, [onDeleteFolder]);
  const handlePointerDownItem = useCallback((
    item: DocTreeItem,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (dropPendingRef.current || event.button !== 0) return;
    if (item.type === 'folder') {
      const captureElement = event.currentTarget;
      captureElement.setPointerCapture(event.pointerId);
      pointerDragRef.current = {
        sourceType: 'folder',
        sourcePath: item.fullPath,
        sourcePaths: [item.fullPath],
        sourceItems: [{ path: item.fullPath, isFolder: true }],
        preserveSelectionAfterMove: false,
        sourceName: item.name,
        pointerId: event.pointerId,
        captureElement,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        targetDirectoryPath: null,
      };
      return;
    }
    const currentPaths = selectedFilePathsRef.current;
    const isSelected = currentPaths.some((path) => samePath(path, item.fullPath));
    const sourcePaths = isSelected ? currentPaths : [item.fullPath];
    const sourceItems = sourcePaths.map((path) => {
      const sourceItem = path === item.fullPath ? item : treeItemByPath.get(canonicalPath(path));
      const memoId = memoIdByPath.get(canonicalPath(path));
      const resourceMetadata = sourceItem?.resourceKind
        ? { resourceKind: sourceItem.resourceKind }
        : {};
      return memoId
        ? { path, memoId, ...resourceMetadata }
        : { path, ...resourceMetadata };
    });
    // Capture on the row that started the gesture. Capturing on the tree root
    // retargets the browser's follow-up click to the root. Selection stays a
    // click concern: starting a drag must not select an unselected document.
    // Pointer events still bubble through the tree root while the row remains
    // mounted, which keeps drag handling unchanged without swallowing clicks.
    const captureElement = event.currentTarget;
    captureElement.setPointerCapture(event.pointerId);
    pointerDragRef.current = {
      sourceType: 'document',
      sourcePath: item.fullPath,
      sourcePaths,
      sourceItems,
      preserveSelectionAfterMove: isSelected,
      sourceName: displayTitleFromFilename(item.name),
      pointerId: event.pointerId,
      captureElement,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      targetDirectoryPath: null,
    };
  }, [memoIdByPath, treeItemByPath]);

  const renderDraft = (draftState: NotebookTreeDraftState, depth: number) => (
    <NotebookTreeDraft
      draft={draftState}
      depth={depth}
      data-notebook-tree-depth={depth}
      onChange={(value) => setDraft({ ...draftState, value })}
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
          parentPath={logicalParentPath}
          posInSet={posInSet}
          setSize={setSize}
          depth={depth}
          expanded={expanded}
          active={item.type === 'document' && Boolean(activeFilePath)
            && canonicalPath(item.fullPath) === canonicalPath(activeFilePath!)}
          selected={item.type === 'document' && selectedFilePathSet.has(canonicalPath(item.fullPath))}
          moveStatus={moveStatus}
          onToggle={handleTogglePath}
          onOpen={handleOpenPath}
          onOpenInNewTab={onNoteOpenInNewTab ? handleOpenPathInNewTab : undefined}
          onCreateNote={handleCreateNoteAtPath}
          onCreateFolder={handleCreateFolderAtPath}
          onRename={handleRename}
          tabIndex={treeFocusPath && samePath(treeFocusPath, item.fullPath) ? 0 : -1}
          onFocus={handleFocusPath}
          onKeyDown={handleTreeItemKeyDown}
          onDeleteFolder={item.type === 'folder' && onDeleteFolder
            ? handleDeleteFolderPath
            : undefined}
          onDeleteResource={item.type === 'document' && onDeleteResource
            ? onDeleteResource
            : undefined}
          hiddenFromList={item.type === 'folder' && hiddenListFolders.includes(relativeFolderPath(notebookPath, item.fullPath))}
          onToggleListVisibility={item.type === 'folder' ? onToggleListFolderVisibility : undefined}
          onKeepAliveChange={handleRowKeepAliveChange}
          onPointerDown={handlePointerDownItem}
        />
      </div>
    );
  };

  const renderTreeRow = (row: NotebookTreeRenderRow) => row.kind === 'draft'
    ? renderDraft(row.draft, row.depth)
    : renderTreeItem(row.item, row.depth, row.parentPath, row.posInSet, row.setSize);

  const handleDrop = useCallback(async (
    targetDirectoryPath: string,
    sourceItemsOverride?: NotebookMoveSource[],
    preserveSelectionAfterMove = false,
  ) => {
    if (dropPendingRef.current) return;
    const sourceItems = sourceItemsOverride ?? pointerDragRef.current?.sourceItems ?? [];
    const sourcePaths = sourceItems.map((source) => source.path);
    if (sourcePaths.length === 0) return;
    const targetPath = canonicalDirectoryPath(targetDirectoryPath);
    const movableSourceItems = sourceItems.filter(
      (source) => parentDirectoryPath(source.path, notebookPath) !== targetPath,
    );
    const movableSourcePaths = movableSourceItems.map((source) => source.path);
    pointerDragRef.current = null;
    setDragOverFolderPath(null);
    setDragPreview(null);
    if (movableSourcePaths.length === 0) return;
    dropPendingRef.current = true;
    clearMoveFeedbackTimer();
    setMoveFeedback({
      paths: movableSourcePaths,
      targetDirectoryPath: targetPath,
      status: 'moving',
    });
    try {
      const startedAt = performance.now();
      const moveResult = await onMoveNote(movableSourceItems, targetDirectoryPath);
      const moveFinishedAt = performance.now();
      const rootPath = canonicalDirectoryPath(notebookPath);
      const sourceParents = uniquePaths(
        movableSourcePaths.map((sourcePath) => parentDirectoryPath(sourcePath, notebookPath)),
      ).filter((path) => (
        path === rootPath || path.startsWith(`${rootPath}/`)
      ));
      const refreshPaths = moveResult.movedPaths.length > 0
        ? [...sourceParents, targetDirectoryPath]
        : sourceParents;
      await Promise.all(uniquePaths(refreshPaths).map((path) => tree.refresh(path)));
      const refreshFinishedAt = performance.now();
      logger.debug('notebook tree drop completed', {
        requestedCount: movableSourcePaths.length,
        movedCount: moveResult.movedPaths.length,
        failedCount: moveResult.failedPaths.length,
        moveDurationMs: Math.round(moveFinishedAt - startedAt),
        refreshDurationMs: Math.round(refreshFinishedAt - moveFinishedAt),
        totalDurationMs: Math.round(refreshFinishedAt - startedAt),
      });

      const unchangedSelection = sourcePaths.filter((sourcePath) => (
        parentDirectoryPath(sourcePath, notebookPath) === targetPath
      ));
      const nextSelection = uniquePaths([
        ...moveResult.movedPaths,
        ...moveResult.failedPaths,
        ...unchangedSelection,
      ]);
      const selectedAnchor = selectionAnchorPathRef.current;
      const movedAnchor = selectedAnchor
        ? moveResult.movedPaths.find((path) => (
          samePath(path, pathInDirectory(targetPath, selectedAnchor))
        ))
        : null;
      const nextAnchor = movedAnchor
        ?? (selectedAnchor && moveResult.failedPaths.some((path) => samePath(path, selectedAnchor))
          ? selectedAnchor
          : selectedAnchor && unchangedSelection.some((path) => samePath(path, selectedAnchor))
            ? selectedAnchor
            : nextSelection[nextSelection.length - 1] ?? null);
      if (preserveSelectionAfterMove) updateSelection(nextSelection, nextAnchor);
      if (moveResult.movedPaths.length > 0) {
        setMoveFeedback({
          paths: moveResult.movedPaths,
          targetDirectoryPath: targetPath,
          status: 'success',
        });
        moveFeedbackTimerRef.current = window.setTimeout(() => {
          moveFeedbackTimerRef.current = null;
          setMoveFeedback(null);
        }, 450);
      } else {
        setMoveFeedback(null);
      }
      if (moveResult.failedPaths.length > 0) {
        toast.error(t('memo.fileTree.movePartialFailed', {
          moved: moveResult.movedPaths.length,
          failed: moveResult.failedPaths.length,
        }));
      }
    } catch (error) {
      clearMoveFeedbackTimer();
      setMoveFeedback(null);
      toast.error(t(String(error).includes('FILE_EXISTS')
        ? 'memo.fileTree.nameConflict'
        : 'memo.fileTree.moveFailed'));
    } finally {
      dropPendingRef.current = false;
    }
  }, [clearMoveFeedbackTimer, notebookPath, onMoveNote, t, tree.refresh, updateSelection]);

  const clearDragExpandTimer = useCallback(() => {
    dragExpandPathRef.current = null;
    if (dragExpandTimerRef.current !== null) {
      window.clearTimeout(dragExpandTimerRef.current);
      dragExpandTimerRef.current = null;
    }
  }, []);

  const scheduleFolderHoverExpand = useCallback((path: string | null) => {
    const key = path ? canonicalPath(path) : null;
    if (key === dragExpandPathRef.current) return;
    clearDragExpandTimer();
    if (!key) return;
    const item = treeItemByPath.get(key);
    if (item?.type !== 'folder' || tree.expanded.has(key)) return;

    dragExpandPathRef.current = key;
    dragExpandTimerRef.current = window.setTimeout(() => {
      dragExpandTimerRef.current = null;
      dragExpandPathRef.current = null;
      const pointerTarget = pointerDragRef.current?.targetDirectoryPath ?? null;
      const externalTarget = externalDropTargetPathRef.current;
      if (
        (pointerTarget && samePath(pointerTarget, key))
        || (externalTarget && samePath(externalTarget, key))
      ) {
        tree.toggle(item.fullPath);
      }
    }, TREE_DRAG_EXPAND_DELAY_MS);
  }, [clearDragExpandTimer, tree.expanded, tree.toggle, treeItemByPath]);

  const stopDragAutoScroll = useCallback(() => {
    dragPointerPositionRef.current = null;
    if (dragScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(dragScrollFrameRef.current);
      dragScrollFrameRef.current = null;
    }
  }, []);

  const updatePointerDropTarget = useCallback((clientX: number, clientY: number) => {
    const drag = pointerDragRef.current;
    const treeRoot = treeRootRef.current;
    if (!drag?.active || !treeRoot) return;
    const hit = document.elementFromPoint(clientX, clientY);
    const hitTree = hit?.closest<HTMLElement>('[data-notebook-tree-root="true"]');
    const isOverHeader = Boolean(hit && treeHeaderRef.current?.contains(hit));
    const candidateDirectoryPath = hitTree === treeRoot
      ? resolveDropDirectory(hit, treeRoot, notebookPath)
      : isOverHeader
        ? notebookPath
        : null;
    const targetDirectoryPath = candidateDirectoryPath
      && drag.sourcePaths.some((sourcePath) => {
        const target = canonicalDirectoryPath(candidateDirectoryPath);
        if (drag.sourceType === 'folder') {
          const source = canonicalDirectoryPath(sourcePath);
          if (target === source || target.startsWith(`${source}/`)) return false;
        }
        return parentDirectoryPath(sourcePath, notebookPath) !== target;
      })
      ? candidateDirectoryPath
      : null;
    if (drag.targetDirectoryPath !== targetDirectoryPath) {
      drag.targetDirectoryPath = targetDirectoryPath;
      setDragOverFolderPath(targetDirectoryPath);
      scheduleFolderHoverExpand(targetDirectoryPath);
    }
  }, [notebookPath, scheduleFolderHoverExpand]);

  const scheduleDragAutoScroll = useCallback((clientX: number, clientY: number) => {
    dragPointerPositionRef.current = { x: clientX, y: clientY };
    if (dragScrollFrameRef.current !== null) return;

    const tick = () => {
      dragScrollFrameRef.current = null;
      const drag = pointerDragRef.current;
      const position = dragPointerPositionRef.current;
      const scroller = treeScrollerRef.current;
      if (!drag?.active || !position || !scroller) return;

      const bounds = scroller.getBoundingClientRect();
      const topDistance = position.y - bounds.top;
      const bottomDistance = bounds.bottom - position.y;
      let delta = 0;
      if (topDistance >= 0 && topDistance < TREE_DRAG_SCROLL_EDGE) {
        delta = -TREE_DRAG_SCROLL_MAX_STEP
          * (1 - topDistance / TREE_DRAG_SCROLL_EDGE);
      } else if (bottomDistance >= 0 && bottomDistance < TREE_DRAG_SCROLL_EDGE) {
        delta = TREE_DRAG_SCROLL_MAX_STEP
          * (1 - bottomDistance / TREE_DRAG_SCROLL_EDGE);
      }

      if (delta !== 0) {
        const previousScrollTop = scroller.scrollTop;
        scroller.scrollTop = Math.max(0, previousScrollTop + delta);
        if (scroller.scrollTop !== previousScrollTop) {
          scroller.dispatchEvent(new Event('scroll'));
          updatePointerDropTarget(position.x, position.y);
          dragScrollFrameRef.current = window.requestAnimationFrame(tick);
        }
      }
    };

    dragScrollFrameRef.current = window.requestAnimationFrame(tick);
  }, [updatePointerDropTarget]);

  useEffect(() => () => {
    stopDragAutoScroll();
    clearDragExpandTimer();
  }, [clearDragExpandTimer, stopDragAutoScroll]);

  useEffect(() => {
    const dropSurface = externalDropSurfaceRef.current;
    if (!dropSurface) return;

    const updateExternalDropTarget = (detail: ExternalFileDropDetail) => {
      if (dropPendingRef.current) {
        externalDropTargetPathRef.current = null;
        setDragOverFolderPath(null);
        return;
      }
      if (detail.type === 'leave' || detail.paths.length === 0) {
        externalDropTargetPathRef.current = null;
        if (!pointerDragRef.current) setDragOverFolderPath(null);
        return;
      }

      const targetDirectoryPath = resolveExternalDropDirectory(
        detail.position,
        dropSurface,
        notebookPath,
      );
      const targetPath = targetDirectoryPath
        ? canonicalDirectoryPath(targetDirectoryPath)
        : null;
      const canDrop = targetPath !== null && detail.paths.some((path) => (
        parentDirectoryPath(path, notebookPath) !== targetPath
      ));
      const nextTargetPath = canDrop ? targetPath : null;
      const previousTargetPath = externalDropTargetPathRef.current;
      externalDropTargetPathRef.current = nextTargetPath;
      if (previousTargetPath !== nextTargetPath) {
        setDragOverFolderPath(nextTargetPath);
      }

      if (detail.type !== 'drop' || !nextTargetPath) return;
      externalDropTargetPathRef.current = null;
      void handleDrop(nextTargetPath, detail.paths.map((path) => ({
        path,
        resourceKind: resourceKindFromPath(path),
      })));
    };

    const onExternalFileDrop = (event: Event) => {
      const detail = (event as CustomEvent<ExternalFileDropDetail>).detail;
      if (!detail) return;
      updateExternalDropTarget(detail);
    };

    window.addEventListener(EXTERNAL_FILE_DROP_EVENT, onExternalFileDrop);
    return () => {
      window.removeEventListener(EXTERNAL_FILE_DROP_EVENT, onExternalFileDrop);
      externalDropTargetPathRef.current = null;
    };
  }, [handleDrop, notebookPath]);

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
      ref={externalDropSurfaceRef}
      data-notebook-external-drop-target="true"
      className={cn(
        'relative flex h-full min-h-0 flex-col select-none bg-[var(--list-bg)] text-[var(--foreground)]',
        dragPreview && 'notebook-file-tree--dragging',
      )}
    >
      <div className="relative min-h-0 flex-1">
        <OverlayScrollbar
          className="h-full"
          scrollerClassName="h-full overflow-y-auto pb-1"
          scrollerRef={treeScrollerRef}
          onScroll={(event) => {
            onVirtualTreeScroll(event);
            setShowScrollTopHint(event.currentTarget.scrollTop > 0);
          }}
        >
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="min-h-full">
          <div
            ref={treeHeaderRef}
            className={cn(
              'flex h-6 shrink-0 items-center gap-1 rounded-lg px-3 transition-colors duration-150',
              isRootDropTarget && 'bg-[color-mix(in_oklch,var(--brand)_10%,transparent)]',
            )}
          >
            <h3 className="text-xs font-medium leading-6 text-[var(--muted-foreground)] opacity-90">
              {t('memo.fileTree.sectionTitle')}
            </h3>
            {onCreateFolder && (
              <button
                type="button"
                onClick={onCreateFolder}
                aria-label={t('memo.fileTree.newFolder')}
                title={t('memo.fileTree.newFolder')}
                className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--brand)]"
              >
                <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
              <div
            ref={treeRootRef}
            role="tree"
            aria-multiselectable="true"
            aria-label={notebookName}
            data-notebook-tree-root="true"
            style={{ minHeight: `calc(100% - ${TREE_HEADER_HEIGHT}px)` }}
            className={cn(
              'relative rounded-lg transition-colors duration-150',
              isRootDropTarget && 'bg-[color-mix(in_oklch,var(--brand)_10%,transparent)]',
            )}
            onPointerMove={(event) => {
              const drag = pointerDragRef.current;
              if (!drag || event.pointerId !== drag.pointerId) return;
              if (!drag.active) {
                const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
                if (distance < 5) return;
                drag.active = true;
                setDragPreview({
                  name: drag.sourceName,
                  path: drag.sourcePath,
                  count: drag.sourcePaths.length,
                });
              }
              event.preventDefault();
              updateDragPreviewPosition(event.clientX + 12, event.clientY + 12);
              updatePointerDropTarget(event.clientX, event.clientY);
              scheduleDragAutoScroll(event.clientX, event.clientY);
            }}
            onPointerUp={(event) => {
              const drag = pointerDragRef.current;
              if (!drag || event.pointerId !== drag.pointerId) return;
              stopDragAutoScroll();
              clearDragExpandTimer();
              if (drag.captureElement.hasPointerCapture(drag.pointerId)) {
                drag.captureElement.releasePointerCapture(drag.pointerId);
              }
              pointerDragRef.current = null;
              setDragOverFolderPath(null);
              setDragPreview(null);
              if (!drag.active) return;
              event.preventDefault();
              const suppressedPaths = new Set(
                drag.sourcePaths.map((sourcePath) => canonicalPath(sourcePath)),
              );
              suppressOpenPathsRef.current = suppressedPaths;
              window.setTimeout(() => {
                if (suppressOpenPathsRef.current === suppressedPaths) {
                  suppressOpenPathsRef.current = new Set();
                }
              }, 0);
              if (!drag.targetDirectoryPath) return;
              void handleDrop(
                drag.targetDirectoryPath,
                drag.sourceItems,
                drag.preserveSelectionAfterMove,
              );
            }}
            onPointerCancel={(event) => {
              const drag = pointerDragRef.current;
              if (!drag || event.pointerId !== drag.pointerId) return;
              stopDragAutoScroll();
              clearDragExpandTimer();
              pointerDragRef.current = null;
              setDragOverFolderPath(null);
              setDragPreview(null);
            }}
          >
            {!hasVisibleItems && !tree.loading && !draft && (
              <div className="px-4 py-6 text-center text-xs text-[var(--muted-foreground)]">
                {tree.error ? t('memo.fileTree.unreadableHint') : t('memo.fileTree.empty')}
              </div>
            )}
            <div
              className="notebook-file-tree__virtual-items relative min-h-full"
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
          </div>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-[180px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
              <ContextMenuItem
                onClick={() => handleCreateNoteAtPath(notebookPath)}
                className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
              >
                <File className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('memo.fileTree.newNote')}
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => handleCreateFolderAtPath(notebookPath)}
                className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
              >
                <FolderPlus className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('memo.fileTree.newFolder')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </OverlayScrollbar>
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
            <FileTypeIcon path={dragPreview.path} className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
            <span className="truncate">
              {dragPreview.count > 1 ? t('memo.fileTree.draggingNotes', { count: dragPreview.count }) : dragPreview.name}
            </span>
          </div>
        )}
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 z-[3] h-3 bg-gradient-to-b from-[color-mix(in_oklch,var(--foreground)_3%,transparent)] to-transparent transition-opacity',
            showScrollTopHint ? 'opacity-100' : 'opacity-0',
          )}
        />
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
  style,
  'data-notebook-tree-depth': dataDepth,
}: {
  draft: { requestId: number; kind: 'note' | 'folder'; value: string };
  depth: number;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
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
        data-notebook-tree-draft-icon={draft.kind}
        className={cn(
          'relative flex h-[15px] w-[15px] shrink-0 items-center justify-center',
          draft.kind === 'folder'
            ? 'text-[var(--brand)]'
            : 'text-[color-mix(in_oklch,var(--foreground)_90%,white_10%)]',
        )}
      >
        {draft.kind === 'folder' ? (
          <span
            className="absolute inset-0 flex items-center justify-center"
            dangerouslySetInnerHTML={{ __html: folderIcon }}
          />
        ) : (
          <File className="h-[15px] w-[15px]" strokeWidth={1.3} />
        )}
      </span>
      <input
        key={draft.requestId}
        autoFocus
        value={draftInput.value}
        placeholder={draft.kind === 'folder' ? t('memo.fileTree.newFolder') : t('memo.fileTree.newNote')}
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
