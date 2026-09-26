'use client';

import {
  memo,
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { FilePlusIcon, FileTextIcon, FolderPlusIcon, LinkIcon, PencilSimpleIcon, TrashSimpleIcon } from '@phosphor-icons/react';
import { ChevronRight, Eye, EyeOff, FolderPlus, MoreHorizontal, Plus } from 'lucide-react';

import { toast } from '@/lib/toast';
import { cn, displayTitleFromFilename } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { getMemoColorLabel, MemoCardActions } from '@features/memo/components/memo-card-actions';
import { memoRepository } from '@features/memo/services/memo-repository';
import { MEMO_COLORS, MEMO_COLOR_HEX, useMemoStore } from '@features/memo/store/memo-store';
import type { MemoColor, MemoItem } from '@/types/memo-item';
import { resolveMemoByPath } from '@features/memo/use-cases/open-by-target';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, useContextMenuContext } from '@shared/ui/context-menu';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import folderIcon from '@/assets/folder-outline.svg?raw';
import { getPropertyIconOption } from '@features/document/properties/property-icons';
import { resourceKindFromPath } from '@features/editor/code-file';
import { setShowHiddenNotebookFilesPreference } from '@features/preferences/public/runtime-api';
import { FileTypeIcon } from '@features/memo/components/file-type-icon';
import { memos, product, type DocTreeItem } from '@platform/tauri/client';
import { canUseNativeContextMenu, logNativeContextMenuError, popupNativeContextMenu, type NativeContextMenuItems } from '@platform/tauri/native-context-menu';

const TREE_MENU_CLASS =
  'w-[180px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]';
const TREE_MENU_ITEM_CLASS =
  'h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';
const TREE_MENU_DIVIDER_CLASS = 'mx-1 my-1 h-px bg-[var(--border-popup)] opacity-60';
const TREE_EDGE_GUTTER = 6;
const INDENT_PER_LEVEL = 20;

const NOTEBOOK_AGENT_PROJECT_FOLDER_NAMES = new Set([
  '.agents',
  '.codex',
  '.claude',
  '.dsh',
  '.opencode',
  '.hermes',
]);

