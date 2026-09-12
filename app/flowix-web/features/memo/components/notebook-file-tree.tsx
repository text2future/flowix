'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import {
  FilePlusIcon,
  FolderPlusIcon,
  LinkIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { ChevronRight, File, FolderPlus, MoreHorizontal, Plus } from 'lucide-react';

import { canonicalPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { cn, displayTitleFromFilename } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { FileTypeIcon } from '@features/memo/components/file-type-icon';
import { MemoCardActions } from '@features/memo/components/memo-card-actions';
import { memoRepository } from '@features/memo/services/memo-repository';
import { MEMO_COLOR_HEX, useMemoStore, type MemoColor, type MemoItem } from '@features/memo';
import { resolveMemoByPath } from '@features/memo/use-cases/open-by-target';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  useContextMenuContext,
} from '@shared/ui/context-menu';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import folderIcon from '@/assets/folder-outline.svg?raw';
import type { FolderTreeController } from '@features/memo/components/use-folder-tree';
import { files, memos, type DocTreeItem } from '@platform/tauri/client';

const TREE_EDGE_GUTTER = 6;
const INDENT_PER_LEVEL = 20;
const TREE_HEADER_HEIGHT = 24;
const TREE_ROW_HEIGHT = 34;
const TREE_VIRTUAL_OVERSCAN = 8;
// Row gutter (6px) + inline padding (6px) + half of the 12px caret.
const FOLDER_CARET_CENTER_OFFSET = 12;
const TREE_MENU_CLASS =
  'w-[180px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]';
const TREE_MENU_ITEM_CLASS =
  'h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';
const TREE_MENU_DIVIDER_CLASS = 'mx-1 my-1 h-px bg-[var(--border-popup)] opacity-60';

function canonicalDirectoryPath(path: string): string {
  const canonical = canonicalPath(path);
  const trimmed = canonical.replace(/\/+$/, '');
  return trimmed || (canonical.startsWith('/') ? '/' : canonical);
}

interface NotebookTreeVirtualItem {
  index: number;
  start: number;
}

