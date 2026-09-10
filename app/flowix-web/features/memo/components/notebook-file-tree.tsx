'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  CaretRightIcon,
  FilePlusIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderSimpleIcon,
} from '@phosphor-icons/react';

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
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@shared/ui/context-menu';
import {
  flattenVisibleTree,
  type FolderTreeController,
  type VisibleTreeNode,
} from '@features/memo/components/use-folder-tree';
import { files, memos, type DocTreeItem } from '@platform/tauri/client';

const TREE_EDGE_GUTTER = 6;
const INDENT_PER_LEVEL = 20;
const TREE_MENU_CLASS =
  'w-[180px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]';
const TREE_MENU_ITEM_CLASS =
  'h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';
const TREE_MENU_DIVIDER_CLASS = 'mx-1 my-1 h-px bg-[var(--border-popup)] opacity-60';

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
  onNoteSelect: (filePath: string) => void;
  onNoteOpenInNewTab?: (filePath: string) => void;
  onCreateNote: (parentPath: string, title: string) => Promise<void> | void;
  onMoveNote: (sourcePath: string, targetDirectoryPath: string) => Promise<void>;
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
  onNoteSelect,
  onNoteOpenInNewTab,
  onCreateNote,
  onMoveNote,
}: NotebookFileTreeProps) {
  const { t } = useI18n();
  const [showScrollTopHint, setShowScrollTopHint] = useState(false);
  const [draft, setDraft] = useState<{
    requestId: number;
    parentPath: string;
    kind: 'note' | 'folder';
    value: string;
  } | null>(null);
  const pointerDragRef = useRef<PointerNoteDrag | null>(null);
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
  const visibleNodes = useMemo(() => flattenVisibleTree(tree), [tree]);

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
  }, [draft, onCreateNote, t, tree]);

  const cancelDraft = useCallback(() => {
    if (!draft) return;
    cancelledDraftRequestIdRef.current = draft.requestId;
    setDraft(null);
  }, [draft]);

  const requestCreateDraft = useCallback((parentPath: string, kind: 'note' | 'folder') => {
    void tree.expandTo(`${parentPath}/__new-${kind}__`);
    setDraft({ requestId: Date.now(), parentPath, kind, value: '' });
  }, [tree.expandTo]);

  const draftDepth = draft
    ? findParentDepth(visibleNodes, draft.parentPath) + 1
    : 0;
  const draftInsertIndex = draft
    ? canonicalPath(draft.parentPath) === canonicalPath(notebookPath)
      ? 0
      : (() => {
        const parentIndex = visibleNodes.findIndex(({ item }) => canonicalPath(item.fullPath) === canonicalPath(draft.parentPath));
        return parentIndex >= 0 ? parentIndex + 1 : visibleNodes.length;
      })()
    : -1;

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
  }, [notebookPath, onMoveNote, t, tree]);

  return (
    <div className="relative flex h-full min-h-0 flex-col select-none bg-[var(--card)] text-[var(--foreground)]">
      <div className="relative min-h-0 flex-1">
        <OverlayScrollbar
          className="h-full"
          scrollerClassName="h-full overflow-y-auto py-1"
          onScroll={(event) => setShowScrollTopHint(event.currentTarget.scrollTop > 0)}
        >
          {visibleNodes.length === 0 && !tree.loading && !draft && (
            <div className="px-4 py-6 text-center text-xs text-[var(--muted-foreground)]">
              {tree.error ? t('memo.fileTree.unreadableHint') : t('memo.fileTree.empty')}
            </div>
          )}

          <div
            ref={treeRootRef}
            role="tree"
            aria-label={notebookName}
            data-notebook-tree-root="true"
            className="space-y-0.5"
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
              const row = hitTree === treeRootRef.current
                ? hit?.closest<HTMLElement>('[data-notebook-tree-kind]')
                : null;
              // 每一行都带有自己的投放目录: 文件夹行指向自身, 文件行指向
              // 所属目录。这样 hover 到展开文件夹的任意子项时, 整个子树
              // 仍然属于同一个 drop zone, 不需要精确命中文件夹标题行。
              const targetDirectoryPath = hitTree === treeRootRef.current
                ? row?.dataset.notebookDropPath ?? notebookPath
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
            {dragOverFolderPath === notebookPath && (
              <div className="mx-2 mb-1 rounded-md bg-[var(--brand)]/15 px-2 py-1 text-[11px] text-[var(--brand)]">
                {t('memo.fileTree.dropToRoot')}
              </div>
            )}
            {visibleNodes.map(({ item, depth }, index) => (
              <Fragment key={item.id}>
                {draft && index === draftInsertIndex && (
                  <NotebookTreeDraft
                    draft={draft}
                    depth={draftDepth}
                    onChange={(value) => setDraft({ ...draft, value })}
                    onSubmit={() => void submitDraft()}
                    onCancel={cancelDraft}
                  />
                )}
                <NotebookTreeRow
                  item={item}
                  depth={depth}
                  expanded={item.type === 'folder' && tree.expanded.has(canonicalPath(item.fullPath))}
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
                  dragOver={isFolderDropZoneHighlighted(
                    visibleNodes,
                    index,
                    dragOverFolderPath,
                  )}
                  dropTargetPath={item.type === 'folder'
                    ? item.fullPath
                    : isFolderParent(item, notebookPath)}
                  onCreateNote={() => requestCreateDraft(isFolderParent(item, notebookPath), 'note')}
                  onCreateFolder={() => requestCreateDraft(isFolderParent(item, notebookPath), 'folder')}
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
              </Fragment>
            ))}

            {draft && draftInsertIndex >= visibleNodes.length && (
              <NotebookTreeDraft
                draft={draft}
                depth={draftDepth}
                onChange={(value) => setDraft({ ...draft, value })}
                onSubmit={() => void submitDraft()}
                onCancel={cancelDraft}
              />
            )}
          </div>
        </OverlayScrollbar>
        {dragPreview && (
          <div
            aria-hidden="true"
            className="pointer-events-none fixed z-[100] flex h-8 max-w-[220px] items-center gap-1.5 rounded-lg border border-[var(--border-popup)] bg-[color-mix(in_oklch,var(--card)_88%,transparent)] px-2 text-[13px] text-[var(--foreground)] opacity-90 shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.35)] backdrop-blur-sm"
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
}: {
  draft: { requestId: number; kind: 'note' | 'folder'; value: string };
  depth: number;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className="flex h-8 items-center px-1.5"
      style={{ marginLeft: TREE_EDGE_GUTTER + depth * INDENT_PER_LEVEL }}
    >
      {draft.kind === 'folder' ? (
        <FolderSimpleIcon className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
      ) : (
        <FileTypeIcon path={draft.value || 'new-note.md'} className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
      )}
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
        className="ml-1.5 h-5 min-w-0 flex-1 border-0 bg-transparent px-0 text-[13px] outline-none"
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
  dragOver,
  dropTargetPath,
  onCreateNote,
  onCreateFolder,
  onPointerDown,
}: {
  item: DocTreeItem;
  depth: number;
  expanded: boolean;
  active: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onOpenInNewTab?: () => void;
  dragOver: boolean;
  dropTargetPath: string;
  onCreateNote: () => void;
  onCreateFolder: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const { t } = useI18n();
  const isFolder = item.type === 'folder';
  const FolderIcon = expanded ? FolderOpenIcon : FolderSimpleIcon;
  const [memo, setMemo] = useState<MemoItem | null>(null);

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
  return (
    <ContextMenu onOpenChange={(open) => { if (open) void loadMemo(); }}>
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
            'group relative flex h-8 cursor-pointer items-center rounded-lg px-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--brand)]',
            active
              ? 'bg-[color-mix(in_oklch,var(--brand)_12%,var(--card))] font-medium text-[var(--foreground)] before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-[var(--brand)]'
              : 'hover:bg-[var(--muted)]',
            dragOver && 'bg-[color-mix(in_oklch,var(--brand)_15%,transparent)]',
          )}
          style={{
            marginLeft: TREE_EDGE_GUTTER + depth * INDENT_PER_LEVEL,
            width: `calc(100% - ${TREE_EDGE_GUTTER * 2 + depth * INDENT_PER_LEVEL}px)`,
          }}
        >
      {isFolder ? (
        <>
          <CaretRightIcon aria-hidden="true" className={cn(
            'h-3 w-3 shrink-0 text-[var(--muted-foreground)] transition-transform',
            expanded && 'rotate-90',
          )} />
          <FolderIcon aria-hidden="true" className="ml-1 h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
        </>
      ) : (
        <FileTypeIcon path={item.name} className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
      )}
      <span className="ml-1.5 min-w-0 flex-1 truncate">
        {isFolder ? item.name : displayTitleFromFilename(item.name)}
      </span>
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
  );
}

function isFolderParent(item: DocTreeItem, notebookPath: string): string {
  if (item.type === 'folder') return item.fullPath;
  return item.fullPath.slice(0, item.fullPath.lastIndexOf('/')) || notebookPath;
}

function findParentDepth(nodes: VisibleTreeNode[], parentPath: string): number {
  const target = canonicalPath(parentPath).replace(/\/+$/, '');
  return nodes.find(({ item }) => canonicalPath(item.fullPath) === target)?.depth ?? -1;
}

function isFolderDropZoneHighlighted(
  nodes: VisibleTreeNode[],
  index: number,
  targetPath: string | null,
): boolean {
  if (!targetPath) return false;
  const targetIndex = nodes.findIndex(({ item }) => (
    canonicalPath(item.fullPath) === canonicalPath(targetPath)
  ));
  if (targetIndex < 0 || index < targetIndex) return false;

  const targetDepth = nodes[targetIndex].depth;
  for (let cursor = targetIndex + 1; cursor <= index; cursor += 1) {
    if (nodes[cursor].depth <= targetDepth) return false;
  }
  return true;
}