export const NotebookTreeRow = memo(function NotebookTreeRow({
  item,
  parentPath,
  posInSet,
  setSize,
  depth,
  expanded,
  active,
  selected,
  onToggle,
  onOpen,
  onOpenInNewTab,
  onCreateNote,
  onCreateFolder,
  onRename,
  onDeleteFolder,
  onDeleteResource,
  hiddenFromList,
  onToggleListVisibility,
  onPointerDown,
  onKeyDown,
  onFocus,
  onKeepAliveChange,
  tabIndex = 0,
  moveStatus,
}: {
  item: DocTreeItem;
  parentPath: string;
  posInSet?: number;
  setSize?: number;
  depth: number;
  expanded: boolean;
  active: boolean;
  selected: boolean;
  onToggle: (path: string) => void;
  onOpen: (path: string, event?: ReactMouseEvent<HTMLDivElement>) => void;
  onOpenInNewTab?: (path: string) => void;
  onCreateNote: (parentPath: string) => void;
  onCreateFolder: (parentPath: string) => void;
  onRename: (item: DocTreeItem, nextName: string) => Promise<void> | void;
  onPointerDown: (item: DocTreeItem, event: ReactPointerEvent<HTMLDivElement>) => void;
  onDeleteFolder?: (path: string) => Promise<void>;
  onDeleteResource?: (item: DocTreeItem) => Promise<void>;
  hiddenFromList?: boolean;
  onToggleListVisibility?: (folderPath: string) => void;
  onKeyDown?: (path: string, event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onFocus?: (path: string) => void;
  onKeepAliveChange?: (path: string, active: boolean) => void;
  tabIndex?: number;
  moveStatus?: 'moving' | 'success';
}) {
  const { t, language } = useI18n();
  const isFolder = item.type === 'folder';
  const sourceFolderName = item.fullPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? item.name;
  const isHiddenFolder = isFolder && sourceFolderName.startsWith('.');
  const isInHiddenDirectory = isFolder && (
    isHiddenFolder
    || item.fullPath
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .slice(0, -1)
      .some((part) => part.startsWith('.') && part !== '.' && part !== '..')
  );
  const isAgentProjectFolder = isFolder
    && depth === 0
    && NOTEBOOK_AGENT_PROJECT_FOLDER_NAMES.has(sourceFolderName);
  const actionParentPath = isFolder ? item.fullPath : parentPath;
  const resourceKind = isFolder ? null : item.resourceKind ?? resourceKindFromPath(item.name);
  const isNote = resourceKind === 'note';
  const isMediaResource = resourceKind === 'image' || resourceKind === 'video';
  const [memo, setMemo] = useState<MemoItem | null>(null);
  // The memo is initially loaded by path because the file tree can contain
  // notes outside the currently loaded list query. Keep listening to the
  // store as well so changes made from the work column are reflected here
  // immediately, without requiring a tree refresh.
  const storeMemo = useMemoStore((state) => {
    const memoId = item.memoMeta?.id ?? memo?.id;
    if (!memoId) return null;
    return state.memos.find((candidate) => candidate.id === memoId)
      ?? (state.selectedMemo?.id === memoId ? state.selectedMemo : null);
  });
  const displayedMemo = storeMemo ?? memo;
  // `memo` is loaded from read_memo for the initial render. Once the memo
  // store receives the write event, prefer that authoritative snapshot so
  // property changes made in the document view appear without a tree refresh.
  const displayedIcon = displayedMemo
    ? displayedMemo.icon
    : item.memoMeta?.icon ?? null;
  const displayedColors = displayedMemo
    ? displayedMemo.colors
    : item.memoMeta?.colors ?? [];
  const noteIcon = isNote && displayedIcon
    ? getPropertyIconOption(displayedIcon)
    : null;
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(
    isFolder || !isNote ? item.name : displayTitleFromFilename(item.name),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmResourceDelete, setConfirmResourceDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const keepsVirtualRowAlive = contextMenuOpen
    || renaming
    || confirmDelete
    || confirmResourceDelete
    || deleting;
  useEffect(() => {
    onKeepAliveChange?.(item.fullPath, keepsVirtualRowAlive);
    return () => {
      if (keepsVirtualRowAlive) onKeepAliveChange?.(item.fullPath, false);
    };
  }, [item.fullPath, keepsVirtualRowAlive, onKeepAliveChange]);

  const loadMemo = useCallback(async () => {
    if (isFolder || !isNote) return null;
    const memoId = item.memoMeta?.id
      ?? (await resolveMemoByPath(item.fullPath))?.memoId;
    if (!memoId) return null;
    const state = useMemoStore.getState();
    const cached = state.memos.find((candidate) => candidate.id === memoId)
      ?? (state.selectedMemo?.id === memoId ? state.selectedMemo : null);
    if (cached) {
      setMemo(cached);
      return cached;
    }
    const loaded = await memos.readMemo(memoId);
    if (loaded) setMemo(loaded);
    return loaded;
  }, [isFolder, isNote, item.fullPath, item.memoMeta?.id]);

  const toggleFavorite = useCallback(async (nextMemo: Pick<MemoItem, 'id' | 'favorited'>) => {
    await (nextMemo.favorited
      ? memoRepository.unfavorite(nextMemo.id)
      : memoRepository.favorite(nextMemo.id));
    setMemo((current) => current?.id === nextMemo.id
      ? { ...current, favorited: !nextMemo.favorited }
      : current);
    useMemoStore.getState().triggerRefresh();
  }, []);

  const changeColors = useCallback(async (nextMemo: Pick<MemoItem, 'id'>, colors: MemoColor[]) => {
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
      await onDeleteFolder(item.fullPath);
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }, [deleting, item.fullPath, onDeleteFolder]);

  const confirmMediaDelete = useCallback(async () => {
    if (!onDeleteResource || deleting) return;
    setDeleting(true);
    try {
      await onDeleteResource(item);
      setConfirmResourceDelete(false);
    } finally {
      setDeleting(false);
    }
  }, [deleting, item, onDeleteResource]);

  const submitRename = useCallback(() => {
    if (!renaming) return;
    setRenaming(false);
    void onRename(item, renameValue);
  }, [item, onRename, renameValue, renaming]);

  const cancelRename = useCallback(() => {
    setRenaming(false);
    setRenameValue(isFolder || !isNote ? item.name : displayTitleFromFilename(item.name));
  }, [isFolder, isNote, item.name]);

  const showNativeContextMenu = async (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!canUseNativeContextMenu()) return;
    event.preventDefault();
    event.stopPropagation();

    // Build the menu synchronously from tree metadata. Full memo loading is
    // deferred until an action actually needs the complete record, so a slow
    // read_memo call cannot delay the native popup itself.
    const nativeMemo = displayedMemo;
    const memoId = nativeMemo?.id ?? item.memoMeta?.id ?? null;
    const memoFavorited = nativeMemo?.favorited ?? item.memoMeta?.favorited ?? false;
    const memoColors = nativeMemo?.colors ?? item.memoMeta?.colors ?? [];
    const runWithMemo = (action: (loaded: MemoItem) => void) => {
      void (nativeMemo ? Promise.resolve(nativeMemo) : loadMemo())
        .then((loaded) => {
          if (loaded) action(loaded);
          else toast.error(t('memo.fileTree.openFailed'));
        })
        .catch((error) => {
          logNativeContextMenuError('notebook tree memo action', error);
          toast.error(t('memo.fileTree.openFailed'));
        });
    };
    const items: NativeContextMenuItems = [
      { text: t('memo.fileTree.newNote'), action: () => onCreateNote(actionParentPath) },
      { text: t('memo.fileTree.newFolder'), action: () => onCreateFolder(actionParentPath) },
      {
        text: t('memo.fileTree.rename'),
        action: () => {
          setRenameValue(isFolder || !isNote ? item.name : displayTitleFromFilename(item.name));
          setRenaming(true);
        },
      },
    ];

    if (isFolder && onToggleListVisibility) {
      items.push(
        { item: 'Separator' },
        {
          text: t(hiddenFromList ? 'memo.fileTree.showInList' : 'memo.fileTree.hideFromList'),
          action: () => onToggleListVisibility(item.fullPath),
        },
      );
    }

    if (isFolder) {
      if (onDeleteFolder) {
        items.push({ text: t('memo.fileTree.copyLink'), action: () => void navigator.clipboard.writeText(item.fullPath) });
      }
      if (isAgentProjectFolder) {
        items.push(
          { item: 'Separator' },
          { text: t('memo.fileTree.hideAgentProjectFolder'), action: () => void setShowHiddenNotebookFilesPreference(false) },
        );
      } else if (onDeleteFolder) {
        items.push(
          { item: 'Separator' },
          { text: t('memo.fileTree.delete'), action: () => setConfirmDelete(true) },
        );
      }
    } else if (isMediaResource && onDeleteResource) {
      items.push(
        { item: 'Separator' },
        { text: t('media.fileTree.delete'), action: () => setConfirmResourceDelete(true) },
      );
    } else if (isNote) {
      const selectedColors = new Set(memoColors);
      items.push(
        { item: 'Separator' },
        ...(onOpenInNewTab ? [{
          text: t('memo.action.openInSplit'),
          action: () => onOpenInNewTab(item.fullPath),
        }] : []),
        {
          text: t(memoFavorited ? 'memo.action.unpin' : 'memo.action.pin'),
          action: () => runWithMemo((loaded) => void toggleFavorite(loaded)),
        },
        {
          text: t('document.action.properties'),
          enabled: Boolean(memoId),
          action: () => {
            if (!memoId) return;
            window.dispatchEvent(new CustomEvent('flowix:open-note-properties', {
              detail: { memoId },
            }));
          },
        },
        {
          text: t('document.action.copyLink'),
          action: () => void navigator.clipboard.writeText(item.fullPath),
        },
        {
          text: t('document.action.copyFullText'),
          action: () => void memos.readDocument(item.fullPath)
            .then((content) => navigator.clipboard.writeText(content ?? '')),
        },
        {
          text: t('memo.fileTree.reveal'),
          action: () => void product.revealInFileManager(item.fullPath),
        },
        {
          text: t('memo.list.filterColorGroup'),
          items: [
            {
              text: t('document.color.clear'),
              checked: memoColors.length === 0,
              action: () => runWithMemo((loaded) => void changeColors(loaded, [])),
            },
            { item: 'Separator' },
            ...MEMO_COLORS.map((color) => ({
              text: getMemoColorLabel(color, language),
              checked: selectedColors.has(color),
              action: () => {
                const next = new Set(selectedColors);
                if (next.has(color)) next.delete(color);
                else next.add(color);
                runWithMemo((loaded) => void changeColors(loaded, MEMO_COLORS.filter((value) => next.has(value))));
              },
            })),
          ],
        },
        { item: 'Separator' },
        { text: t('memo.action.delete'), action: () => runWithMemo(requestDelete) },
      );
    }

    await popupNativeContextMenu(event, items);
  };

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
          aria-selected={!isFolder ? active || selected : undefined}
          aria-level={depth + 1}
          aria-posinset={posInSet}
          aria-setsize={setSize}
          tabIndex={tabIndex}
          data-notebook-tree-path={item.fullPath}
          data-notebook-tree-kind={isFolder ? 'folder' : resourceKind}
          data-move-status={moveStatus}
          title={item.fullPath}
          onContextMenu={(event) => {
            void showNativeContextMenu(event).catch((error) => {
              logNativeContextMenuError('notebook tree', error);
              toast.error(t('memo.fileTree.openFailed'));
            });
          }}
          onClick={isFolder
            ? () => onToggle(item.fullPath)
            : (event) => onOpen(item.fullPath, event)}
          onDoubleClick={!isFolder && onOpenInNewTab
            ? () => onOpenInNewTab(item.fullPath)
            : undefined}
          onFocus={() => onFocus?.(item.fullPath)}
          onPointerDown={(event) => {
            if (renaming) {
              event.stopPropagation();
              return;
            }
            if (event.button !== 0) return;
            onPointerDown(item, event);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              if (isFolder) onToggle(item.fullPath); else onOpen(item.fullPath);
              return;
            }
            onKeyDown?.(item.fullPath, event);
          }}
          className={cn(
            'folder-file-tree__item group relative flex h-8 cursor-default items-center rounded-lg px-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--brand)]',
            moveStatus === 'moving' && 'notebook-file-tree__item--moving',
            moveStatus === 'success' && 'notebook-file-tree__item--move-success',
            active || selected
              ? 'bg-[var(--muted)] font-medium text-[var(--foreground)]'
              : cn('hover:bg-[var(--muted)]', contextMenuOpen && 'bg-[var(--muted)] text-[var(--foreground)]'),
          )}
          style={{
            marginLeft: TREE_EDGE_GUTTER + depth * INDENT_PER_LEVEL,
            width: `calc(100% - ${TREE_EDGE_GUTTER * 2 + depth * INDENT_PER_LEVEL}px)`,
          }}
        >
      {renaming ? (
        <>
          <span
            aria-hidden="true"
            className={cn(
              'relative flex h-[15px] w-[15px] shrink-0 items-center justify-center',
              isFolder
                ? (isInHiddenDirectory ? 'text-[var(--muted-foreground)]' : 'text-[var(--brand)]')
                : 'text-[color-mix(in_oklch,var(--foreground)_90%,white_10%)]',
              isInHiddenDirectory && 'opacity-80',
            )}
          >
            {isFolder ? (
              <span
                className="absolute inset-0 flex items-center justify-center"
                dangerouslySetInnerHTML={{ __html: folderIcon }}
              />
            ) : (
              <FileTypeIcon
                path={item.name}
                className="h-[15px] w-[15px]"
              />
            )}
          </span>
          <input
            autoFocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={submitRename}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                submitRename();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelRename();
              }
            }}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            className="ml-1.5 h-5 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm outline-none"
          />
        </>
      ) : (
        <>
          {isFolder ? (
            <span aria-hidden="true" className={cn(
              'relative h-[15px] w-[15px] shrink-0',
              isInHiddenDirectory ? 'text-[var(--muted-foreground)]' : 'text-[var(--brand)]',
            )}>
              <span
                className={cn(
                  'absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0',
                  isInHiddenDirectory && 'opacity-80',
                )}
                dangerouslySetInnerHTML={{ __html: folderIcon }}
              />
              <ChevronRight className={cn(
                'absolute inset-0 h-[15px] w-[15px] opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 group-focus-visible:opacity-100',
                expanded && 'rotate-90',
              )} />
            </span>
          ) : (
            <span className="relative flex h-[15px] w-[15px] shrink-0 items-center justify-center text-[color-mix(in_oklch,var(--foreground)_90%,white_10%)]">
              {noteIcon ? (
                <img
                  src={noteIcon.src}
                  alt=""
                  aria-hidden="true"
                  className="h-[15px] w-[15px] object-contain"
                  draggable={false}
                />
              ) : isNote ? (
                <FileTextIcon aria-hidden="true" className="h-[15px] w-[15px]" />
              ) : (
                <FileTypeIcon path={item.name} className="h-[15px] w-[15px]" />
              )}
            </span>
          )}
          {!isFolder && isNote && displayedColors.length > 0 && (
            <span
              aria-label="Note colors"
              className="ml-1.5 inline-flex h-6 shrink-0 items-center justify-center gap-0.5"
            >
              {displayedColors.map((color) => (
                <span
                  key={color}
                  aria-hidden="true"
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: MEMO_COLOR_HEX[color] }}
                />
              ))}
            </span>
          )}
          <span className={cn(
            'min-w-0 flex-1 truncate',
            'ml-1',
            !isFolder && 'text-[color-mix(in_oklch,var(--foreground)_90%,transparent)]',
          )}>
            {isFolder
              ? item.name
              : !isNote ? item.name : displayTitleFromFilename(item.name)}
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
                  onCreateNote(actionParentPath);
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
                  onCreateFolder(actionParentPath);
                }}
                onKeyDown={(event) => event.stopPropagation()}
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--brand)]"
              >
                <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </span>
          )}
        </>
      )}
      {!renaming && moveStatus && (
        <span
          aria-label={t(moveStatus === 'moving' ? 'memo.fileTree.moving' : 'memo.fileTree.moved')}
          className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center text-[var(--brand)]"
        >
          {moveStatus === 'moving' ? (
            <span aria-hidden="true" className="notebook-file-tree__moving-indicator" />
          ) : (
            <span aria-hidden="true" className="text-xs font-semibold">✓</span>
          )}
        </span>
      )}
      {!renaming && !moveStatus && (
        <NotebookTreeMoreButton
          label={t('memo.fileTree.moreActions')}
          active={contextMenuOpen}
        />
      )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className={TREE_MENU_CLASS}>
        <ContextMenuItem onClick={() => onCreateNote(actionParentPath)} className={TREE_MENU_ITEM_CLASS}>
          <FilePlusIcon className="mr-2 h-4 w-4" />
          {t('memo.fileTree.newNote')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onCreateFolder(actionParentPath)} className={TREE_MENU_ITEM_CLASS}>
          <FolderPlusIcon className="mr-2 h-4 w-4" />
          {t('memo.fileTree.newFolder')}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => {
            setRenameValue(isFolder || !isNote ? item.name : displayTitleFromFilename(item.name));
            setRenaming(true);
          }}
          className={TREE_MENU_ITEM_CLASS}
        >
          <PencilSimpleIcon className="mr-2 h-4 w-4" />
          {t('memo.fileTree.rename')}
        </ContextMenuItem>
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
        {isFolder && (onDeleteFolder || isAgentProjectFolder || onToggleListVisibility) && (
          <>
            <div role="separator" aria-hidden="true" className={TREE_MENU_DIVIDER_CLASS} />
            {onToggleListVisibility && (
              <ContextMenuItem
                onClick={() => onToggleListVisibility(item.fullPath)}
                className={TREE_MENU_ITEM_CLASS}
              >
                {hiddenFromList ? <Eye className="mr-2 h-4 w-4" /> : <EyeOff className="mr-2 h-4 w-4" />}
                {t(hiddenFromList ? 'memo.fileTree.showInList' : 'memo.fileTree.hideFromList')}
              </ContextMenuItem>
            )}
            {isAgentProjectFolder ? (
              <ContextMenuItem
                onClick={() => void setShowHiddenNotebookFilesPreference(false)}
                className={TREE_MENU_ITEM_CLASS}
              >
                <EyeOff className="mr-2 h-4 w-4" />
                {t('memo.fileTree.hideAgentProjectFolder')}
              </ContextMenuItem>
            ) : onDeleteFolder ? (
              <ContextMenuItem
                onClick={() => setConfirmDelete(true)}
                className={cn(TREE_MENU_ITEM_CLASS, 'hover:bg-transparent hover:text-[var(--destructive)]')}
              >
                <TrashSimpleIcon className="mr-2 h-4 w-4" />
                {t('memo.fileTree.delete')}
              </ContextMenuItem>
            ) : null}
          </>
        )}
        {!isFolder && (
          <div role="separator" aria-hidden="true" className={TREE_MENU_DIVIDER_CLASS} />
        )}
        {!isFolder && isMediaResource && onDeleteResource && (
          <ContextMenuItem
            onClick={() => setConfirmResourceDelete(true)}
            className={cn(TREE_MENU_ITEM_CLASS, 'hover:bg-transparent hover:text-[var(--destructive)]')}
          >
            <TrashSimpleIcon className="mr-2 h-4 w-4" />
            {t('media.fileTree.delete')}
          </ContextMenuItem>
        )}
        {!isFolder && isNote && displayedMemo && (
          <MemoCardActions
            memo={displayedMemo}
            filePath={item.fullPath}
            onOpenInSplit={onOpenInNewTab
              ? () => onOpenInNewTab(item.fullPath)
              : undefined}
            onFavoriteToggle={(nextMemo) => { void toggleFavorite(nextMemo); }}
            onDelete={requestDelete}
            onColorsChange={(nextMemo, colors) => { void changeColors(nextMemo, colors); }}
            Item={ContextMenuItem}
          />
        )}
        {!isFolder && isNote && !displayedMemo && (
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
            <button type="button" disabled={deleting} onClick={() => void confirmFolderDelete()} className="h-8 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--foreground)] hover:border-[var(--destructive)] hover:bg-[var(--destructive)] hover:text-white disabled:opacity-50">
              {t('dialog.delete')}
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmResourceDelete} onOpenChange={(open) => {
        if (!open && !deleting) setConfirmResourceDelete(false);
      }}>
        <DialogContent className="rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <DialogHeader>
            <DialogTitle>{t('media.fileTree.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('media.fileTree.deleteDescription', { name: item.name })}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              disabled={deleting}
              onClick={() => setConfirmResourceDelete(false)}
              className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]"
            >
              {t('dialog.cancel')}
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={() => void confirmMediaDelete()}
              className="h-8 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--foreground)] hover:border-[var(--destructive)] hover:bg-[var(--destructive)] hover:text-white disabled:opacity-50"
            >
              {t('dialog.delete')}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
});

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
