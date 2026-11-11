'use client';

import { DialogFooter } from '@shared/ui/dialog-footer';
import { Button } from '@shared/ui/button';

import { collectionIndexPathForFolder } from '@features/collection/public/folder-api';
import { CollectionResourceIcon } from '@features/collection/public/appearance-api';

import {
  memo,
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  CopyIcon,
  FolderOpenIcon,
  MapPinSimpleAreaIcon,
  PencilSimpleIcon,
  PushPin,
  SquareSplitHorizontalIcon,
  TrashSimpleIcon,
} from '@phosphor-icons/react';
import { ChevronRight, Loader2, MoreHorizontal } from 'lucide-react';

import { toast } from '@/lib/toast';
import { cn, displayTitleFromFilename, isCollectionIndexFilename } from '@/lib/utils';
import { canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { useI18n } from '@/lib/i18n';
import { MemoCardActions } from '@features/memo/components/memo-card-actions';
import { NotebookCreateContextMenuItems } from '@features/memo/components/notebook-create-context-menu';
import { NotebookCopyContextMenu } from '@features/memo/components/notebook-copy-context-menu';
import { noteRepository } from '@features/memo/services/note-repository';
import { NOTE_COLOR_HEX, noteIndexFor, noteLookupKey, useNoteStore } from '@features/memo/store/note-store';
import type { NoteColor, NoteListItem } from '@/types/note-item';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSubmenu, ContextMenuTrigger, useContextMenuContext } from '@shared/ui/context-menu';
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import folderIcon from '@/assets/folder-outline.svg?raw';
import folderIconDefault from '@/assets/folder-outline-default.svg?raw';
import { useNoteMetadata } from '../hooks/use-note-metadata';
import { noteMetadata } from '../services/note-metadata-service';
import { resourceKindFromPath } from '@features/editor/code-file';
import { ContentIcon, getFileIconKind, HtmlFileIcon } from '@features/content/public/content-api';
import { resolveRowCollectionType } from './collection-row-icon';
import type { PinnedTreeItem } from './use-notebook-pinned-notes';
import { TreeIconPicker } from './tree-icon-picker';
import { setDocumentProperties } from '@features/document/public/path-properties';
import { notes, product, type DocTreeItem } from '@platform/tauri/client';
import { logNativeContextMenuError } from '@platform/tauri/native-context-menu';
import type { TableViewType } from '@features/multidimensional-table/public/create-api';

const TREE_MENU_CLASS =
  'w-[180px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]';

const TREE_MENU_ITEM_CLASS =
  'h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';

const TREE_EDGE_GUTTER = 6;
const INDENT_PER_LEVEL = 20;
/** 等待区分单击和双击，避免双击文件夹时先触发选择和打开。 */
export const FOLDER_SINGLE_CLICK_DELAY_MS = 300;

