'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

import { beginDragSession, cancelDragSession, endDragSession, moveDragSession } from '@shared/drag-drop/drag-drop-coordinator';
import type { DragPayload } from '@shared/drag-drop/drag-drop-coordinator';
import type { NotebookDragResource } from '@features/memo/public/drag-resource-api';
import { canonicalDirectoryPath, canonicalPath, fileNameFromPath, notebookRelativeDirectoryPath, parentDirectoryPath, pathInDirectory, samePath, uniquePaths } from '@/lib/path';
import { createLogger } from '@/lib/logger';
import { displayTitleFromFilename } from '@/lib/utils';
import { showNotebookMoveFailureToasts, normalizeNotebookMoveFailure, type NotebookMoveFailure } from './notebook-move-failure-toast';
import { resourceKindFromPath } from '@features/editor/public/code-file';
import { EXTERNAL_FILE_DROP_EVENT, type ExternalFileDropDetail } from '@features/document/public/shell-api';
import type { DocTreeItem } from '@platform/tauri/client';
import type { FolderTreeController } from './use-folder-tree';
import { TREE_DRAG_EXPAND_DELAY_MS, TREE_DRAG_SCROLL_EDGE, TREE_DRAG_SCROLL_MAX_STEP, TREE_EXTERNAL_DRAG_EXPAND_DELAY_MS } from './notebook-tree-layout';
import { createDragClickSuppression, createTreeDragPreview, readDragGrabOffset, type DragGrabOffset } from './notebook-tree-drag-preview';

const logger = createLogger('notebook-file-tree');

export interface NotebookMoveResult {
  movedPaths: string[];
  failedPaths: string[];
  failures?: NotebookMoveFailure[];
}

export interface NotebookMoveSource {
  path: string;
  resourceKind?: DocTreeItem['resourceKind'] | null;
  isFolder?: boolean;
}

interface NotebookMoveFeedback {
  paths: string[];
  targetDirectoryPath: string;
  status: 'moving' | 'success';
}

interface PointerNoteDrag {
  sourceType: 'folder' | 'document';
  sourcePaths: string[];
  sourceItems: NotebookMoveSource[];
  dragPayload: DragPayload<NotebookDragResource>;
  preserveSelectionAfterMove: boolean;
  pointerId: number;
  /** 行本身, 同时是 pointer capture 目标和克隆预览的源节点。 */
  captureElement: HTMLElement;
  startX: number;
  startY: number;
  grab: DragGrabOffset;
  active: boolean;
  targetDirectoryPath: string | null;
}

interface NotebookTreeDragOperations {
  expanded: Set<string>;
  toggle: (path: string) => void;
  refresh: FolderTreeController['refresh'];
}

interface UseNotebookTreeDragControllerOptions {
  notebookId?: string | null;
  notebookPath: string;
  tree: NotebookTreeDragOperations;
  treeItemsByPath: ReadonlyMap<string, DocTreeItem>;
  selectedFilePaths: string[];
  getSelectionAnchorPath: () => string | null;
  updateSelection: (paths: string[], anchorPath: string | null) => void;
  onMoveNote: (sources: NotebookMoveSource[], targetDirectoryPath: string) => Promise<NotebookMoveResult>;
  treeRootRef: RefObject<HTMLDivElement | null>;
  treeHeaderRef: RefObject<HTMLDivElement | null>;
  treeScrollerRef: RefObject<HTMLDivElement | null>;
  externalDropSurfaceRef: RefObject<HTMLDivElement | null>;
  t: Parameters<typeof showNotebookMoveFailureToasts>[0];
}

function resolveDropDirectory(hit: Element | null, treeRoot: HTMLElement, notebookPath: string): string | null {
  if (!hit || !treeRoot.contains(hit)) return null;
  const row = hit.closest<HTMLElement>('[data-notebook-tree-row="true"]');
  if (row && treeRoot.contains(row)) {
    return row.dataset.notebookDropPath
      ?? row.dataset.notebookParentPath
      ?? notebookPath;
  }
  return notebookPath;
}

