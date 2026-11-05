'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';

import { canonicalPath, samePath, uniquePaths } from '@/lib/path';
import { findFileDisplayId } from '@/lib/file-display-registry';
import type { ContentKind } from '@features/content/public/content-api';
import { EMPTY_SELECTION_CONTENT_KINDS, useNotebookTreeSelectionStore } from '../store/notebook-tree-selection-store';
import { TREE_ROW_HEIGHT, TREE_ROW_SIZE } from './notebook-tree-layout';
import type { VisibleTreeNode } from './use-folder-tree';

interface NotebookTreeSelectionModifiers {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

interface NotebookTreeController {
  expanded: Set<string>;
  toggle: (path: string) => void;
}

interface NotebookTreeNavigationPolicy {
  path: string;
  policy: 'reveal' | 'preserve';
}

interface NotebookTreeNavigationPolicies {
  active: NotebookTreeNavigationPolicy | null;
  pending: NotebookTreeNavigationPolicy | null;
}

function getNavigationPolicyForPath(
  path: string | null,
  policies: NotebookTreeNavigationPolicies,
): NotebookTreeNavigationPolicy | null {
  if (!path) return null;
  if (policies.pending?.path === path) return policies.pending;
  if (policies.active?.path === path) return policies.active;
  return null;
}

interface UseNotebookTreeInteractionOptions {
  activeFilePath: string | null;
  visibleTreeItems: VisibleTreeNode[];
  treeItemPaths: ReadonlySet<string>;
  pinnedItemPaths?: string[];
  contentKinds?: ReadonlyMap<string, ContentKind>;
  tree: NotebookTreeController;
  treeRootRef: RefObject<HTMLDivElement | null>;
  treeScrollerRef: RefObject<HTMLDivElement | null>;
  renderRowIndexByPath: ReadonlyMap<string, number>;
  treeContentOffset: number;
  isActive?: boolean;
  activeFileRevealRatio?: number;
  onNoteSelect: (path: string) => void;
  onFolderSelect?: (path: string) => void;
  folderPaths?: ReadonlySet<string>;
}

type SidebarSelection =
  | { kind: 'files'; paths: string[] }
  | { kind: 'conversation'; instanceId: string };
const EMPTY_SELECTED_PATHS: string[] = [];

/** Owns the file tree's selection, keyboard focus, and active-row navigation. */
export function useNotebookTreeInteraction({
  activeFilePath,
  visibleTreeItems,
  treeItemPaths,
  pinnedItemPaths = [],
  contentKinds = EMPTY_SELECTION_CONTENT_KINDS,
  tree,
  treeRootRef,
  treeScrollerRef,
  renderRowIndexByPath,
  treeContentOffset,
  isActive = true,
  activeFileRevealRatio,
  onNoteSelect,
  onFolderSelect,
  folderPaths,
}: UseNotebookTreeInteractionOptions) {
  const [selection, setSelection] = useState<SidebarSelection>({ kind: 'files', paths: [] });
  const selectedFilePaths = selection.kind === 'files' ? selection.paths : EMPTY_SELECTED_PATHS;
  const selectedConversationId = selection.kind === 'conversation' ? selection.instanceId : null;
  const selectionOwner = useRef(Symbol('notebook-tree-selection'));
  useLayoutEffect(() => {
    const owner = selectionOwner.current;
    if (isActive) {
      useNotebookTreeSelectionStore.setState({ owner, count: selectedFilePaths.length, paths: selectedFilePaths, contentKinds });
    } else if (useNotebookTreeSelectionStore.getState().owner === owner) {
      useNotebookTreeSelectionStore.setState({ owner: null, count: 0, paths: [], contentKinds: EMPTY_SELECTION_CONTENT_KINDS });
    }
  }, [isActive, selectedFilePaths, contentKinds]);
  useLayoutEffect(() => {
    const owner = selectionOwner.current;
    return () => {
      if (useNotebookTreeSelectionStore.getState().owner === owner) {
        useNotebookTreeSelectionStore.setState({ owner: null, count: 0, paths: [], contentKinds: EMPTY_SELECTION_CONTENT_KINDS });
      }
    };
  }, []);
  const [focusedTreePath, setFocusedTreePath] = useState<string | null>(null);
  const selectedFilePathsRef = useRef<string[]>([]);
  const selectionListRef = useRef<'tree' | 'pinned'>('tree');
  const selectionAnchorPathRef = useRef<string | null>(null);
  // A local open may finish after newer modifier clicks. Its commit must not
  // discard that newer selection; unrelated external navigation still clears it.
  const selectionNavigationPathRef = useRef<string | null>(null);
  const activePath = activeFilePath ? canonicalPath(activeFilePath) : null;
  const activeDisplayId = activeFilePath ? findFileDisplayId(activeFilePath) : null;
  const previousActiveFileRef = useRef({ path: activePath, displayId: activeDisplayId });
  const pendingActiveFileScrollPathRef = useRef(activeFilePath ? canonicalPath(activeFilePath) : null);
  const [navigationPolicies, setNavigationPolicies] = useState<NotebookTreeNavigationPolicies>({
    active: null,
    pending: null,
  });
  const navigationPolicyForActivePath = getNavigationPolicyForPath(activePath, navigationPolicies);
  const activeFileShouldReveal = !activeFilePath
    || navigationPolicyForActivePath?.policy !== 'preserve';

  const selectedFilePathSet = useMemo(
    () => new Set(selectedFilePaths.map((path) => canonicalPath(path))),
    [selectedFilePaths],
  );
  const visibleItemPaths = useMemo(
    () => visibleTreeItems
      .map(({ item }) => item.fullPath),
    [visibleTreeItems],
  );

  const updateSelection = useCallback((paths: string[], anchorPath: string | null) => {
    const nextPaths = uniquePaths(paths);
    selectedFilePathsRef.current = nextPaths;
    selectionAnchorPathRef.current = anchorPath;
    setSelection({ kind: 'files', paths: nextPaths });
  }, []);
  const selectConversation = useCallback((instanceId: string) => {
    selectedFilePathsRef.current = [];
    selectionAnchorPathRef.current = null;
    setSelection({ kind: 'conversation', instanceId });
  }, []);
  const getSelectionAnchorPath = useCallback(() => selectionAnchorPathRef.current, []);

  const setNavigationPolicy = useCallback((path: string, policy: 'reveal' | 'preserve') => {
    const intent = { path: canonicalPath(path), policy };
    const currentActivePath = activeFilePath ? canonicalPath(activeFilePath) : null;
    setNavigationPolicies((current) => intent.path === currentActivePath
      ? { active: intent, pending: null }
      // Keep the current file's policy until the requested path becomes active.
      : { ...current, pending: intent });
  }, [activeFilePath]);

  const navigateToNote = useCallback((path: string, policy: 'reveal' | 'preserve') => {
    selectionNavigationPathRef.current = activeFilePath && samePath(path, activeFilePath)
      ? null : canonicalPath(path);
    setNavigationPolicy(path, policy);
    onNoteSelect(path);
  }, [activeFilePath, onNoteSelect, setNavigationPolicy]);

  useLayoutEffect(() => {
    const nextActivePath = activePath;
    const { path: previousPath, displayId: previousDisplayId } = previousActiveFileRef.current;
    if (previousPath === nextActivePath) {
      // The registry can move before activeFilePath's store projection. Keep
      // the previous ID through that temporary old-path lookup miss.
      if (activeDisplayId) previousActiveFileRef.current = { path: nextActivePath, displayId: activeDisplayId };
      return;
    }
    const sameDisplay = activeDisplayId !== null && previousDisplayId === activeDisplayId;
    previousActiveFileRef.current = { path: nextActivePath, displayId: activeDisplayId };
    if (sameDisplay && previousPath && nextActivePath) {
      // A rename keeps the same surface. Carry selection/focus to its new
      // locator even if the tree's asynchronous directory read is still stale.
      const rebase = (path: string) => samePath(path, previousPath) ? nextActivePath : path;
      const anchor = selectionAnchorPathRef.current;
      if (selectedFilePathsRef.current.length > 0) {
        updateSelection(selectedFilePathsRef.current.map(rebase), anchor ? rebase(anchor) : null);
      }
      setFocusedTreePath(current => current ? rebase(current) : null);
      setNavigationPolicies(current => ({
        active: current.active ? { ...current.active, path: rebase(current.active.path) } : null,
        pending: current.pending ? { ...current.pending, path: rebase(current.pending.path) } : null,
      }));
      return;
    }
    const requestedPolicy = nextActivePath
      && navigationPolicies.pending?.path === nextActivePath
      ? navigationPolicies.pending
      : null;
    setNavigationPolicies({ active: requestedPolicy, pending: null });
    const isSelectionNavigation = nextActivePath !== null
      && selectionNavigationPathRef.current === nextActivePath;
    selectionNavigationPathRef.current = null;
    if (isSelectionNavigation) return;
    if (selectedFilePathsRef.current.length === 0 && selectionAnchorPathRef.current === null) return;
    // Opening a clicked row must retain the anchor for the next Shift click.
    if (nextActivePath && selectionAnchorPathRef.current && samePath(nextActivePath, selectionAnchorPathRef.current)) return;
    updateSelection([], null);
  }, [activePath, activeDisplayId, navigationPolicies.pending, updateSelection]);

  useEffect(() => {
    const currentPaths = selectedFilePathsRef.current;
    const nextPaths = currentPaths.filter((path) => treeItemPaths.has(canonicalPath(path))
      || Boolean(activeFilePath && samePath(path, activeFilePath)));
    if (nextPaths.length === currentPaths.length) return;
    const anchorPath = selectionAnchorPathRef.current;
    updateSelection(
      nextPaths,
      anchorPath && nextPaths.some((path) => samePath(path, anchorPath))
        ? anchorPath
        : nextPaths[nextPaths.length - 1] ?? null,
    );
  }, [treeItemPaths, activeFilePath, updateSelection]);

  const focusTreeItem = useCallback((path: string, root: HTMLElement | null = treeRootRef.current) => {
    setFocusedTreePath(path);
    const focusMountedRow = () => {
      const row = Array.from(
        root?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
      ).find((candidate) => samePath(candidate.dataset.notebookTreePath ?? '', path));
      row?.focus();
      return Boolean(row);
    };
    if (focusMountedRow() || root !== treeRootRef.current) return;

    const index = renderRowIndexByPath.get(canonicalPath(path));
    const scroller = treeScrollerRef.current;
    if (index === undefined || !scroller) return;
    const rowTop = treeContentOffset + index * TREE_ROW_SIZE;
    const rowBottom = rowTop + TREE_ROW_HEIGHT;
    if (rowTop < scroller.scrollTop) scroller.scrollTop = rowTop;
    else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, rowBottom - scroller.clientHeight);
    }
    window.requestAnimationFrame(() => { focusMountedRow(); });
  }, [renderRowIndexByPath, treeContentOffset, treeRootRef, treeScrollerRef]);


  useEffect(() => {
    const fallback = activeFileShouldReveal && activeFilePath && visibleTreeItems.some(({ item }) => samePath(item.fullPath, activeFilePath))
      ? activeFilePath
      : visibleTreeItems[0]?.item.fullPath ?? null;
    setFocusedTreePath(current => {
      // Read the state after the rename layout effect, rather than replacing
      // its rebased focus with a fallback computed from the stale tree.
      if (current && (visibleTreeItems.some(({ item }) => samePath(item.fullPath, current))
        || (activeFilePath && samePath(current, activeFilePath)))) return current;
      return fallback;
    });
  }, [activeFileShouldReveal, activeFilePath, focusedTreePath, visibleTreeItems]);

  useLayoutEffect(() => {
    const activePath = activeFilePath ? canonicalPath(activeFilePath) : null;
    pendingActiveFileScrollPathRef.current = activeFileShouldReveal ? activePath : null;
  }, [activeFileShouldReveal, activeFilePath]);

  useLayoutEffect(() => {
    if (!isActive || !activeFilePath || !activeFileShouldReveal) return;
    const activePath = canonicalPath(activeFilePath);
    if (pendingActiveFileScrollPathRef.current !== activePath) return;
    const index = renderRowIndexByPath.get(activePath);
    const scroller = treeScrollerRef.current;
    if (index === undefined || !scroller) return;
    const rowTop = treeContentOffset + index * TREE_ROW_SIZE;
    const rowBottom = rowTop + TREE_ROW_HEIGHT;
    if (activeFileRevealRatio !== undefined) {
      if (scroller.clientHeight === 0) return;
      const desiredScrollTop = rowTop + TREE_ROW_HEIGHT / 2 - scroller.clientHeight * activeFileRevealRatio;
      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTo({
        top: Math.max(0, Math.min(desiredScrollTop, maxScrollTop)),
        behavior: 'smooth',
      });
    } else if (rowTop < scroller.scrollTop) scroller.scrollTop = rowTop;
    else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, rowBottom - scroller.clientHeight);
    }
    pendingActiveFileScrollPathRef.current = null;
  }, [
    activeFileShouldReveal,
    activeFilePath,
    activeFileRevealRatio,
    isActive,
    renderRowIndexByPath,
    treeContentOffset,
    treeScrollerRef,
  ]);

  const selectItem = useCallback((filePath: string, modifiers?: NotebookTreeSelectionModifiers, list: 'tree' | 'pinned' = 'tree') => {
    const itemPaths = list === 'pinned' ? pinnedItemPaths : visibleItemPaths;
    const sameList = selectionListRef.current === list;
    const currentPaths = sameList ? selectedFilePathsRef.current : [];
    const isToggle = Boolean(modifiers?.ctrlKey || modifiers?.metaKey);
    const anchorPath = sameList ? selectionAnchorPathRef.current : null;
    selectionListRef.current = list;
    const targetIndex = itemPaths.findIndex((path) => samePath(path, filePath));
    const anchorIndex = anchorPath
      ? itemPaths.findIndex((path) => samePath(path, anchorPath))
      : -1;

    let nextPaths: string[];
    let nextAnchor: string | null = filePath;
    if (modifiers?.shiftKey && anchorIndex >= 0 && targetIndex >= 0) {
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const range = itemPaths.slice(start, end + 1);
      nextPaths = isToggle ? [...currentPaths, ...range] : range;
      nextAnchor = anchorPath;
    } else if (isToggle) {
      nextPaths = currentPaths.some((path) => samePath(path, filePath))
        ? currentPaths.filter((path) => !samePath(path, filePath))
        : [...currentPaths, filePath];
    } else {
      nextPaths = [filePath];
    }
    nextPaths = uniquePaths(nextPaths);
    updateSelection(nextPaths, nextAnchor);
    // Returning to a singleton always shows that document, including when the
    // previously active document was removed from a multi-selection.
    const isPlainClick = !modifiers?.shiftKey && !isToggle;
    if (nextPaths.length === 1 && (isPlainClick || !activeFilePath || !samePath(nextPaths[0], activeFilePath))) {
      if (folderPaths?.has(canonicalPath(nextPaths[0])) || visibleTreeItems.some(({ item }) => item.type === 'folder' && samePath(item.fullPath, nextPaths[0]))) {
        if (isPlainClick) onFolderSelect?.(nextPaths[0]);
        return;
      }
      navigateToNote(nextPaths[0], list === 'pinned' ? 'preserve' : 'reveal');
    }
  }, [activeFilePath, navigateToNote, updateSelection, visibleItemPaths, pinnedItemPaths, visibleTreeItems, onFolderSelect, folderPaths]);

  const handleTreeItemKeyDown = useCallback((path: string, event: KeyboardEvent<HTMLDivElement>, context?: {
    items: VisibleTreeNode[];
    tree: NotebookTreeController;
    root: HTMLElement | null;
    list: 'pinned';
  }) => {
    const items = context?.items ?? visibleTreeItems;
    const controller = context?.tree ?? tree;
    const list = context?.list ?? 'tree';
    const currentIndex = items.findIndex(({ item }) => samePath(item.fullPath, path));
    if (currentIndex < 0) return;
    const current = items[currentIndex];
    const nextVisibleItem = (step: number) => items[currentIndex + step];
    const moveToItem = (targetPath: string) => {
      // Keep the original row as the range anchor when navigating before a click.
      if (event.shiftKey && (selectionListRef.current !== list || selectionAnchorPathRef.current === null)) {
        selectionListRef.current = list;
        updateSelection([path], path);
      }
      // Navigation replaces selection; only Shift extends a range. Ctrl/Cmd
      // toggle semantics belong to pointer selection, not arrow movement.
      selectItem(targetPath, { shiftKey: event.shiftKey }, list);
      focusTreeItem(targetPath, context ? context.root : treeRootRef.current);
    };

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const target = nextVisibleItem(event.key === 'ArrowDown' ? 1 : -1);
      if (!target) return;
      event.preventDefault();
      moveToItem(target.item.fullPath);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      const target = event.key === 'Home'
        ? items[0]
        : items[items.length - 1];
      if (!target) return;
      event.preventDefault();
      moveToItem(target.item.fullPath);
      return;
    }

    if (event.key === 'ArrowRight' && current.item.type === 'folder') {
      const expanded = controller.expanded.has(canonicalPath(current.item.fullPath));
      if (!expanded) {
        event.preventDefault();
        controller.toggle(current.item.fullPath);
        return;
      }
      const child = nextVisibleItem(1);
      if (child && child.depth > current.depth) {
        event.preventDefault();
        moveToItem(child.item.fullPath);
      }
      return;
    }

    if (event.key === 'ArrowLeft') {
      if (current.item.type === 'folder'
        && controller.expanded.has(canonicalPath(current.item.fullPath))) {
        event.preventDefault();
        controller.toggle(current.item.fullPath);
        return;
      }
      const parent = items
        .slice(0, currentIndex)
        .reverse()
        .find(({ item, depth }) => item.type === 'folder' && depth < current.depth);
      if (parent) {
        event.preventDefault();
        moveToItem(parent.item.fullPath);
      }
    }
  }, [focusTreeItem, selectItem, updateSelection, tree, visibleTreeItems, treeRootRef]);

  const treeFocusPath = focusedTreePath
    ?? (activeFileShouldReveal && activeFilePath && visibleTreeItems.some(({ item }) => samePath(item.fullPath, activeFilePath))
      ? activeFilePath
      : visibleTreeItems[0]?.item.fullPath ?? null);

  return {
    focusedTreePath,
    setFocusedTreePath,
    selectedFilePaths,
    selectedConversationId,
    selectConversation,
    selectedFilePathSet,
    updateSelection,
    getSelectionAnchorPath,
    setNavigationPolicy,
    navigateToNote,
    activeFileShouldReveal,
    treeFocusPath,
    handleTreeItemKeyDown,
    focusTreeItem,
    selectItem,
  };
}
