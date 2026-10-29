'use client';

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  CopyIcon,
  EyeSlashIcon,
  FolderOpenIcon,
  MapPinSimpleAreaIcon,
  PencilSimpleIcon,
  PushPin,
  SquareSplitHorizontalIcon,
  TrashSimpleIcon,
} from '@phosphor-icons/react';
import { ChevronRight, Loader2, MoreHorizontal } from 'lucide-react';

import { toast } from '@/lib/toast';
import { cn, displayTitleFromFilename, isCollectionIndexFilename, isMediaLibraryFilename, isTableDocumentFilename } from '@/lib/utils';
import { canonicalDirectoryPath, canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { useI18n } from '@/lib/i18n';
import { MemoCardActions } from '@features/memo/components/memo-card-actions';
import { NotebookCreateContextMenuItems } from '@features/memo/components/notebook-create-context-menu';
import { NotebookCopyContextMenu } from '@features/memo/components/notebook-copy-context-menu';
import { noteRepository } from '@features/memo/services/note-repository';
import { NOTE_COLOR_HEX, noteIndexFor, noteLookupKey, useNoteStore } from '@features/memo/store/note-store';
import type { NoteColor, NoteListItem } from '@/types/note-item';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, useContextMenuContext } from '@shared/ui/context-menu';
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import folderIcon from '@/assets/folder-outline.svg?raw';
import folderIconDefault from '@/assets/folder-outline-default.svg?raw';
import { getPropertyIconOption } from '@features/document/properties/property-icons';
import { useNoteMetadata } from '../hooks/use-note-metadata';
import { noteMetadata } from '../services/note-metadata-service';
import { resourceKindFromPath } from '@features/editor/code-file';
import { ContentIcon, getFileIconKind, HtmlFileIcon } from '@features/content/public/content-api';
import { TreeIconPicker } from './tree-icon-picker';
import { setDocumentProperties } from '@features/document/public/path-properties';
import { files, notes, product, type DocTreeItem } from '@platform/tauri/client';
import { logNativeContextMenuError } from '@platform/tauri/native-context-menu';
import type { TableViewType } from '@features/multidimensional-table/public/create-api';

const TREE_MENU_CLASS =
  'w-[180px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]';

const TREE_MENU_ITEM_CLASS =
  'h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';

const TREE_EDGE_GUTTER = 6;
const INDENT_PER_LEVEL = 20;
/** 单击选中文件夹的延迟：需要小于系统双击间隔，否则双击会先触发选中。 */
export const FOLDER_SINGLE_CLICK_DELAY_MS = 300;
/**
 * 隐藏文件夹 (`.` 开头) 的弱化: 图标压到 50%, 名称文案再乘 80%。
 * 文案本身还有一层 0.82 (选中/激活时为 1) 的行内弱化, 隐藏时再乘一次,
 * 保证 `.trash` / `.claude` 这类目录明显比普通文件夹淡。
 */
const HIDDEN_FOLDER_ICON_OPACITY_CLASS = 'opacity-50';
const HIDDEN_FOLDER_LABEL_OPACITY = 0.8;