function useNotebookTreeVirtualList(
  itemCount: number,
  scrollerRef: RefObject<HTMLDivElement | null>,
) {
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const frameRef = useRef<number | null>(null);

  const syncViewport = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const next = { scrollTop: scroller.scrollTop, height: scroller.clientHeight };
    setViewport((previous) => (
      previous.scrollTop === next.scrollTop && previous.height === next.height
        ? previous
        : next
    ));
  }, [scrollerRef]);

  const scheduleViewportSync = useCallback(() => {
    if (frameRef.current !== null) return;
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      syncViewport();
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      syncViewport();
    });
  }, [syncViewport]);

  useLayoutEffect(() => {
    syncViewport();
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(scheduleViewportSync);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scheduleViewportSync, scrollerRef, syncViewport]);

  useLayoutEffect(() => () => {
    if (frameRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const virtualItems = useMemo<NotebookTreeVirtualItem[]>(() => {
    if (itemCount === 0) return [];
    // A zero-height first measurement is common while a column is mounting.
    // Render the full list for that first frame, then switch to the bounded
    // window as soon as the scroller reports its real height.
    if (viewport.height <= 0) {
      return Array.from({ length: itemCount }, (_, index) => ({
        index,
        start: index * TREE_ROW_HEIGHT,
      }));
    }

    const listScrollTop = Math.max(0, viewport.scrollTop - TREE_HEADER_HEIGHT);
    const first = Math.max(
      0,
      Math.floor(listScrollTop / TREE_ROW_HEIGHT) - TREE_VIRTUAL_OVERSCAN,
    );
    const last = Math.min(
      itemCount,
      Math.ceil((listScrollTop + viewport.height) / TREE_ROW_HEIGHT)
        + TREE_VIRTUAL_OVERSCAN,
    );
    return Array.from({ length: Math.max(0, last - first) }, (_, offset) => {
      const index = first + offset;
      return { index, start: index * TREE_ROW_HEIGHT };
    });
  }, [itemCount, viewport]);

  return {
    totalHeight: itemCount * TREE_ROW_HEIGHT,
    virtualItems,
    onScroll: scheduleViewportSync,
  };
}

export interface NotebookFolderCreateRequest {
  id: number;
  parentPath: string;
}

export interface NotebookNoteCreateRequest {
  id: number;
  parentPath: string;
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
  onMoveNote: (sourcePath: string, targetDirectoryPath: string) => Promise<void>;
  onDeleteFolder?: (folderPath: string) => Promise<void>;
}

interface PointerNoteDrag {
  sourcePath: string;
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

type NotebookTreeEntry =
  | { kind: 'item'; key: string; item: DocTreeItem; depth: number }
  | { kind: 'draft'; key: string; draft: NotebookTreeDraftState; depth: number };

/**
 * 笔记本专用文件树。
 *
 * 这个组件有意不依赖 FolderFileTree：笔记树后续的选择模型、拖放、菜单、
 * 排序与虚拟化都可以独立演进。当前只共享底层目录读取 controller 和基础图标。
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
}: NotebookFileTreeProps) {
  const { t } = useI18n();
  const [showScrollTopHint, setShowScrollTopHint] = useState(false);
  const [draft, setDraft] = useState<NotebookTreeDraftState | null>(null);
  const pointerDragRef = useRef<PointerNoteDrag | null>(null);
  const treeScrollerRef = useRef<HTMLDivElement | null>(null);
  const treeRootRef = useRef<HTMLDivElement | null>(null);
  const suppressOpenPathRef = useRef<string | null>(null);
  const handledFolderRequestIdRef = useRef<number | null>(null);
  const handledNoteRequestIdRef = useRef<number | null>(null);
  const cancelledDraftRequestIdRef = useRef<number | null>(null);
  const submittingDraftRef = useRef(false);
  const [dragOverFolderPath, setDragOverFolderPath] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<{
    name: string;
    path: string;
    x: number;
    y: number;
  } | null>(null);
  const treeEntries = useMemo<NotebookTreeEntry[]>(() => {
    const entries: NotebookTreeEntry[] = [];
    const appendItems = (items: DocTreeItem[], depth: number, parentPath: string) => {
      const draftForList = draft
        && canonicalDirectoryPath(draft.parentPath) === canonicalDirectoryPath(parentPath)
        ? draft
        : null;
      const draftType = draftForList?.kind === 'folder' ? 'folder' : 'document';
      const firstMatchingIndex = draftForList
        ? items.findIndex((item) => item.type === draftType)
        : -1;
      const draftInsertionIndex = draftForList
        ? firstMatchingIndex >= 0
          ? firstMatchingIndex
          : draftForList.kind === 'folder' ? 0 : items.length
        : -1;

      items.forEach((item, index) => {
        if (index === draftInsertionIndex && draftForList) {
          entries.push({
            kind: 'draft',
            key: `draft-${draftForList.requestId}`,
            draft: draftForList,
            depth,
          });
        }

        entries.push({ kind: 'item', key: item.id, item, depth });
        if (item.type !== 'folder') return;

        const itemKey = canonicalPath(item.fullPath);
        const children = tree.nodes.get(itemKey)?.children ?? [];
        const hasDraftChild = draft !== null
          && canonicalDirectoryPath(draft.parentPath) === canonicalDirectoryPath(item.fullPath);
        if (tree.expanded.has(itemKey) && (children.length > 0 || hasDraftChild)) {
          appendItems(children, depth + 1, item.fullPath);
        }
      });

      if (draftForList && draftInsertionIndex === items.length) {
        entries.push({
          kind: 'draft',
          key: `draft-${draftForList.requestId}`,
          draft: draftForList,
          depth,
        });
      }
    };

    appendItems(tree.rootChildren, 0, notebookPath);
    return entries;
  }, [draft, notebookPath, tree.expanded, tree.nodes, tree.rootChildren]);
  const { totalHeight: treeHeight, virtualItems, onScroll: handleTreeScroll } =
    useNotebookTreeVirtualList(treeEntries.length, treeScrollerRef);
  const hasVisibleItems = treeEntries.some((entry) => entry.kind === 'item');
  const isRootDropTarget = dragOverFolderPath !== null
    && canonicalDirectoryPath(dragOverFolderPath) === canonicalDirectoryPath(notebookPath);

  useEffect(() => {
    if (!activeFilePath || tree.loading) return;
    void tree.expandTo(activeFilePath);
  }, [activeFilePath, tree.expandTo, tree.loading]);

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

  const renderDraft = (draftState: NotebookTreeDraftState, depth: number, key?: string, start?: number) => (
    <NotebookTreeDraft
      key={key}
      draft={draftState}
      depth={depth}
      data-notebook-tree-depth={depth}
      style={start === undefined ? undefined : {
        position: 'absolute',
        insetInline: 0,
        top: start,
        height: TREE_ROW_HEIGHT,
      }}
      onChange={(value) => setDraft({ ...draftState, value })}
      onSubmit={() => void submitDraft()}
      onCancel={cancelDraft}
    />
  );

  const renderTreeEntry = (entry: NotebookTreeEntry, start: number) => {
    if (entry.kind === 'draft') {
      return renderDraft(entry.draft, entry.depth, entry.key, start);
    }

    const { item, depth } = entry;
    const expanded = item.type === 'folder' && tree.expanded.has(canonicalPath(item.fullPath));
    const isDropTarget = item.type === 'folder'
      && dragOverFolderPath !== null
      && canonicalDirectoryPath(item.fullPath) === canonicalDirectoryPath(dragOverFolderPath);

    return (
      <div
        key={entry.key}
        className={cn(
          'folder-file-tree__group absolute inset-x-0',
          item.type === 'folder' && 'notebook-file-tree__virtual-folder-row',
        )}
        data-notebook-tree-depth={depth}
        data-drag-over={isDropTarget ? 'true' : 'false'}
        data-notebook-drop-path={item.type === 'folder' ? item.fullPath : isFolderParent(item, notebookPath)}
        style={{
          top: start,
          height: TREE_ROW_HEIGHT,
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
          depth={depth}
          expanded={expanded}
          active={item.type === 'document' && Boolean(activeFilePath)
            && canonicalPath(item.fullPath) === canonicalPath(activeFilePath!)}
          onToggle={() => tree.toggle(item.fullPath)}
          onOpen={() => {
            if (suppressOpenPathRef.current === item.fullPath) {
              suppressOpenPathRef.current = null;
              return;
            }
            onNoteSelect(item.fullPath);
          }}
          onOpenInNewTab={onNoteOpenInNewTab
            ? () => onNoteOpenInNewTab(item.fullPath)
            : undefined}
          dropTargetPath={item.type === 'folder' ? item.fullPath : isFolderParent(item, notebookPath)}
          onCreateNote={() => requestCreateDraft(isFolderParent(item, notebookPath), 'note')}
          onCreateFolder={() => requestCreateDraft(isFolderParent(item, notebookPath), 'folder')}
          onDeleteFolder={item.type === 'folder' && onDeleteFolder
            ? () => onDeleteFolder(item.fullPath)
            : undefined}
          onPointerDown={(event) => {
            if (item.type !== 'document') return;
            event.currentTarget.setPointerCapture(event.pointerId);
            pointerDragRef.current = {
              sourcePath: item.fullPath,
              sourceName: displayTitleFromFilename(item.name),
              pointerId: event.pointerId,
              captureElement: event.currentTarget,
              startX: event.clientX,
              startY: event.clientY,
              active: false,
              targetDirectoryPath: null,
            };
          }}
        />
      </div>
    );
  };

  const handleDrop = useCallback(async (
    targetDirectoryPath: string,
    sourcePathOverride?: string,
  ) => {
    const sourcePath = sourcePathOverride || pointerDragRef.current?.sourcePath || null;
    if (!sourcePath) return;
    pointerDragRef.current = null;
    setDragOverFolderPath(null);
    setDragPreview(null);
    try {
      await onMoveNote(sourcePath, targetDirectoryPath);
      const sourceParent = sourcePath.slice(0, sourcePath.lastIndexOf('/')) || notebookPath;
      await tree.refresh(sourceParent);
      if (canonicalPath(sourceParent) !== canonicalPath(targetDirectoryPath)) {
        await tree.refresh(targetDirectoryPath);
      }
    } catch (error) {
      toast.error(t(String(error).includes('FILE_EXISTS')
        ? 'memo.fileTree.nameConflict'
        : 'memo.fileTree.moveFailed'));
    }
  }, [notebookPath, onMoveNote, t, tree.refresh]);

  return (
    <div className="relative flex h-full min-h-0 flex-col select-none bg-[var(--card)] text-[var(--foreground)]">
      <div className="relative min-h-0 flex-1">
        <OverlayScrollbar
          className="h-full"
          scrollerClassName="h-full overflow-y-auto pb-1"
          scrollerRef={treeScrollerRef}
          onScroll={(event) => {
            setShowScrollTopHint(event.currentTarget.scrollTop > 0);
            handleTreeScroll();
          }}
        >
          <div className="flex h-6 items-center gap-1 px-3">
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
          {!hasVisibleItems && !tree.loading && !draft && (
            <div className="px-4 py-6 text-center text-xs text-[var(--muted-foreground)]">
              {tree.error ? t('memo.fileTree.unreadableHint') : t('memo.fileTree.empty')}
            </div>
          )}

          <div
            ref={treeRootRef}
            role="tree"
            aria-label={notebookName}
            data-notebook-tree-root="true"
            data-notebook-drop-path={notebookPath}
            className={cn(
              'relative rounded-lg transition-colors duration-150',
              isRootDropTarget && 'bg-[color-mix(in_oklch,var(--brand)_10%,transparent)]',
            )}
            style={{ height: treeHeight }}
            onPointerMove={(event) => {
              const drag = pointerDragRef.current;
              if (!drag || event.pointerId !== drag.pointerId) return;
              if (!drag.active) {
                const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
                if (distance < 5) return;
                drag.active = true;
              }
              event.preventDefault();
              setDragPreview({
                name: drag.sourceName,
                path: drag.sourcePath,
                x: event.clientX + 12,
                y: event.clientY + 12,
              });
              const hit = document.elementFromPoint(event.clientX, event.clientY);
              const hitTree = hit?.closest<HTMLElement>('[data-notebook-tree-root="true"]');
              const dropTarget = hitTree === treeRootRef.current
                ? hit?.closest<HTMLElement>('[data-notebook-drop-path]')
                : null;
              // 每个可投放区域都带有自己的目录: 文件夹行/子树容器指向自身,
              // 文件行指向所属目录。这样 hover 到展开文件夹的任意空白区域时,
              // 仍然属于同一个 drop zone, 不需要精确命中文件夹标题行。
              const targetDirectoryPath = hitTree === treeRootRef.current
                ? dropTarget?.dataset.notebookDropPath ?? null
                : null;
              drag.targetDirectoryPath = targetDirectoryPath;
              setDragOverFolderPath(targetDirectoryPath);
            }}
            onPointerUp={(event) => {
              const drag = pointerDragRef.current;
              if (!drag || event.pointerId !== drag.pointerId) return;
              if (drag.captureElement.hasPointerCapture(drag.pointerId)) {
                drag.captureElement.releasePointerCapture(drag.pointerId);
              }
              pointerDragRef.current = null;
              setDragOverFolderPath(null);
              setDragPreview(null);
              if (!drag.active || !drag.targetDirectoryPath) return;
              event.preventDefault();
              suppressOpenPathRef.current = drag.sourcePath;
              window.setTimeout(() => {
                if (suppressOpenPathRef.current === drag.sourcePath) {
                  suppressOpenPathRef.current = null;
                }
              }, 0);
              void handleDrop(drag.targetDirectoryPath, drag.sourcePath);
            }}
            onPointerCancel={(event) => {
              const drag = pointerDragRef.current;
              if (!drag || event.pointerId !== drag.pointerId) return;
              pointerDragRef.current = null;
              setDragOverFolderPath(null);
              setDragPreview(null);
            }}
          >
            {virtualItems.map(({ index, start }) => {
              const entry = treeEntries[index];
              return entry ? renderTreeEntry(entry, start) : null;
            })}
          </div>
        </OverlayScrollbar>
        {dragPreview && (
          <div
            aria-hidden="true"
            className="pointer-events-none fixed z-[100] flex h-8 max-w-[220px] items-center gap-1.5 rounded-lg border border-[var(--border-popup)] bg-[color-mix(in_oklch,var(--card)_88%,transparent)] px-2 text-sm text-[var(--foreground)] opacity-90 shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.35)] backdrop-blur-sm"
            style={{ left: dragPreview.x, top: dragPreview.y }}
          >
            <FileTypeIcon path={dragPreview.path} className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
            <span className="truncate">{dragPreview.name}</span>
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
      <input
        key={draft.requestId}
        autoFocus
        value={draft.value}
        placeholder={draft.kind === 'folder' ? t('memo.fileTree.newFolder') : t('memo.fileTree.newNote')}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onSubmit}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') onSubmit();
          if (event.key === 'Escape') onCancel();
        }}
        className="h-5 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm outline-none"
      />
    </div>
  );
}

function NotebookTreeRow({
  item,
  depth,
  expanded,
  active,
  onToggle,
  onOpen,
  onOpenInNewTab,
  dropTargetPath,
  onCreateNote,
  onCreateFolder,
  onDeleteFolder,
  onPointerDown,
}: {
  item: DocTreeItem;
  depth: number;
  expanded: boolean;
  active: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onOpenInNewTab?: () => void;
  dropTargetPath: string;
  onCreateNote: () => void;
  onCreateFolder: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onDeleteFolder?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const isFolder = item.type === 'folder';
  const [memo, setMemo] = useState<MemoItem | null>(null);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadMemo = useCallback(async () => {
    if (isFolder) return;
    const resolved = await resolveMemoByPath(item.fullPath);
    if (!resolved) return;
    const loaded = await memos.readMemo(resolved.memoId);
    if (loaded) setMemo(loaded);
  }, [isFolder, item.fullPath]);

  useEffect(() => {
    void loadMemo();
  }, [loadMemo]);

  const toggleFavorite = useCallback(async (nextMemo: MemoItem) => {
    await (nextMemo.favorited
      ? memoRepository.unfavorite(nextMemo.id)
      : memoRepository.favorite(nextMemo.id));
    setMemo((current) => current?.id === nextMemo.id
      ? { ...current, favorited: !nextMemo.favorited }
      : current);
    useMemoStore.getState().triggerRefresh();
  }, []);

  const changeColors = useCallback(async (nextMemo: MemoItem, colors: MemoColor[]) => {
    await useMemoStore.getState().setMemoColors(nextMemo.id, colors);
    setMemo((current) => current?.id === nextMemo.id
      ? { ...current, colors }
      : current);
  }, []);

  const requestDelete = useCallback((nextMemo: MemoItem) => {
    window.dispatchEvent(new CustomEvent<MemoItem>('flowix:request-delete-memo', {
      detail: nextMemo,
    }));
  }, []);

  const confirmFolderDelete = useCallback(async () => {
    if (!onDeleteFolder || deleting) return;
    setDeleting(true);
    try {
      await onDeleteFolder();
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }, [deleting, onDeleteFolder]);
  return (
    <>
      <ContextMenu onOpenChange={(open) => {
        setContextMenuOpen(open);
        if (open) void loadMemo();
      }}>
      <ContextMenuTrigger asChild>
        <div
          role="treeitem"
          aria-expanded={isFolder ? expanded : undefined}
          aria-selected={!isFolder ? active : undefined}
          tabIndex={0}
          data-notebook-drop-path={dropTargetPath}
          data-notebook-tree-kind={isFolder ? 'folder' : 'note'}
          title={item.fullPath}
          onClick={isFolder ? onToggle : onOpen}
          onDoubleClick={!isFolder && onOpenInNewTab ? onOpenInNewTab : undefined}
          onPointerDown={(event) => {
            if (isFolder || event.button !== 0) return;
            onPointerDown(event);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            if (isFolder) onToggle(); else onOpen();
          }}
          className={cn(
            'folder-file-tree__item group relative flex h-8 cursor-pointer items-center rounded-lg px-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--brand)]',
            active
              ? 'bg-[var(--muted)] font-medium text-[var(--foreground)]'
              : cn('hover:bg-[var(--muted)]', contextMenuOpen && 'bg-[var(--muted)] text-[var(--foreground)]'),
          )}
          style={{
            marginLeft: TREE_EDGE_GUTTER + depth * INDENT_PER_LEVEL,
            width: `calc(100% - ${TREE_EDGE_GUTTER * 2 + depth * INDENT_PER_LEVEL}px)`,
          }}
        >
      {isFolder ? (
        <span aria-hidden="true" className="relative h-[15px] w-[15px] shrink-0 text-[color-mix(in_oklch,var(--foreground)_90%,white_10%)]">
          <span
            className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0"
            dangerouslySetInnerHTML={{ __html: folderIcon }}
          />
          <ChevronRight className={cn(
            'absolute inset-0 h-[15px] w-[15px] opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 group-focus-visible:opacity-100',
            expanded && 'rotate-90',
          )} />
        </span>
      ) : (
        <span
          aria-hidden="true"
          className="relative h-[15px] w-[15px] shrink-0 text-[color-mix(in_oklch,var(--foreground)_90%,white_10%)]"
        >
          <File className="absolute inset-0 h-[15px] w-[15px]" strokeWidth={1.3} />
        </span>
      )}
      <span className={cn(
        'min-w-0 flex-1 truncate',
        'ml-1.5',
        !isFolder && 'text-[color-mix(in_oklch,var(--foreground)_90%,transparent)]',
      )}>
        {isFolder ? item.name : displayTitleFromFilename(item.name)}
      </span>
      {isFolder && (
        <span className={cn(
          'pointer-events-none ml-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-visible:pointer-events-auto group-focus-visible:opacity-100',
          contextMenuOpen && 'pointer-events-auto opacity-100',
        )}>
          <button
            type="button"
            aria-label={t('memo.fileTree.newNote')}
            title={t('memo.fileTree.newNote')}
            onClick={(event) => {
              event.stopPropagation();
              onCreateNote();
            }}
            onKeyDown={(event) => event.stopPropagation()}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--brand)]"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={t('memo.fileTree.newFolder')}
            title={t('memo.fileTree.newFolder')}
            onClick={(event) => {
              event.stopPropagation();
              onCreateFolder();
            }}
            onKeyDown={(event) => event.stopPropagation()}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--brand)]"
          >
            <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </span>
      )}
      {!isFolder && memo && memo.colors.length > 0 && (
        <span aria-label="Note colors" className="ml-2 inline-flex shrink-0 items-center gap-0.5">
          {memo.colors.map((color) => (
            <span
              key={color}
              aria-hidden="true"
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: MEMO_COLOR_HEX[color] }}
            />
          ))}
        </span>
      )}
      <NotebookTreeMoreButton
        label={t('memo.fileTree.moreActions')}
        active={contextMenuOpen}
      />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className={TREE_MENU_CLASS}>
        <ContextMenuItem onClick={onCreateNote} className={TREE_MENU_ITEM_CLASS}>
          <FilePlusIcon className="mr-2 h-4 w-4" />
          {t('memo.fileTree.newNote')}
        </ContextMenuItem>
        <ContextMenuItem onClick={onCreateFolder} className={TREE_MENU_ITEM_CLASS}>
          <FolderPlusIcon className="mr-2 h-4 w-4" />
          {t('memo.fileTree.newFolder')}
        </ContextMenuItem>
        {isFolder && onDeleteFolder && (
          <>
            <div role="separator" aria-hidden="true" className={TREE_MENU_DIVIDER_CLASS} />
            <ContextMenuItem
              onClick={() => setConfirmDelete(true)}
              className={cn(TREE_MENU_ITEM_CLASS, 'text-[var(--destructive)]')}
            >
              <TrashIcon className="mr-2 h-4 w-4" />
              {t('memo.fileTree.delete')}
            </ContextMenuItem>
          </>
        )}
        {isFolder && onDeleteFolder && (
          <ContextMenuItem
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(item.fullPath);
                toast.success(t('memo.fileTree.pathCopied'));
              } catch {
                toast.error(t('memo.fileTree.copyFailed'));
              }
            }}
            className={TREE_MENU_ITEM_CLASS}
          >
            <LinkIcon className="mr-2 h-4 w-4" />
            {t('memo.fileTree.copyLink')}
          </ContextMenuItem>
        )}
        {!isFolder && (
          <div role="separator" aria-hidden="true" className={TREE_MENU_DIVIDER_CLASS} />
        )}
        {!isFolder && memo && (
          <MemoCardActions
            memo={memo}
            onOpenInSplit={onOpenInNewTab
              ? () => onOpenInNewTab()
              : undefined}
            onFavoriteToggle={(nextMemo) => { void toggleFavorite(nextMemo); }}
            onDelete={requestDelete}
            onColorsChange={(nextMemo, colors) => { void changeColors(nextMemo, colors); }}
            Item={ContextMenuItem}
          />
        )}
        {!isFolder && !memo && (
          <ContextMenuItem disabled className={TREE_MENU_ITEM_CLASS}>
            {t('memo.fileTree.loading')}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
      </ContextMenu>
      <Dialog open={confirmDelete} onOpenChange={(open) => { if (!open && !deleting) setConfirmDelete(false); }}>
        <DialogContent className="rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <DialogHeader>
            <DialogTitle>{t('memo.fileTree.deleteFolderTitle')}</DialogTitle>
            <DialogDescription>{t('memo.fileTree.deleteFolderDescription')}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" disabled={deleting} onClick={() => setConfirmDelete(false)} className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]">
              {t('dialog.cancel')}
            </button>
            <button type="button" disabled={deleting} onClick={() => void confirmFolderDelete()} className="h-8 rounded-lg bg-[var(--destructive)] px-3 text-sm text-white hover:opacity-90 disabled:opacity-50">
              {t('dialog.delete')}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function NotebookTreeMoreButton({ label, active }: { label: string; active: boolean }) {
  const { openAt } = useContextMenuContext();

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        openAt(rect.left, rect.bottom);
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className={cn(
        'pointer-events-none ml-0 flex h-6 w-0 shrink-0 items-center justify-center overflow-hidden rounded-md text-[var(--muted-foreground)] opacity-0 transition-[width,margin,opacity,color] duration-[37.5ms] group-hover:pointer-events-auto group-hover:ml-1 group-hover:w-6 group-hover:opacity-100 hover:text-[var(--foreground)] focus-visible:pointer-events-auto focus-visible:ml-1 focus-visible:w-6 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--brand)]',
        active && 'pointer-events-auto ml-1 w-6 opacity-100 text-[var(--foreground)]',
      )}
    >
      <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

function isFolderParent(item: DocTreeItem, notebookPath: string): string {
  if (item.type === 'folder') return item.fullPath;
  return item.fullPath.slice(0, item.fullPath.lastIndexOf('/')) || notebookPath;
}