/** Owns pointer and external drag state, move execution, and post-move selection. */
export function useNotebookTreeDragController({
  notebookId,
  notebookPath,
  tree,
  treeItemsByPath,
  selectedFilePaths,
  getSelectionAnchorPath,
  updateSelection,
  onMoveNote,
  treeRootRef,
  treeHeaderRef,
  treeScrollerRef,
  externalDropSurfaceRef,
  t,
}: UseNotebookTreeDragControllerOptions) {
  const pointerDragRef = useRef<PointerNoteDrag | null>(null);
  const dropPendingRef = useRef(false);
  const externalDropTargetPathRef = useRef<string | null>(null);
  const dragPreviewElementRef = useRef<HTMLDivElement | null>(null);
  const moveFeedbackTimerRef = useRef<number | null>(null);
  const dragScrollFrameRef = useRef<number | null>(null);
  const dragPointerPositionRef = useRef<{ x: number; y: number } | null>(null);
  const dragExpandTimerRef = useRef<number | null>(null);
  const dragExpandPathRef = useRef<string | null>(null);
  const suppressOpenPathsRef = useRef<Set<string>>(new Set());
  const [dragClickSuppression] = useState(createDragClickSuppression);
  const [dragOverFolderPath, setDragOverFolderPath] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [moveFeedback, setMoveFeedback] = useState<NotebookMoveFeedback | null>(null);

  const clearMoveFeedbackTimer = useCallback(() => {
    if (moveFeedbackTimerRef.current === null) return;
    window.clearTimeout(moveFeedbackTimerRef.current);
    moveFeedbackTimerRef.current = null;
  }, []);
  useEffect(() => clearMoveFeedbackTimer, [clearMoveFeedbackTimer]);

  const removeDragPreview = useCallback(() => {
    dragPreviewElementRef.current?.remove();
    dragPreviewElementRef.current = null;
    setIsDragging(false);
  }, []);

  /** 只减去 pointerdown 时的抓取偏移, 不加固定留白, 也不做视口 clamp。 */
  const updateDragPreviewPosition = useCallback((clientX: number, clientY: number) => {
    const preview = dragPreviewElementRef.current;
    const drag = pointerDragRef.current;
    if (!preview || !drag) return;
    preview.style.transform = `translate3d(${clientX - drag.grab.x}px, ${clientY - drag.grab.y}px, 0)`;
  }, []);

  const clearDragExpandTimer = useCallback(() => {
    dragExpandPathRef.current = null;
    if (dragExpandTimerRef.current !== null) {
      window.clearTimeout(dragExpandTimerRef.current);
      dragExpandTimerRef.current = null;
    }
  }, []);

  const scheduleFolderHoverExpand = useCallback((path: string | null, delayMs = TREE_DRAG_EXPAND_DELAY_MS) => {
    const key = path ? canonicalPath(path) : null;
    if (key === dragExpandPathRef.current) return;
    clearDragExpandTimer();
    if (!key) return;
    const item = treeItemsByPath.get(key);
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
    }, delayMs);
  }, [clearDragExpandTimer, tree.expanded, tree.toggle, treeItemsByPath]);

  const stopDragAutoScroll = useCallback(() => {
    dragPointerPositionRef.current = null;
    if (dragScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(dragScrollFrameRef.current);
      dragScrollFrameRef.current = null;
    }
  }, []);

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
    removeDragPreview();
    if (movableSourcePaths.length === 0) return;
    dropPendingRef.current = true;
    clearMoveFeedbackTimer();
    setMoveFeedback({ paths: movableSourcePaths, targetDirectoryPath: targetPath, status: 'moving' });
    try {
      const startedAt = performance.now();
      const moveResult = await onMoveNote(movableSourceItems, targetDirectoryPath);
      const moveFinishedAt = performance.now();
      const rootPath = canonicalDirectoryPath(notebookPath);
      const sourceParents = uniquePaths(
        movableSourcePaths.map((sourcePath) => parentDirectoryPath(sourcePath, notebookPath)),
      ).filter((path) => path === rootPath || path.startsWith(`${rootPath}/`));
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
      const selectedAnchor = getSelectionAnchorPath();
      const movedAnchor = selectedAnchor
        ? moveResult.movedPaths.find((path) => samePath(path, pathInDirectory(targetPath, selectedAnchor)))
        : null;
      const nextAnchor = movedAnchor
        ?? (selectedAnchor && moveResult.failedPaths.some((path) => samePath(path, selectedAnchor))
          ? selectedAnchor
          : selectedAnchor && unchangedSelection.some((path) => samePath(path, selectedAnchor))
            ? selectedAnchor
            : nextSelection[nextSelection.length - 1] ?? null);
      if (preserveSelectionAfterMove) updateSelection(nextSelection, nextAnchor);
      if (moveResult.movedPaths.length > 0) {
        setMoveFeedback({ paths: moveResult.movedPaths, targetDirectoryPath: targetPath, status: 'success' });
        moveFeedbackTimerRef.current = window.setTimeout(() => {
          moveFeedbackTimerRef.current = null;
          setMoveFeedback(null);
        }, 450);
      } else {
        setMoveFeedback(null);
      }
      if (moveResult.failedPaths.length > 0) {
        showNotebookMoveFailureToasts(t, moveResult.movedPaths.length, moveResult.failedPaths.length, moveResult.failures ?? []);
      }
    } catch (error) {
      clearMoveFeedbackTimer();
      setMoveFeedback(null);
      showNotebookMoveFailureToasts(t, 0, 1, [normalizeNotebookMoveFailure(error)]);
    } finally {
      dropPendingRef.current = false;
    }
  }, [clearMoveFeedbackTimer, getSelectionAnchorPath, notebookPath, onMoveNote, removeDragPreview, t, tree.refresh, updateSelection]);

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
    const targetDirectoryPath = candidateDirectoryPath && drag.sourcePaths.some((sourcePath) => {
      const target = canonicalDirectoryPath(candidateDirectoryPath);
      if (drag.sourceType === 'folder') {
        const source = canonicalDirectoryPath(sourcePath);
        if (target === source || target.startsWith(`${source}/`)) return false;
      }
      return parentDirectoryPath(sourcePath, notebookPath) !== target;
    }) ? candidateDirectoryPath : null;
    if (drag.targetDirectoryPath !== targetDirectoryPath) {
      drag.targetDirectoryPath = targetDirectoryPath;
      setDragOverFolderPath(targetDirectoryPath);
      scheduleFolderHoverExpand(targetDirectoryPath);
    }
  }, [notebookPath, scheduleFolderHoverExpand, treeHeaderRef, treeRootRef]);

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
        delta = -TREE_DRAG_SCROLL_MAX_STEP * (1 - topDistance / TREE_DRAG_SCROLL_EDGE);
      } else if (bottomDistance >= 0 && bottomDistance < TREE_DRAG_SCROLL_EDGE) {
        delta = TREE_DRAG_SCROLL_MAX_STEP * (1 - bottomDistance / TREE_DRAG_SCROLL_EDGE);
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
  }, [treeScrollerRef, updatePointerDropTarget]);

  const startItemDrag = useCallback((item: DocTreeItem, event: ReactPointerEvent<HTMLDivElement>) => {
    // 任何新的按下都说明上一次拖动的合成 click 已经过去, 抑制信号必须作废。
    dragClickSuppression.reset();
    if (dropPendingRef.current || event.button !== 0) return;
    const captureElement = event.currentTarget;
    const grab = readDragGrabOffset(captureElement, event.clientX, event.clientY);
    captureElement.setPointerCapture(event.pointerId);
    if (item.type === 'folder') {
      pointerDragRef.current = {
        sourceType: 'folder',
        sourcePaths: [item.fullPath],
        sourceItems: [{ path: item.fullPath, isFolder: true }],
        dragPayload: {
          sessionId: crypto.randomUUID(),
          sourceId: `notebook-file-tree:${notebookId ?? canonicalPath(notebookPath)}`,
          items: [{ kind: 'folder', absolutePath: item.fullPath, name: item.name }],
        },
        preserveSelectionAfterMove: false,
        pointerId: event.pointerId,
        captureElement,
        startX: event.clientX,
        startY: event.clientY,
        grab,
        active: false,
        targetDirectoryPath: null,
      };
      return;
    }
    const isSelected = selectedFilePaths.some((path) => samePath(path, item.fullPath));
    const sourcePaths = isSelected ? selectedFilePaths : [item.fullPath];
    const sourceItems = sourcePaths.map((path) => {
      const sourceItem = samePath(path, item.fullPath) ? item : treeItemsByPath.get(canonicalPath(path));
      const resourceMetadata = sourceItem?.resourceKind ? { resourceKind: sourceItem.resourceKind } : {};
      return { path, ...resourceMetadata };
    });
    const resources = sourcePaths.map((path): NotebookDragResource => {
      const sourceItem = samePath(path, item.fullPath) ? item : treeItemsByPath.get(canonicalPath(path));
      const name = sourceItem?.name ?? fileNameFromPath(path);
      const relativeParent = notebookRelativeDirectoryPath(notebookPath, parentDirectoryPath(path, notebookPath));
      if (sourceItem?.type === 'document' && notebookId && relativeParent !== null && /\.(?:md|markdown)$/i.test(name)) {
        return {
          kind: 'note',
          notebookId,
          relativePath: [relativeParent, fileNameFromPath(path)].filter(Boolean).join('/'),
          title: displayTitleFromFilename(name),
        };
      }
      return { kind: 'file', absolutePath: path, name, resourceKind: sourceItem?.resourceKind };
    });
    pointerDragRef.current = {
      sourceType: 'document',
      sourcePaths,
      sourceItems,
      dragPayload: {
        sessionId: crypto.randomUUID(),
        sourceId: `notebook-file-tree:${notebookId ?? canonicalPath(notebookPath)}`,
        items: resources,
      },
      preserveSelectionAfterMove: isSelected,
      pointerId: event.pointerId,
      captureElement,
      startX: event.clientX,
      startY: event.clientY,
      grab,
      active: false,
      targetDirectoryPath: null,
    };
  }, [dragClickSuppression, notebookId, notebookPath, selectedFilePaths, treeItemsByPath]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
      drag.active = true;
      dragPreviewElementRef.current = createTreeDragPreview(
        drag.captureElement, drag.grab, drag.sourcePaths.length,
      );
      setIsDragging(true);
      beginDragSession(drag.dragPayload, { x: event.clientX, y: event.clientY }, () => {
        const active = pointerDragRef.current;
        if (!active || active.pointerId !== drag.pointerId) return;
        stopDragAutoScroll();
        clearDragExpandTimer();
        if (active.captureElement.hasPointerCapture(active.pointerId)) {
          active.captureElement.releasePointerCapture(active.pointerId);
        }
        pointerDragRef.current = null;
        setDragOverFolderPath(null);
        removeDragPreview();
        dragClickSuppression.arm();
      });
    }
    event.preventDefault();
    updateDragPreviewPosition(event.clientX, event.clientY);
    updatePointerDropTarget(event.clientX, event.clientY);
    moveDragSession(drag.dragPayload.sessionId, { x: event.clientX, y: event.clientY });
    scheduleDragAutoScroll(event.clientX, event.clientY);
  }, [clearDragExpandTimer, dragClickSuppression, removeDragPreview, scheduleDragAutoScroll, stopDragAutoScroll, updateDragPreviewPosition, updatePointerDropTarget]);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    stopDragAutoScroll();
    clearDragExpandTimer();
    if (drag.captureElement.hasPointerCapture(drag.pointerId)) drag.captureElement.releasePointerCapture(drag.pointerId);
    pointerDragRef.current = null;
    setDragOverFolderPath(null);
    removeDragPreview();
    if (!drag.active) return;
    event.preventDefault();
    // 拖动结束后浏览器补发的 click 不能再落到任何行上, 否则文件夹单击会选中它。
    dragClickSuppression.arm();
    const suppressedPaths = new Set(drag.sourcePaths.map((sourcePath) => canonicalPath(sourcePath)));
    suppressOpenPathsRef.current = suppressedPaths;
    window.setTimeout(() => {
      if (suppressOpenPathsRef.current === suppressedPaths) suppressOpenPathsRef.current = new Set();
    }, 0);
    const handledByDropTarget = endDragSession(drag.dragPayload.sessionId, { x: event.clientX, y: event.clientY });
    if (handledByDropTarget || !drag.targetDirectoryPath) return;
    void handleDrop(drag.targetDirectoryPath, drag.sourceItems, drag.preserveSelectionAfterMove);
  }, [clearDragExpandTimer, dragClickSuppression, handleDrop, removeDragPreview, stopDragAutoScroll]);

  const handlePointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    cancelDragSession(drag.dragPayload.sessionId);
    stopDragAutoScroll();
    clearDragExpandTimer();
    pointerDragRef.current = null;
    setDragOverFolderPath(null);
    removeDragPreview();
  }, [clearDragExpandTimer, removeDragPreview, stopDragAutoScroll]);

  useEffect(() => () => {
    const drag = pointerDragRef.current;
    if (drag?.active) cancelDragSession(drag.dragPayload.sessionId);
    dragPreviewElementRef.current?.remove();
    dragPreviewElementRef.current = null;
  }, []);
  useEffect(() => () => {
    stopDragAutoScroll();
    clearDragExpandTimer();
  }, [clearDragExpandTimer, stopDragAutoScroll]);

  useEffect(() => {
    const dropSurface = externalDropSurfaceRef.current;
    if (!dropSurface) return;
    const updateExternalDropTarget = (detail: ExternalFileDropDetail, hit: Element | null) => {
      if (dropPendingRef.current) {
        externalDropTargetPathRef.current = null;
        scheduleFolderHoverExpand(null);
        setDragOverFolderPath(null);
        return;
      }
      if (detail.type === 'leave' || detail.paths.length === 0) {
        externalDropTargetPathRef.current = null;
        scheduleFolderHoverExpand(null);
        if (!pointerDragRef.current) setDragOverFolderPath(null);
        return;
      }
      const targetDirectoryPath = hit ? resolveDropDirectory(hit, dropSurface, notebookPath) : null;
      const targetPath = targetDirectoryPath ? canonicalDirectoryPath(targetDirectoryPath) : null;
      const canDrop = targetPath !== null && detail.paths.some((path) => parentDirectoryPath(path, notebookPath) !== targetPath);
      const nextTargetPath = canDrop ? targetPath : null;
      const previousTargetPath = externalDropTargetPathRef.current;
      externalDropTargetPathRef.current = nextTargetPath;
      if (previousTargetPath !== nextTargetPath) setDragOverFolderPath(nextTargetPath);
      if (detail.type === 'drop') {
        scheduleFolderHoverExpand(null);
        if (!nextTargetPath) return;
        externalDropTargetPathRef.current = null;
        void handleDrop(nextTargetPath, detail.paths.map((path) => ({ path, resourceKind: resourceKindFromPath(path) })));
        return;
      }
      if (previousTargetPath !== nextTargetPath || !nextTargetPath) {
        scheduleFolderHoverExpand(nextTargetPath, TREE_EXTERNAL_DRAG_EXPAND_DELAY_MS);
      }
    };
    const onExternalFileDrop = (event: Event) => {
      const detail = (event as CustomEvent<ExternalFileDropDetail>).detail;
      if (!detail) return;
      updateExternalDropTarget(detail, event.target instanceof Element ? event.target : null);
    };
    dropSurface.addEventListener(EXTERNAL_FILE_DROP_EVENT, onExternalFileDrop);
    return () => {
      dropSurface.removeEventListener(EXTERNAL_FILE_DROP_EVENT, onExternalFileDrop);
      externalDropTargetPathRef.current = null;
    };
  }, [externalDropSurfaceRef, handleDrop, notebookPath, scheduleFolderHoverExpand]);

  const shouldSuppressOpen = useCallback((path: string) => suppressOpenPathsRef.current.has(canonicalPath(path)), []);
  const consumeDragClickSuppression = useCallback(() => dragClickSuppression.consume(), [dragClickSuppression]);

  return {
    dragOverFolderPath,
    isDragging,
    consumeDragClickSuppression,
    moveFeedback,
    startItemDrag,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    shouldSuppressOpen,
  };
}