const NOTEBOOK_AGENT_PROJECT_FOLDER_NAMES = new Set([
  '.agent',
  '.agents',
  '.codex',
  '.claude',
  '.dsh',
  '.opencode',
  '.hermes',
]);

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
  tableViewVisibility,
  mediaLibraryViewVisibility,
  workDocumentsCollection = false,
  workDocumentsViewVisibility,
  tabIndex = 0,
  moveStatus,
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
  onSelectFolder?: (path: string) => void;
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
  tableViewVisibility?: { collectionId: string; inViews: boolean; identityConflict?: boolean; onChange: (inViews: boolean) => void; onMakeIdentityUnique?: () => void };
  mediaLibraryViewVisibility?: { inViews: boolean; identityConflict?: boolean; onChange: (inViews: boolean) => void; onMakeIdentityUnique?: () => void };
  workDocumentsCollection?: boolean;
  workDocumentsViewVisibility?: { inViews: boolean; disabled?: boolean; onChange: (inViews: boolean) => void };
  tabIndex?: number;
  moveStatus?: 'moving' | 'success';
}) {
  const { t } = useI18n();
  const isFolder = item.type === 'folder';
  const folderClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (folderClickTimer.current !== null) clearTimeout(folderClickTimer.current);
  }, []);
  const selectFolderOnSingleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.detail !== 1) {
      if (folderClickTimer.current !== null) {
        clearTimeout(folderClickTimer.current);
        folderClickTimer.current = null;
      }
      return;
    }
    if (folderClickTimer.current !== null) clearTimeout(folderClickTimer.current);
    folderClickTimer.current = setTimeout(() => {
      folderClickTimer.current = null;
      onSelectFolder?.(item.fullPath);
    }, FOLDER_SINGLE_CLICK_DELAY_MS);
  };
  const toggleFolderOnDoubleClick = () => {
    if (folderClickTimer.current !== null) {
      clearTimeout(folderClickTimer.current);
      folderClickTimer.current = null;
    }
    onToggle(item.fullPath);
  };
  const sourceFolderName = item.fullPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? item.name;
  const isHiddenFolder = isFolder
    && sourceFolderName.startsWith('.')
    && sourceFolderName !== '.'
    && sourceFolderName !== '..';
  const isAgentProjectFolder = isFolder
    && depth === 0
    && NOTEBOOK_AGENT_PROJECT_FOLDER_NAMES.has(sourceFolderName);
  const actionParentPath = isFolder ? item.fullPath : parentPath;
  const hideAgentProjectFolder = async () => {
    const root = canonicalDirectoryPath(notebookPath);
    const fullPath = canonicalDirectoryPath(item.fullPath);
    const rootPrefix = root.endsWith('/') ? root : `${root}/`;
    if (!fullPath.startsWith(rootPrefix)) return;
    const relativePath = fullPath.slice(rootPrefix.length);
    try {
      const preferences = await files.getNotebookViewPreferences(notebookPath);
      const includedPaths = preferences.fileManagement.includedPaths.filter(
        (path) => canonicalPath(path) !== relativePath,
      );
      await files.setNotebookViewPreferences(notebookPath, {
        ...preferences,
        fileManagement: { ...preferences.fileManagement, includedPaths },
      });
    } catch {
      toast.error(t('memo.fileTree.preferenceSaveFailed'));
    }
  };
  const resourceKind = isFolder ? null : item.resourceKind ?? resourceKindFromPath(item.name);
  const isNote = resourceKind === 'note';
  const isHtmlFile = !isFolder && getFileIconKind(item.fullPath) === 'html';
  const isTableDocument = !isFolder && (Boolean(tableViewVisibility)
    || (isTableDocumentFilename(item.name) && !isMediaLibraryFilename(item.name)));
  const isMediaLibrary = !isFolder && (Boolean(mediaLibraryViewVisibility)
    || (isMediaLibraryFilename(item.name) && !isTableDocumentFilename(item.name)));
  const isCollectionIndex = !isFolder && isCollectionIndexFilename(item.name);
  const isExtensionlessDocument = isNote || isTableDocument || isMediaLibrary || isCollectionIndex;
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
  const noteIcon = isNote && displayedIcon
    ? getPropertyIconOption(displayedIcon)
    : null;
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
    const entry = (await notes.list(location.notebookId)).find((candidate) => candidate.relativePath === location.relativePath);
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
            : (event) => onOpen(item.fullPath, event)}
          onDoubleClick={isFolder
            ? toggleFolderOnDoubleClick
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
              if (isFolder) onSelectFolder?.(item.fullPath); else onOpen(item.fullPath);
              return;
            }
            onKeyDown?.(item.fullPath, event);
          }}
          className={cn(
            'folder-file-tree__item group relative flex h-8 cursor-default items-center rounded-lg px-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--brand)]',
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
              <span
                className="absolute inset-0 flex items-center justify-center"
                dangerouslySetInnerHTML={{ __html: isDefaultFolder ? folderIconDefault : folderIcon }}
              />
            ) : isNote ? (
              <ContentIcon content={{ kind: 'note' }} className="notebook-file-tree__default-file-icon h-[18px] w-[18px]" />
            ) : (
              isHtmlFile
                ? <HtmlFileIcon className="h-[18px] w-[18px]" />
                : <ContentIcon content={workDocumentsCollection ? { kind: 'work-documents' } : isMediaLibrary ? { kind: 'media-library' } : isTableDocument ? { kind: 'multidimensional-table' } : { kind: 'file', path: item.name }} className="h-[18px] w-[18px]" />
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
                if (folderClickTimer.current !== null) {
                  clearTimeout(folderClickTimer.current);
                  folderClickTimer.current = null;
                }
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
                  dangerouslySetInnerHTML={{ __html: isDefaultFolder ? folderIconDefault : folderIcon }}
                />
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
                : <ContentIcon content={workDocumentsCollection ? { kind: 'work-documents' } : isMediaLibrary ? { kind: 'media-library' } : isTableDocument ? { kind: 'multidimensional-table' } : { kind: 'file', path: item.name }} className="h-[18px] w-[18px]" />}
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
          {isFolder && isPinnedFolder && !renaming && (
            <PushPin weight="fill" className="ml-1 h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
          )}
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
            {t('memo.action.openInSplit')}
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
        {isFolder && onSetDefaultFolder && (
          <ContextMenuItem onClick={() => onSetDefaultFolder(item.fullPath)} className={TREE_MENU_ITEM_CLASS}>
            <MapPinSimpleAreaIcon className="mr-2 h-4 w-4" aria-hidden="true" />
            {t(isDefaultFolder ? 'memo.fileTree.clearDefaultCreateFolder' : 'memo.fileTree.setDefaultCreateFolder')}
          </ContextMenuItem>
        )}
        {isFolder && onTogglePinnedFolder && (
          <ContextMenuItem onClick={() => onTogglePinnedFolder(item.fullPath)} className={TREE_MENU_ITEM_CLASS}>
            <PushPin weight={isPinnedFolder ? 'fill' : 'regular'} className="mr-2 h-4 w-4" aria-hidden="true" />
            {t(isPinnedFolder ? 'memo.fileTree.unpinFolder' : 'memo.fileTree.pinFolder')}
          </ContextMenuItem>
        )}
        {isTableDocument && tableViewVisibility && (
          tableViewVisibility.identityConflict ? (
            <ContextMenuItem onClick={tableViewVisibility.onMakeIdentityUnique} disabled={!tableViewVisibility.onMakeIdentityUnique} className={TREE_MENU_ITEM_CLASS}>
              {t('multidimensionalTable.resolveIdentityConflict')}
            </ContextMenuItem>
          ) : <ContextMenuItem
            onClick={() => tableViewVisibility.onChange(!tableViewVisibility.inViews)}
            className={TREE_MENU_ITEM_CLASS}
          >
            <EyeSlashIcon className="mr-2 h-4 w-4" aria-hidden="true" />
            {t(tableViewVisibility.inViews ? 'multidimensionalTable.viewMembership.hide' : 'multidimensionalTable.viewMembership.add')}
          </ContextMenuItem>
        )}
        {workDocumentsCollection && workDocumentsViewVisibility && (
          <ContextMenuItem
            onClick={() => workDocumentsViewVisibility.onChange(!workDocumentsViewVisibility.inViews)}
            disabled={workDocumentsViewVisibility.disabled}
            className={TREE_MENU_ITEM_CLASS}
          >
            <EyeSlashIcon className="mr-2 h-4 w-4" aria-hidden="true" />
            {t(workDocumentsViewVisibility.inViews ? 'multidimensionalTable.viewMembership.hide' : 'multidimensionalTable.viewMembership.add')}
          </ContextMenuItem>
        )}
        {isMediaLibrary && mediaLibraryViewVisibility && (
          mediaLibraryViewVisibility.identityConflict ? (
            <ContextMenuItem onClick={mediaLibraryViewVisibility.onMakeIdentityUnique} disabled={!mediaLibraryViewVisibility.onMakeIdentityUnique} className={TREE_MENU_ITEM_CLASS}>
              {t('mediaLibrary.resolveIdentityConflict')}
            </ContextMenuItem>
          ) : <ContextMenuItem
            onClick={() => mediaLibraryViewVisibility.onChange(!mediaLibraryViewVisibility.inViews)}
            className={TREE_MENU_ITEM_CLASS}
          >
            <EyeSlashIcon className="mr-2 h-4 w-4" aria-hidden="true" />
            {t(mediaLibraryViewVisibility.inViews ? 'mediaLibrary.viewMembership.hide' : 'mediaLibrary.viewMembership.show')}
          </ContextMenuItem>
        )}
        {isFolder && (onDeleteFolder || isAgentProjectFolder) && (
          <>
            <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
            {isAgentProjectFolder ? (
              <ContextMenuItem
                onClick={() => void hideAgentProjectFolder()}
                className={TREE_MENU_ITEM_CLASS}
              >
                <EyeSlashIcon className="mr-2 h-4 w-4" />
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
        <DialogContent className="rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <DialogHeader>
            <DialogTitle>{t('memo.fileTree.deleteFolderTitle')}</DialogTitle>
            <DialogDescription>{t('memo.fileTree.deleteFolderDescription')}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" disabled={deleting} onClick={() => setConfirmDelete(false)} className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]">
              {t('dialog.cancel')}
            </button>
            <button type="button" disabled={deleting} onClick={() => void confirmFolderDelete()} className="h-8 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)] px-3 text-sm text-white hover:opacity-90 disabled:opacity-50">
              {t('memo.fileTree.delete')}
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmFileDelete} onOpenChange={(open) => {
        if (!open && !deleting) setConfirmFileDelete(false);
      }}>
        <DialogContent className="rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <DialogHeader>
            <DialogTitle>{t('document.external.deleteFileTitle')}</DialogTitle>
            <DialogDescription>{onDeleteSelected ? t('memo.fileTree.deleteSelectedDescription') : t('document.external.deleteFileDescription', { name: item.name })}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              disabled={deleting}
              onClick={() => setConfirmFileDelete(false)}
              className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]"
            >
              {t('dialog.cancel')}
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={() => void confirmFileDeleteAction()}
              className="h-8 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)] px-3 text-sm text-white hover:opacity-90 disabled:opacity-50"
            >
              {t('memo.fileTree.delete')}
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