/** 文件夹单击要带上的修饰键快照: 定时器回调里不能再读合成事件。 */
export interface TreeRowClickModifiers {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/**
 * 待确认的文件夹单击。树里同一时刻只可能有一次待定单击, 后一次交互
 * (按下任意行、双击、点展开按钮) 直接顶掉它, 否则慢一拍的回调会盖掉
 * 用户刚做出的新选择。
 */
let pendingFolderClickTimer: ReturnType<typeof setTimeout> | null = null;

const cancelPendingFolderClick = () => {
  if (pendingFolderClickTimer === null) return;
  clearTimeout(pendingFolderClickTimer);
  pendingFolderClickTimer = null;
};

const scheduleFolderSingleClick = (run: () => void) => {
  cancelPendingFolderClick();
  pendingFolderClickTimer = setTimeout(() => {
    pendingFolderClickTimer = null;
    run();
  }, FOLDER_SINGLE_CLICK_DELAY_MS);
};

/**
 * 隐藏文件夹 (`.` 开头) 的弱化: 图标压到 50%, 名称文案再乘 80%。
 * 文案本身还有一层 0.82 (选中/激活时为 1) 的行内弱化, 隐藏时再乘一次,
 * 保证 `.trash` / `.claude` 这类目录明显比普通文件夹淡。
 */
const HIDDEN_FOLDER_ICON_OPACITY_CLASS = 'opacity-50';
const HIDDEN_FOLDER_LABEL_OPACITY = 0.8;

export const NotebookTreeRow = memo(function NotebookTreeRow({
  item,
  notebookPath,
  parentPath,
  posInSet,
  setSize,
  depth,
  expanded,
  isLoadingChildren = false,
  childrenError = false,
  onRetryChildren,
  active,
  selected,
  onToggle,
  onSelectFolder,
  onOpen,
  onOpenInNewTab,
  onCreateNote,
  onCreateFolder,
  onCreateView,
  onCreateMediaLibrary,
  onCreateWorkDocuments,
  onImportFiles,
  onImportFolder,
  onRename,
  onDeleteFolder,
  onDeleteFile,
  onDeleteSelected,
  onSetDefaultFolder,
  isDefaultFolder,
  isPinnedFolder = false,
  onTogglePinnedFolder,
  onPointerDown,
  onKeyDown,
  onFocus,
  onKeepAliveChange,
  favoritePath,
  onFavoriteChanged,
  pinned,
  onTogglePinned,
  tableDocumentIdentity,
  mediaLibraryIdentity,
  workDocumentsCollection = false,
  tabIndex = 0,
  moveStatus,
  cut = false,
}: {
  item: DocTreeItem;
  notebookPath: string;
  parentPath: string;
  posInSet?: number;
  setSize?: number;
  depth: number;
  expanded: boolean;
  isLoadingChildren?: boolean;
  childrenError?: boolean;
  onRetryChildren?: (path: string) => void;
  active: boolean;
  selected: boolean;
  onToggle: (path: string) => void;
  onSelectFolder?: (path: string, modifiers?: TreeRowClickModifiers) => void;
  onOpen: (path: string, event?: ReactMouseEvent<HTMLDivElement>) => void;
  onOpenInNewTab?: (path: string) => void;
  onCreateNote: (parentPath: string) => void;
  onCreateFolder: (parentPath: string) => void;
  onCreateView: (parentPath: string, viewType?: TableViewType) => void;
  onCreateMediaLibrary: (parentPath: string) => void;
  onCreateWorkDocuments?: (parentPath: string) => void;
  onImportFiles?: (parentPath: string) => void;
  onImportFolder?: (parentPath: string) => void;
  onRename: (item: DocTreeItem, nextName: string) => Promise<boolean | void> | boolean | void;
  onPointerDown: (item: DocTreeItem, event: ReactPointerEvent<HTMLDivElement>) => void;
  onDeleteFolder?: (path: string) => Promise<void>;
  onDeleteSelected?: () => Promise<void>;
  onDeleteFile?: (item: DocTreeItem, options?: { silent?: boolean }) => Promise<boolean | void>;
  onSetDefaultFolder?: (folderPath: string) => void;
  isDefaultFolder?: boolean;
  isPinnedFolder?: boolean;
  onTogglePinnedFolder?: (folderPath: string) => void | Promise<void>;
  onKeyDown?: (path: string, event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onFocus?: (path: string) => void;
  onKeepAliveChange?: (path: string, active: boolean) => void;
  favoritePath?: string;
  onFavoriteChanged?: (itemId: string, favorited: boolean) => void;
  /** Pin state for documents and collections; notes use `memoMeta.favorited`. */
  pinned?: boolean;
  onTogglePinned?: (nextPinned: boolean) => void | Promise<void>;
  /**
   * Presence marks the row as a known collection even when the filename is not
   * conclusive; `identityConflict` is what surfaces the repair action, since the
   * Views section no longer exists to hide rows from.
   */
  tableDocumentIdentity?: { identityConflict?: boolean; onMakeIdentityUnique?: () => void };
  mediaLibraryIdentity?: { identityConflict?: boolean; onMakeIdentityUnique?: () => void };
  workDocumentsCollection?: boolean;
  tabIndex?: number;
  moveStatus?: 'moving' | 'success';
  cut?: boolean;
}) {
  const { t } = useI18n();
  const isFolder = item.type === 'folder';
  const selectFolderOnSingleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    // 第二次点击 (detail > 1) 属于双击, 取消待定的单击, 只保留展开。
    if (event.detail > 1) {
      cancelPendingFolderClick();
      return;
    }
    // detail === 0 是程序化 / 辅助技术激活: 没有双击窗口, 按普通单击立即处理。
    if (event.detail === 0) {
      cancelPendingFolderClick();
      onSelectFolder?.(item.fullPath);
      return;
    }
    const modifiers: TreeRowClickModifiers = {
      ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
    };
    scheduleFolderSingleClick(() => onSelectFolder?.(item.fullPath, modifiers));
  };
  const toggleFolderOnDoubleClick = () => {
    cancelPendingFolderClick();
    onToggle(item.fullPath);
  };
  const sourceFolderName = item.fullPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? item.name;
  const isHiddenFolder = isFolder
    && sourceFolderName.startsWith('.')
    && sourceFolderName !== '.'
    && sourceFolderName !== '..';
  const actionParentPath = isFolder ? item.fullPath : parentPath;
  const resourceKind = isFolder ? null : item.resourceKind ?? resourceKindFromPath(item.name);
  const isNote = resourceKind === 'note';
  // The backend is the only source of pin state; callers may override it for
  // synthesized rows, but normally the row reads the item's own flag.
  const isPinnedItem = pinned ?? item.pinned ?? false;
  // Folders pin through view preferences, so the caller usually passes
  // `onTogglePinnedFolder`; the pinned group instead reuses the shared toggle.
  const isPinnedFolderItem = isPinnedFolder || (isFolder && item.pinned === true);
  const toggleFolderPin = onTogglePinnedFolder
    ? () => { void onTogglePinnedFolder(item.fullPath); }
    : onTogglePinned
      ? () => { void onTogglePinned(!isPinnedFolderItem); }
      : null;
  const isHtmlFile = !isFolder && getFileIconKind(item.fullPath) === 'html';
  // Pinned titles omit extensions; their entry kind still identifies a collection
  // even when its indexed type is unknown or stale.
  const isPinnedCollection = (item as Partial<PinnedTreeItem>).pinnedEntryKind === 'collection';
  const collectionRowType = isFolder ? undefined : resolveRowCollectionType({
    collectionType: (item as Partial<PinnedTreeItem>).pinnedCollectionType,
    fileName: item.name,
    hasTableIdentity: Boolean(tableDocumentIdentity),
    hasMediaLibraryIdentity: Boolean(mediaLibraryIdentity),
    workDocumentsCollection,
  });
  const isTableDocument = collectionRowType === 'table';
  const isMediaLibrary = collectionRowType === 'media_library';
  const isCollectionIndex = !isFolder && isCollectionIndexFilename(item.name);
  const sidebarFolderDefault = <span className="flex h-[18px] w-[18px] items-center justify-center"
    dangerouslySetInnerHTML={{ __html: isDefaultFolder ? folderIconDefault : folderIcon }} />;
  const folderResourceIcon = isFolder ? <CollectionResourceIcon
    filePath={collectionIndexPathForFolder(item.fullPath)} notebookPath={notebookPath}
    className="h-[18px] w-[18px] object-contain"
    fallback={sidebarFolderDefault} folderDefault={sidebarFolderDefault}
  /> : null;
  const collectionResourceIcon = collectionRowType || isCollectionIndex || isPinnedCollection
    ? <CollectionResourceIcon filePath={item.fullPath} notebookPath={notebookPath} fallbackType={collectionRowType}
      folderDefault={/^\.index\.ya?ml$/i.test(item.fullPath.split(/[\\/]/).pop() ?? '') ? sidebarFolderDefault : undefined}
      className="h-[18px] w-[18px] object-contain" /> : null;
  const isExtensionlessDocument = isNote || isTableDocument || isMediaLibrary || isCollectionIndex || isPinnedCollection;
  // 树行标题不带后缀的范围：笔记 / 表格 / 媒体库 / 集合索引，外加已按网页图标渲染的
  // html。重命名输入框仍只认 isExtensionlessDocument —— 网页文件改名要保留后缀。
  const showsTitleWithoutExtension = isExtensionlessDocument || isHtmlFile;
  const [pathNote, setPathNote] = useState<NoteListItem | null>(null);
  const storeNote = useNoteStore((state) => {
    const notebook = state.notebooks.find((candidate) => item.fullPath.toLowerCase().startsWith(`${candidate.path.replace(/[\\/]+$/, '').toLowerCase()}\\`)
      || item.fullPath.toLowerCase().startsWith(`${candidate.path.replace(/[\\/]+$/, '').toLowerCase()}/`));
    if (!notebook) return null;
    const relativePath = item.fullPath.slice(notebook.path.replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/');
    return noteIndexFor(state.notes).get(noteLookupKey(notebook.id, relativePath)) ?? null;
  });
  const displayedMemo = storeNote ?? pathNote;
  // List cards and context-menu lookups are not metadata authorities for tree rows.
  const displayedMetadata = useNoteMetadata(item.fullPath, item.memoMeta, isNote);
  const displayedIcon = displayedMetadata?.icon ?? null;
  const displayedColors = displayedMetadata?.colors ?? [];
  const [noteIconSrc, setNoteIconSrc] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setNoteIconSrc(null);
    if (!isNote || !displayedIcon) return () => { active = false; };

    void import('@features/document/public/property-display-api')
      .then(({ getPropertyIconOption }) => {
        if (active) setNoteIconSrc(getPropertyIconOption(displayedIcon)?.src ?? null);
      })
      .catch(() => {
        if (active) setNoteIconSrc(null);
      });
    return () => { active = false; };
  }, [displayedIcon, isNote]);
  const noteIcon = noteIconSrc ? { src: noteIconSrc } : null;
  /** 列表里选中图标后写回 frontmatter flowix_icon；保存后由 notebook-change 事件驱动 useNoteMetadata 刷新。 */
  const persistNoteIcon = useCallback((next: string) => {
    void (async () => {
      let saved = false;
      try {
        saved = await setDocumentProperties(item.fullPath, { flowix_icon: next });
      } catch (error) {
        console.error('[notebook-tree-row] 设置笔记图标失败', error);
        toast.error(t('media.properties.saveFailed'));
        return;
      }
      if (!saved) {
        console.error('[notebook-tree-row] 设置笔记图标未落盘', item.fullPath);
        toast.error(t('media.properties.saveFailed'));
        return;
      }
      // 乐观更新本地投影，树行立即反馈；后端 resource-updated 事件随后以索引数据确认。
      const key = canonicalPath(item.fullPath);
      const current = noteMetadata.get(key).value;
      noteMetadata.update(key, {
        icon: next || null,
        colors: current?.colors ?? [],
        favorited: current?.favorited ?? false,
      });
    })();
  }, [item.fullPath, t]);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(
    isFolder || !isExtensionlessDocument ? item.name : displayTitleFromFilename(item.name),
  );
  const [renameSaving, setRenameSaving] = useState(false);
  const [optimisticName, setOptimisticName] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmFileDelete, setConfirmFileDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const keepsVirtualRowAlive = contextMenuOpen
    || renaming
    || renameSaving
    || confirmDelete
    || confirmFileDelete
    || deleting;
  useEffect(() => {
    onKeepAliveChange?.(item.fullPath, keepsVirtualRowAlive);
    return () => {
      if (keepsVirtualRowAlive) onKeepAliveChange?.(item.fullPath, false);
    };
  }, [item.fullPath, keepsVirtualRowAlive, onKeepAliveChange]);

  const loadMemo = useCallback(async () => {
    if (isFolder || !isNote) return null;
    const location = await notes.resolveLocation(item.fullPath);
    if (!location.indexable || !location.notebookId || !location.relativePath) return null;
    const cached = useNoteStore.getState().notes.find((candidate) => candidate.notebookId === location.notebookId && candidate.relativePath === location.relativePath);
    if (cached) { setPathNote(cached); return cached; }
    // Read the one row this row needs. Listing the notebook would serialize
    // every note's preview, tags, todos and properties to resolve a single path.
    const entry = await noteRepository.getIndexed(location.notebookId, location.relativePath);
    if (!entry) return null;
    const loaded: NoteListItem = { ...entry, kind: 'path-note', notebookId: location.notebookId, relativePath: location.relativePath, filename: location.relativePath.split('/').pop() || location.relativePath };
    setPathNote(loaded);
    return loaded;
  }, [isFolder, isNote, item.fullPath]);

  const toggleFavorite = useCallback(async (favorited: boolean, relativePath?: string) => {
    const targetPath = favoritePath ?? item.fullPath;
    try {
      const outcome = await (favorited
        ? noteRepository.unfavorite(targetPath)
        : noteRepository.favorite(targetPath));
      if (outcome === 'notSaved') {
        toast.error(t(favorited ? 'document.command.unpinFailed' : 'document.command.pinFailed'));
        return;
      }
      if (outcome === 'missingCleaned') {
        setPathNote(null);
        useNoteStore.setState((state) => ({
          notes: state.notes.filter((note) => {
            const notebook = state.notebooks.find((candidate) => candidate.id === note.notebookId);
            return !notebook || joinNotebookMemoPath(notebook.path, note.relativePath) !== targetPath;
          }),
        }));
        toast.success(t('memo.favorite.missingCleaned'));
      } else {
        setPathNote((current) => current && (!relativePath || current.relativePath === relativePath)
          ? { ...current, favorited: !favorited }
          : current);
      }
      onFavoriteChanged?.(item.id, outcome === 'missingCleaned' ? false : !favorited);
      useNoteStore.getState().triggerRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [favoritePath, item.fullPath, item.id, onFavoriteChanged, t]);

  const changeColors = useCallback(async (nextMemo: NoteListItem, colors: NoteColor[]) => {
    if (!await noteRepository.setColors(item.fullPath, colors)) return;
    setPathNote((current) => current?.relativePath === nextMemo.relativePath
      ? { ...current, colors }
      : current);
  }, [item.fullPath]);

  const requestDelete = useCallback((nextMemo: NoteListItem) => {
    window.dispatchEvent(new CustomEvent<NoteListItem>('flowix:request-delete-memo', {
      detail: nextMemo,
    }));
  }, []);

  const deleteNoteFromTree = useCallback(() => {
    void (displayedMemo ? Promise.resolve(displayedMemo) : loadMemo())
      .then((loaded) => {
        if (loaded) requestDelete(loaded);
        else toast.error(t('memo.fileTree.openFailed'));
      })
      .catch((error) => {
        logNativeContextMenuError('notebook tree delete action', error);
        toast.error(t('memo.fileTree.openFailed'));
      });
  }, [displayedMemo, loadMemo, requestDelete, t]);

  const revealInFileManager = useCallback(() => {
    void product.revealInFileManager(item.fullPath).catch((error) => {
      console.warn('[NotebookTreeRow] reveal in file manager failed', error);
      toast.error(t('memo.fileTree.openFailed'));
    });
  }, [item.fullPath, t]);

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

  const confirmFileDeleteAction = useCallback(async () => {
    if ((!onDeleteFile && !onDeleteSelected) || deleting) return;
    setDeleting(true);
    try {
      if (onDeleteSelected) await onDeleteSelected();
      else if (await onDeleteFile?.(item) === false) return;
      setConfirmFileDelete(false);
    } catch (error) {
      console.warn('[NotebookTreeRow] delete file failed', error);
      toast.error(t('document.external.deleteFileFailed'));
    } finally {
      setDeleting(false);
    }
  }, [deleting, item, onDeleteFile, onDeleteSelected, t]);

  const submitRename = useCallback(async () => {
    if (!renaming || renameSaving) return;
    const nextName = renameValue.trim();
    if (!nextName) {
      setRenaming(false);
      setRenameValue(isFolder || !isExtensionlessDocument ? item.name : displayTitleFromFilename(item.name));
      return;
    }
    setRenaming(false);
    setRenameSaving(true);
    setOptimisticName(nextName);
    try {
      const saved = await onRename(item, nextName);
      if (saved === false) setOptimisticName(null);
    } catch {
      setOptimisticName(null);
    } finally {
      setRenameSaving(false);
    }
  }, [isExtensionlessDocument, isFolder, item, onRename, renameSaving, renameValue, renaming]);

  const cancelRename = useCallback(() => {
    setRenaming(false);
    setRenameValue(isFolder || !isExtensionlessDocument ? item.name : displayTitleFromFilename(item.name));
  }, [isFolder, isExtensionlessDocument, item.name]);

  return (
    <>
      <ContextMenu onOpenChange={(open) => {
        setContextMenuOpen(open);
        if (open) void loadMemo();
      }}>
      <ContextMenuTrigger asChild>
        <div
          data-folder-selection={isFolder ? '' : undefined}
          role="treeitem"
          aria-expanded={isFolder ? expanded : undefined}
          aria-selected={active || selected}
          aria-level={depth + 1}
          aria-posinset={posInSet}
          aria-setsize={setSize}
          tabIndex={tabIndex}
          data-notebook-tree-path={item.fullPath}
          data-notebook-tree-kind={isFolder ? 'folder' : resourceKind}
          data-move-status={moveStatus}
          title={item.fullPath}
          onClick={isFolder
            ? selectFolderOnSingleClick
            : (event) => {
              cancelPendingFolderClick();
              onOpen(item.fullPath, event);
            }}
          onDoubleClick={isFolder
            ? toggleFolderOnDoubleClick
            : undefined}
          onFocus={() => onFocus?.(item.fullPath)}
          onPointerDown={(event) => {
            if (renaming) {
              event.stopPropagation();
              return;
            }
            // 有任何新的按下都作废上一次待定的文件夹单击。
            cancelPendingFolderClick();
            if (event.button !== 0) return;
            onPointerDown(item, event);
          }}
          onKeyUp={(event) => {
            if (event.key !== 'Tab' || event.target !== event.currentTarget) return;
            if (isFolder) onSelectFolder?.(item.fullPath); else onOpen(item.fullPath);
          }}
          onKeyDown={(event) => {
            cancelPendingFolderClick();
            if (event.key === 'Enter') {
              event.preventDefault();
              if (isFolder) onToggle(item.fullPath); else onOpen(item.fullPath);
              return;
            }
            if (event.key === ' ') {
              event.preventDefault();
              if (isFolder) onSelectFolder?.(item.fullPath); else onOpen(item.fullPath);
              return;
            }
            onKeyDown?.(item.fullPath, event);
          }}
          className={cn(
            'folder-file-tree__item group relative flex h-8 cursor-default items-center rounded-lg px-1.5 text-sm transition-colors focus:outline-none',
            cut && 'opacity-50',
            moveStatus === 'moving' && 'notebook-file-tree__item--moving',
            moveStatus === 'success' && 'notebook-file-tree__item--move-success',
            active || selected
              ? 'bg-[var(--muted)] text-[var(--foreground)]'
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
              'relative flex h-[18px] w-[18px] shrink-0 items-center justify-center',
              'text-[color-mix(in_oklch,var(--foreground)_70%,black_30%)] [[data-theme="dark"]_&]:text-[var(--foreground)] [[data-theme="mist"]_&]:text-[var(--foreground)]',
              isHiddenFolder && HIDDEN_FOLDER_ICON_OPACITY_CLASS,
            )}
          >
            {isFolder ? (
              <span className="absolute inset-0 flex items-center justify-center">{folderResourceIcon}</span>
            ) : isNote ? (
              <ContentIcon content={{ kind: 'note' }} className="notebook-file-tree__default-file-icon h-[18px] w-[18px]" />
            ) : (
              isHtmlFile
                ? <HtmlFileIcon className="h-[18px] w-[18px]" />
                : collectionResourceIcon ? collectionResourceIcon
                : <ContentIcon content={{ kind: 'file', path: item.name }} className="h-[18px] w-[18px]" />
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
            <button type="button" aria-label={expanded ? '收起文件夹' : '展开文件夹'} aria-expanded={expanded}
              onClick={(event) => {
                event.stopPropagation();
                if (event.detail > 1) return;
                onToggle(item.fullPath);
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => {
                event.stopPropagation();
                cancelPendingFolderClick();
              }}
              onKeyDown={(event) => event.stopPropagation()}
              className={cn(
              'relative h-5 w-5 shrink-0 rounded-md transition-colors group-hover:bg-[color-mix(in_oklch,var(--muted)_90%,var(--foreground)_10%)] group-focus-visible:bg-[color-mix(in_oklch,var(--muted)_90%,var(--foreground)_10%)] hover:bg-[color-mix(in_oklch,var(--muted)_90%,var(--foreground)_10%)] focus-visible:bg-[color-mix(in_oklch,var(--muted)_90%,var(--foreground)_10%)]',
              'text-[color-mix(in_oklch,var(--foreground)_70%,black_30%)] [[data-theme="dark"]_&]:text-[var(--foreground)] [[data-theme="mist"]_&]:text-[var(--foreground)]',
            )}>
              <span className={cn(
                'absolute left-1/2 top-1/2 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2',
                isHiddenFolder && HIDDEN_FOLDER_ICON_OPACITY_CLASS,
              )}>
                <span
                  className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0"
                >{folderResourceIcon}</span>
              </span>
              <ChevronRight className={cn(
                'absolute left-1/2 top-1/2 h-[15px] w-[15px] -translate-x-1/2 -translate-y-1/2 opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 group-focus-visible:opacity-100',
                expanded && 'rotate-90',
              )} />
            </button>
          ) : isNote ? (
            <TreeIconPicker value={displayedIcon ?? ''} onChange={persistNoteIcon}>
              {noteIcon ? (
                <img
                  src={noteIcon.src}
                  alt=""
                  aria-hidden="true"
                  className="h-[18px] w-[18px] object-contain"
                  draggable={false}
                />
              ) : (
                <ContentIcon content={{ kind: 'note' }} className="notebook-file-tree__default-file-icon h-[18px] w-[18px]" />
              )}
            </TreeIconPicker>
          ) : (
            <span className={'relative flex h-[18px] w-[18px] shrink-0 items-center justify-center text-[color-mix(in_oklch,var(--foreground)_70%,black_30%)] [[data-theme="dark"]_&]:text-[var(--foreground)] [[data-theme="mist"]_&]:text-[var(--foreground)]'}>
              {isHtmlFile
                ? <HtmlFileIcon className="h-[18px] w-[18px]" />
                : collectionResourceIcon ? collectionResourceIcon
                : <ContentIcon content={{ kind: 'file', path: item.name }} className="h-[18px] w-[18px]" />}
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
                  style={{ backgroundColor: NOTE_COLOR_HEX[color] }}
                />
              ))}
            </span>
          )}
          <span
            className={cn(
              'min-w-0 flex-1 truncate',
              'ml-1.5',
              active || selected ? 'opacity-100' : 'opacity-[0.82]',
            )}
            style={isHiddenFolder
              ? { opacity: (active || selected ? 1 : 0.82) * HIDDEN_FOLDER_LABEL_OPACITY }
              : undefined}
          >
            {optimisticName ?? (isFolder || !showsTitleWithoutExtension
              ? item.name
              : displayTitleFromFilename(item.name))}
          </span>
          {isFolder && isDefaultFolder && !renaming && (
            <span className="ml-2 shrink-0 text-xs text-[var(--muted-foreground)] opacity-50 transition-opacity duration-150 group-hover:opacity-0">
              {t('memo.fileTree.defaultNoteFolderLabel')}
            </span>
          )}
          {isFolder && isLoadingChildren && (
            <Loader2 className="ml-1 h-3.5 w-3.5 shrink-0 flowix-spin text-[var(--muted-foreground)]" aria-label={t('memo.fileTree.loading')} />
          )}
          {renameSaving && (
            <Loader2 className="ml-1 h-3.5 w-3.5 shrink-0 flowix-spin text-[var(--muted-foreground)]" aria-label={t('memo.fileTree.loading')} />
          )}
          {isFolder && expanded && childrenError && (
            <button
              type="button"
              className="ml-1 shrink-0 rounded-lg px-1.5 py-0.5 text-[11px] text-[var(--foreground)] hover:bg-[var(--muted)]"
              aria-label={t('memo.fileTree.unreadableHint')}
              title={t('memo.fileTree.unreadableHint')}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onRetryChildren?.(item.fullPath);
              }}
            >
              {t('error.retry')}
            </button>
          )}
        </>
      )}
      {!renaming && moveStatus && (
        <span
          aria-label={t(moveStatus === 'moving' ? 'memo.fileTree.moving' : 'memo.fileTree.moved')}
          className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center text-[var(--brand)]"
        >
          {moveStatus === 'moving' ? (
            <span aria-hidden="true" className="notebook-file-tree__moving-indicator flowix-spin" />
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
        {onDeleteSelected ? (
          <ContextMenuItem className={TREE_MENU_ITEM_CLASS} onClick={() => setConfirmFileDelete(true)}>
            <TrashSimpleIcon className="mr-2 h-4 w-4" />
            {t('memo.fileTree.delete')}
          </ContextMenuItem>
        ) : <>
        {!isFolder && onOpenInNewTab && (
          <ContextMenuItem onClick={() => onOpenInNewTab(item.fullPath)} className={TREE_MENU_ITEM_CLASS}>
            <SquareSplitHorizontalIcon className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('memo.fileTree.openInRight')}
          </ContextMenuItem>
        )}
        <NotebookCreateContextMenuItems
          onCreateNote={() => onCreateNote(actionParentPath)}
          onCreateFolder={() => onCreateFolder(actionParentPath)}
          onCreateTable={(viewType) => onCreateView(actionParentPath, viewType)}
          onCreateMediaLibrary={() => onCreateMediaLibrary(actionParentPath)}
          onCreateWorkDocuments={onCreateWorkDocuments ? () => onCreateWorkDocuments(actionParentPath) : undefined}
          onImportFiles={onImportFiles ? () => onImportFiles(actionParentPath) : undefined}
          onImportFolder={onImportFolder ? () => onImportFolder(actionParentPath) : undefined}
          contentCreationBlocked={item.indexExcluded === true}
        />
        <ContextMenuItem
          onClick={() => {
            setRenameValue(isFolder || !isExtensionlessDocument ? item.name : displayTitleFromFilename(item.name));
            setOptimisticName(null);
            setRenaming(true);
          }}
          className={TREE_MENU_ITEM_CLASS}
        >
          <PencilSimpleIcon className="mr-2 h-4 w-4" />
          {t('memo.fileTree.rename')}
        </ContextMenuItem>
        {isFolder && item.indexExcluded !== true && toggleFolderPin && (
          <ContextMenuItem onClick={toggleFolderPin} className={TREE_MENU_ITEM_CLASS}>
            <PushPin weight={isPinnedFolderItem ? 'fill' : 'regular'} className="mr-2 h-4 w-4" aria-hidden="true" />
            {t(isPinnedFolderItem ? 'memo.action.unpin' : 'memo.action.pin')}
          </ContextMenuItem>
        )}
        {!isFolder && !isNote && onTogglePinned && (
          <ContextMenuItem
            className={TREE_MENU_ITEM_CLASS}
            onClick={() => { void onTogglePinned(!isPinnedItem); }}
          >
            <PushPin weight={isPinnedItem ? 'fill' : 'regular'} className="mr-2 h-4 w-4" aria-hidden="true" />
            {t(isPinnedItem ? 'memo.action.unpin' : 'memo.action.pin')}
          </ContextMenuItem>
        )}
        {!isFolder && (!isNote || !displayedMemo) && <NotebookCopyContextMenu path={item.fullPath} isNote={isNote} />}
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
            <CopyIcon className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('memo.fileTree.copyPath')}
          </ContextMenuItem>
        )}
        {(isFolder || !isNote || !displayedMemo) && (
          <ContextMenuItem onClick={revealInFileManager} className={TREE_MENU_ITEM_CLASS}>
          <FolderOpenIcon className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('memo.fileTree.reveal')}
          </ContextMenuItem>
        )}
        {isFolder && item.indexExcluded !== true && onSetDefaultFolder && (
          <ContextMenuSubmenu
            label={t('memo.fileTree.folderUsageSubmenu')}
            icon={<MapPinSimpleAreaIcon className="h-4 w-4" aria-hidden="true" />}
          >
            <ContextMenuItem onClick={() => onSetDefaultFolder(item.fullPath)} className={TREE_MENU_ITEM_CLASS}>
              {t(isDefaultFolder ? 'memo.fileTree.unsetAsNotesFolder' : 'memo.fileTree.setAsNotesFolder')}
            </ContextMenuItem>
          </ContextMenuSubmenu>
        )}
        {isTableDocument && tableDocumentIdentity?.identityConflict && (
          <ContextMenuItem onClick={tableDocumentIdentity.onMakeIdentityUnique} disabled={!tableDocumentIdentity.onMakeIdentityUnique} className={TREE_MENU_ITEM_CLASS}>
            {t('multidimensionalTable.resolveIdentityConflict')}
          </ContextMenuItem>
        )}
        {isMediaLibrary && mediaLibraryIdentity?.identityConflict && (
          <ContextMenuItem onClick={mediaLibraryIdentity.onMakeIdentityUnique} disabled={!mediaLibraryIdentity.onMakeIdentityUnique} className={TREE_MENU_ITEM_CLASS}>
            {t('mediaLibrary.resolveIdentityConflict')}
          </ContextMenuItem>
        )}
        {isFolder && onDeleteFolder && (
          <>
            <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
            <ContextMenuItem
              onClick={() => setConfirmDelete(true)}
              className={cn(TREE_MENU_ITEM_CLASS, 'hover:bg-transparent hover:text-[var(--destructive)]')}
            >
              <TrashSimpleIcon className="mr-2 h-4 w-4" />
              {t('memo.fileTree.delete')}
            </ContextMenuItem>
          </>
        )}
        {!isFolder && !isNote && onDeleteFile && (
          <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
        )}
        {!isFolder && !isNote && onDeleteFile && (
          <ContextMenuItem
            onClick={() => setConfirmFileDelete(true)}
            className={cn(TREE_MENU_ITEM_CLASS, 'hover:bg-transparent hover:text-[var(--destructive)]')}
          >
            <TrashSimpleIcon className="mr-2 h-4 w-4" />
            {t('memo.fileTree.delete')}
          </ContextMenuItem>
        )}
        {!isFolder && isNote && displayedMemo && (
          <MemoCardActions
            memo={displayedMemo}
            filePath={item.fullPath}
            hideCopyActions
            copyMenuBeforeReveal={<NotebookCopyContextMenu path={item.fullPath} isNote />}
            onFavoriteToggle={(nextMemo) => { void toggleFavorite(nextMemo.favorited, nextMemo.relativePath); }}
            onDelete={requestDelete}
            onColorsChange={(nextMemo, colors) => { void changeColors(nextMemo, colors); }}
            Item={ContextMenuItem}
          />
        )}
        {!isFolder && isNote && !displayedMemo && (
          <>
            <ContextMenuItem className={TREE_MENU_ITEM_CLASS} onClick={() => { void toggleFavorite(item.memoMeta?.favorited ?? false); }}>
              {t(item.memoMeta?.favorited ? 'memo.action.unpin' : 'memo.action.pin')}
            </ContextMenuItem>
            <ContextMenuItem className={cn(TREE_MENU_ITEM_CLASS, 'hover:bg-transparent hover:text-[var(--destructive)]')} onClick={deleteNoteFromTree}>
              <TrashSimpleIcon className="mr-2 h-4 w-4" />
              {t('memo.action.delete')}
            </ContextMenuItem>
          </>
        )}
        </>}
      </ContextMenuContent>
      </ContextMenu>
      <Dialog open={confirmDelete} onOpenChange={(open) => { if (!open && !deleting) setConfirmDelete(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('memo.fileTree.deleteFolderTitle')}</DialogTitle>
            <DialogDescription>{t('memo.fileTree.deleteFolderDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" disabled={deleting} onClick={() => setConfirmDelete(false)} variant="outline">
              {t('dialog.cancel')}
            </Button>
            <Button type="button" disabled={deleting} onClick={() => void confirmFolderDelete()} variant="destructive">
              {t('memo.fileTree.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmFileDelete} onOpenChange={(open) => {
        if (!open && !deleting) setConfirmFileDelete(false);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('document.external.deleteFileTitle')}</DialogTitle>
            <DialogDescription>{onDeleteSelected ? t('memo.fileTree.deleteSelectedDescription') : t('document.external.deleteFileDescription', { name: item.name })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              disabled={deleting}
              onClick={() => setConfirmFileDelete(false)}
              variant="outline"
            >
              {t('dialog.cancel')}
            </Button>
            <Button
              type="button"
              disabled={deleting}
              onClick={() => void confirmFileDeleteAction()}
              variant="destructive"
            >
              {t('memo.fileTree.delete')}
            </Button>
          </DialogFooter>
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
        openAt(rect.left, rect.bottom, event.currentTarget);
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
