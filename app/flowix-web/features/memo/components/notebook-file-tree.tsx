'use client';

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
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  ChevronRight,
  ListPlus,
  MoreHorizontal,
  GripVertical,
  Plus,
  Table2,
  GalleryHorizontalEnd,
  Loader2,
} from 'lucide-react';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  FileIcon,
  FolderOpenIcon,
  FolderSimplePlusIcon,
  LinkIcon,
  MinusCircleIcon,
  PencilSimpleIcon,
  RulerIcon,
  SquaresFourIcon,
  SquareSplitHorizontalIcon,
  TrashSimpleIcon,
} from '@phosphor-icons/react';

import {
  canonicalDirectoryPath,
  canonicalPath,
  joinNotebookMemoPath,
  parentDirectoryPath,
  pathInDirectory,
  samePath,
  uniquePaths,
} from '@/lib/path';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { cn, displayTitleFromFilename, isMediaLibraryFilename, isTableDocumentFilename, mediaLibraryExtension, tableDocumentExtension } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useComposingValue } from '@shared/hooks/use-composing-value';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { ListSurfaceLoadingState, ListSurfaceSpinner, ListSurfaceViewport } from '@shared/ui/list-surface';
import { Button } from '@shared/ui/button';
import { Popover, PopoverContent } from '@shared/ui/popover';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { NotebookTreeFileIcon } from '@features/memo/components/notebook-tree-file-icon';
import { useNoteStore } from '@features/memo/store/note-store';
import { useCustomFilterStore } from '@features/memo/store/custom-filter-store';
import { noteRepository } from '@features/memo/services/note-repository';
import { createMediaLibraryFile } from '@features/media-library/model';
import { updateNoteLinksAfterMove } from '@features/memo/services/note-link-rewriter';
import { openExternalTarget, replaceExternalDocumentPath } from '@features/workspace/use-cases/workspace-navigation';
import { ensureFileDisplayIdentity } from '@/lib/file-display-registry';
import {
  elementFromExternalDropPosition,
  EXTERNAL_FILE_DROP_EVENT,
  type ExternalDropPosition,
  type ExternalFileDropDetail,
} from '@features/document/components/use-markdown-file-drop';
import { localDocumentOperations, renameMarkdownTitle } from '@features/document/public/file-operations-api';
import folderIcon from '@/assets/folder-outline.svg?raw';
import { resolveNotebookAgentFiles } from '@/lib/agent-access-defaults';
import {
  flattenLoadedTree,
  flattenVisibleTree,
  useFolderTree,
  type FolderTreeController,
} from '@features/memo/components/use-folder-tree';
import { NotebookTreeRow } from '@features/memo/components/notebook-tree-row';
import { ResourceFileIcon, ResourceFolderIcon } from '@features/surface/resource-file-icon';
import { getWorkspaceAgentRepositories, type WorkspaceAgentRepository } from '@features/agent/public/workspace-api';
import { useAgentAccessStore } from '@features/agent/store/agent-access-store';
import { normalizeWorkspacePath } from '@features/agent/runtime/workspace-path';
import {
  files,
  product,
  system,
  windows,
  type DocTreeItem,
  type DocTreeResourceKind,
  type FileBrowserDirectoriesChangedEvent,
  type MediaLibraryListItem,
  type TableDocumentListItem,
} from '@platform/tauri/client';
import { resourceKindFromPath } from '@features/editor/code-file';
import { useDynamicVirtualList } from '@features/memo/components/memo-list/use-dynamic-virtual-list';
import { createTableDocumentFile } from '@features/multidimensional-table/public/create-api';
import { subscribe } from '@platform/tauri/event-bus';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@shared/ui/context-menu';

const TREE_EDGE_GUTTER = 6;

function getPopupOriginRect(target: HTMLElement): DOMRect {
  const rect = (target.closest('[role="menu"]') ?? target).getBoundingClientRect();
  return new DOMRect(rect.left, rect.top, 0, 0);
}
const INDENT_PER_LEVEL = 20;
const TREE_ROW_HEIGHT = 32;
const TREE_ROW_GAP = 2;
const TREE_ROW_SIZE = TREE_ROW_HEIGHT + TREE_ROW_GAP;
const TREE_HEADER_HEIGHT = 30;
const TREE_VIRTUAL_OVERSCAN = 10;
const TREE_DRAG_SCROLL_EDGE = 40;
const TREE_DRAG_SCROLL_MAX_STEP = 18;
const TREE_DRAG_EXPAND_DELAY_MS = 650;
const logger = createLogger('notebook-file-tree');
// Row gutter (6px) + inline padding (6px) + half of the 12px caret.
const FOLDER_CARET_CENTER_OFFSET = 12;
type NotebookTreeSection = 'agents' | 'pinned' | 'views' | 'files' | 'repositories';

const DEFAULT_TREE_SECTION_ORDER: NotebookTreeSection[] = ['agents', 'pinned', 'views', 'files', 'repositories'];
const PREVIOUS_DEFAULT_TREE_SECTION_ORDER: NotebookTreeSection[] = ['agents', 'pinned', 'files', 'views'];
const LEGACY_TREE_SECTION_ORDER: NotebookTreeSection[] = ['agents', 'pinned', 'views', 'files'];

function normalizeTreeSectionOrder(value: unknown): NotebookTreeSection[] {
  if (!Array.isArray(value)) return DEFAULT_TREE_SECTION_ORDER;
  const order = value.filter((item, index, items): item is NotebookTreeSection => (
    DEFAULT_TREE_SECTION_ORDER.includes(item as NotebookTreeSection)
    && items.indexOf(item) === index
  ));
  if (order.length === 5) return order;
  if (order.length === 4) {
    if (order.every((item, index) => item === PREVIOUS_DEFAULT_TREE_SECTION_ORDER[index])) {
      return DEFAULT_TREE_SECTION_ORDER;
    }
    if (order.every((item, index) => item === LEGACY_TREE_SECTION_ORDER[index])) {
      return DEFAULT_TREE_SECTION_ORDER;
    }
    return [...order, 'repositories'];
  }
  const legacyOrder = order.filter((item): item is 'files' | 'views' => item === 'files' || item === 'views');
  if (legacyOrder.length === 2) return ['agents', 'pinned', ...legacyOrder, 'repositories'];
  return [...DEFAULT_TREE_SECTION_ORDER.filter((item) => !order.includes(item)), ...order];
}

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

function TreeSectionMoreMenu({
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onCreateFolder,
  onCreateNote,
  onCustomizeDisplay,
}: {
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onCreateFolder?: () => void;
  onCreateNote?: () => void;
  onCustomizeDisplay?: (anchorRect: DOMRect) => void;
}) {
  const { t } = useI18n();
  const itemClassName = 'group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)] disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="notebook-file-tree__section-more-trigger flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] opacity-0 transition-[color,opacity] hover:text-[var(--foreground)] focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
          aria-label={t('memo.fileTree.moreSectionActions')}
          title={t('memo.fileTree.moreSectionActions')}
        >
          <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[176px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <DropdownMenuItem disabled={!canMoveUp} onClick={onMoveUp} className={itemClassName}>
          <ArrowUpIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {t('memo.fileTree.moveSectionUp')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canMoveDown} onClick={onMoveDown} className={itemClassName}>
          <ArrowDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {t('memo.fileTree.moveSectionDown')}
        </DropdownMenuItem>
        {onCreateNote && (
          <DropdownMenuItem onClick={onCreateNote} className={itemClassName}>
            <FileIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {t('memo.fileTree.newNote')}
          </DropdownMenuItem>
        )}
        {onCreateFolder && (
          <DropdownMenuItem onClick={onCreateFolder} className={itemClassName}>
            <FolderSimplePlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {t('memo.fileTree.newFolder')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => { void windows.openPreferences('noteSettings'); }} className={itemClassName}>
          <RulerIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {t('memo.fileTree.noteSettings')}
        </DropdownMenuItem>
        {onCustomizeDisplay && (
          <DropdownMenuItem onClick={(event) => {
            const rect = getPopupOriginRect(event.currentTarget);
            onCustomizeDisplay(rect);
          }} className={itemClassName}>
            <SquaresFourIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {t('memo.fileTree.customizeDisplay')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AgentRepositoryItem({
  repository,
  onOpenFile,
  onRemoveRepository,
  onExpandRepository,
  onOpenInNewTab,
  onCustomizeDisplay,
}: {
  repository: WorkspaceAgentRepository;
  onOpenFile: (path: string, scopePath: string) => void;
  onRemoveRepository: (repository: WorkspaceAgentRepository) => void;
  onExpandRepository: (element: HTMLElement) => void;
  onOpenInNewTab?: (path: string) => void;
  onCustomizeDisplay?: (anchorRect: DOMRect) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const repositoryRef = useRef<HTMLDivElement | null>(null);
  const pendingExpandScrollRef = useRef(false);
  const [renaming, setRenaming] = useState<{ item: DocTreeItem; value: string } | null>(null);
  const [deleting, setDeleting] = useState<DocTreeItem | null>(null);
  const tree = useFolderTree(repository.path, { enabled: expanded });
  useLayoutEffect(() => {
    if (!expanded || tree.loading || !pendingExpandScrollRef.current) return;
    pendingExpandScrollRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      if (repositoryRef.current) onExpandRepository(repositoryRef.current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expanded, onExpandRepository, tree.loading, tree.rootChildren.length]);
  const activeFilePath = useWorkColumnStore((state) => {
    const target = state.navigation.target;
    if (target.kind === 'external') return target.path;
    if (target.kind === 'media') return target.filePath;
    return null;
  });
  const renameItem = async (item: DocTreeItem, value: string) => {
    const name = value.trim();
    setRenaming(null);
    const isTableDocument = item.type === 'document' && isTableDocumentFilename(item.name);
    const isMediaLibrary = item.type === 'document' && isMediaLibraryFilename(item.name);
    const currentName = isTableDocument || isMediaLibrary ? displayTitleFromFilename(item.name) : item.name;
    if (!name || name === currentName) return;
    try {
      if (item.type === 'folder') await files.renameFolder(item.fullPath, name, repository.path);
      else {
        const extension = isTableDocument ? tableDocumentExtension(item.name) : isMediaLibrary ? mediaLibraryExtension(item.name) : '';
        await localDocumentOperations.rename({ path: item.fullPath, name: `${name}${extension}`, scopePath: repository.path });
      }
      await tree.refresh(parentDirectoryPath(item.fullPath, repository.path));
      toast.success(t('memo.fileTree.renamed', { name }));
    } catch (error) {
      toast.error(t(String(error).includes('FILE_EXISTS') ? 'memo.fileTree.nameConflict' : 'memo.fileTree.renameFailed'));
    }
  };
  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      const ok = deleting.type === 'folder'
        ? await files.deleteFolder(deleting.fullPath, repository.path)
        : await files.delete(deleting.fullPath, repository.path);
      if (!ok) throw new Error('delete failed');
      await tree.refresh(parentDirectoryPath(deleting.fullPath, repository.path));
      toast.success(t('memo.fileTree.deleted', { name: deleting.name }));
      setDeleting(null);
    } catch {
      toast.error(t('memo.fileTree.deleteFailed'));
    }
  };
  const renderRepositoryItems = (items: DocTreeItem[], depth: number): ReactNode[] => items.map((item) => {
    const isFolder = item.type === 'folder';
    const isActive = !isFolder && activeFilePath != null && samePath(item.fullPath, activeFilePath);
    const key = canonicalPath(item.fullPath);
    const itemExpanded = isFolder && tree.expanded.has(key);
    const folderName = item.fullPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? item.name;
    const isHiddenFolder = isFolder && folderName.startsWith('.');
    const children = isFolder ? tree.nodes.get(key)?.children ?? [] : [];
    return (
      <ContextMenu key={item.id}>
      <ContextMenuTrigger asChild>
      <div className="folder-file-tree__group relative">
        <button
          type="button"
          aria-expanded={isFolder ? itemExpanded : undefined}
          aria-current={isActive ? 'page' : undefined}
          title={item.fullPath}
          onClick={() => renaming?.item.id === item.id ? undefined : isFolder
            ? tree.toggle(item.fullPath)
            : onOpenFile(item.fullPath, repository.path)}
          className={cn(
            'folder-file-tree__item group relative flex h-7 items-center rounded-lg px-1.5 text-left text-[13px] font-normal leading-[1.6] text-[var(--foreground)] transition-colors duration-150 cursor-pointer hover:bg-[var(--muted)]',
            isActive && 'bg-[var(--muted)] text-[var(--foreground)]',
          )}
          style={{
            marginLeft: TREE_EDGE_GUTTER + depth * INDENT_PER_LEVEL,
            width: `calc(100% - ${TREE_EDGE_GUTTER * 2 + depth * INDENT_PER_LEVEL}px)`,
          }}
        >
          {isFolder ? (
            <span className="relative h-[18px] w-[18px] shrink-0">
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  'absolute left-1/2 top-1/2 h-[15px] w-[15px] -translate-x-1/2 -translate-y-1/2 text-[color-mix(in_oklch,var(--foreground)_70%,black_30%)] [[data-theme="dark"]_&]:text-[var(--foreground)] opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 group-focus-visible:opacity-100',
                  itemExpanded && 'rotate-90',
                )}
              />
              <ResourceFolderIcon
                expanded={itemExpanded}
                hidden={isHiddenFolder}
                className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0"
              />
            </span>
          ) : (
            <ResourceFileIcon path={item.fullPath} size={18} className="h-[18px] w-[18px] shrink-0" />
          )}
          {renaming?.item.id === item.id ? (
            <input
              autoFocus
              value={renaming.value}
              onChange={(event) => setRenaming({ item, value: event.target.value })}
              onBlur={() => void renameItem(item, renaming.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void renameItem(item, renaming.value);
                if (event.key === 'Escape') setRenaming(null);
              }}
              onClick={(event) => event.stopPropagation()}
              className="ml-1.5 h-5 min-w-0 flex-1 border-0 bg-transparent px-0 text-[13px] outline-none"
            />
          ) : (
            <span className={cn(
              'ml-1.5 min-w-0 flex-1 truncate',
              isActive ? 'opacity-100' : 'opacity-[0.82]',
            )}>
              {item.type === 'document' && (isTableDocumentFilename(item.name) || isMediaLibraryFilename(item.name))
                ? displayTitleFromFilename(item.name)
                : item.name}
            </span>
          )}
          {tree.loadingDirectories.has(key) && (
            <ListSurfaceSpinner className="mr-1 h-3.5 w-3.5" ariaLabel={t('memo.fileTree.loading')} />
          )}
        </button>
        {isFolder && (children.length > 0 || tree.directoryErrors.has(key) || tree.loadingDirectories.has(key)) && (
          <div
            className="folder-file-tree__subtree"
            data-expanded={itemExpanded}
            style={{
              '--folder-file-tree-guide-left': `${TREE_EDGE_GUTTER + depth * INDENT_PER_LEVEL + 6 + 8}px`,
            } as CSSProperties}
          >
            <div className="folder-file-tree__subtree-inner">
              <div className="folder-file-tree__subtree-items">
                {tree.directoryErrors.has(key) && (
                  <div className="flex min-h-7 items-center gap-2 px-2 text-xs text-[var(--muted-foreground)]" style={{ marginLeft: depth * INDENT_PER_LEVEL }} role="alert">
                    <span className="min-w-0 flex-1 truncate">{t('memo.fileTree.unreadableHint')}</span>
                    <button type="button" className="shrink-0 rounded-lg px-1.5 py-0.5 text-[var(--foreground)] hover:bg-[var(--muted)]" onClick={() => void tree.retryDirectory(item.fullPath)}>
                      {t('error.retry')}
                    </button>
                  </div>
                )}
                {itemExpanded ? renderRepositoryItems(children, depth + 1) : null}
              </div>
            </div>
          </div>
        )}
      </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-[180px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <ContextMenuItem onClick={() => setRenaming({ item, value: item.type === 'document' && (isTableDocumentFilename(item.name) || isMediaLibraryFilename(item.name)) ? displayTitleFromFilename(item.name) : item.name })} className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"><PencilSimpleIcon className="mr-2 h-4 w-4" aria-hidden="true" />{t('memo.fileTree.rename')}</ContextMenuItem>
        {!isFolder && onOpenInNewTab && <ContextMenuItem onClick={() => onOpenInNewTab(item.fullPath)} className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"><SquareSplitHorizontalIcon className="mr-2 h-4 w-4" aria-hidden="true" />{t('memo.fileTree.openInRight')}</ContextMenuItem>}
        <ContextMenuItem onClick={async () => { try { await navigator.clipboard.writeText(item.fullPath); toast.success(t('memo.fileTree.pathCopied')); } catch { toast.error(t('memo.fileTree.copyFailed')); } }} className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"><LinkIcon className="mr-2 h-4 w-4" aria-hidden="true" />{t('memo.fileTree.copyLink')}</ContextMenuItem>
        <ContextMenuItem onClick={() => { void product.revealInFileManager(item.fullPath).catch(() => toast.error(t('memo.fileTree.openFailed'))); }} className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"><FolderOpenIcon className="mr-2 h-4 w-4" aria-hidden="true" />{t('memo.fileTree.reveal')}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={(event) => onCustomizeDisplay?.(getPopupOriginRect(event.currentTarget))} className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"><SquaresFourIcon className="mr-2 h-4 w-4" aria-hidden="true" />{t('memo.fileTree.customizeDisplay')}</ContextMenuItem>
        <ContextMenuItem onClick={() => setDeleting(item)} className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left hover:bg-transparent hover:text-[var(--destructive)]"><TrashSimpleIcon className="mr-2 h-4 w-4" aria-hidden="true" />{t('memo.fileTree.delete')}</ContextMenuItem>
      </ContextMenuContent>
      </ContextMenu>
    );
  });

  return (
    <>
      <div className={cn(
        'mx-[6px] overflow-hidden rounded-xl transition-colors',
        expanded && 'mb-1 border border-[var(--border)] bg-[var(--card)] p-0.5 py-1',
      )} ref={repositoryRef}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
              type="button"
              aria-expanded={expanded}
              title={repository.path}
              onClick={() => {
                pendingExpandScrollRef.current = !expanded;
                setExpanded(!expanded);
              }}
              className="group flex h-7 w-full items-center rounded-lg px-1.5 text-left text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]"
            >
              <span className="relative h-[18px] w-[18px] shrink-0">
                <ChevronRight className={cn(
                  'absolute left-1/2 top-1/2 h-[15px] w-[15px] -translate-x-1/2 -translate-y-1/2 text-[color-mix(in_oklch,var(--foreground)_70%,black_30%)] [[data-theme="dark"]_&]:text-[var(--foreground)] opacity-100 transition-[opacity,transform]',
                  expanded && 'rotate-90',
                )} aria-hidden="true" />
              </span>
              <span className="ml-1.5 min-w-0 flex-1 truncate opacity-[0.82]">
                {repository.name}
              </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-[180px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <ContextMenuItem
            onClick={() => onRemoveRepository(repository)}
            className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left hover:bg-transparent hover:text-[var(--destructive)]"
          >
            <MinusCircleIcon className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('agent.workspace.removeRepository')}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={(event) => onCustomizeDisplay?.(getPopupOriginRect(event.currentTarget))}
            className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
          >
            <SquaresFourIcon className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('memo.fileTree.customizeDisplay')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {expanded && (
        <div className="folder-file-tree__items">
          {tree.loading && tree.nodes.size === 0 && (
            <div className="flex min-h-7 items-center px-2 text-xs text-[var(--muted-foreground)]" style={{ marginLeft: TREE_EDGE_GUTTER + 20 }}>
              {t('memo.fileTree.loading')}
            </div>
          )}
          {tree.error && (
            <button
              type="button"
              onClick={() => void tree.reload()}
              className="flex min-h-7 items-center rounded-lg px-2 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              style={{ marginLeft: TREE_EDGE_GUTTER + 20 }}
            >
              {t('error.retry')}
            </button>
          )}
          {!tree.loading && !tree.error && tree.rootChildren.length === 0 && (
            <div className="flex min-h-7 items-center px-2 text-xs text-[var(--muted-foreground)]" style={{ marginLeft: TREE_EDGE_GUTTER + 20 }}>
              {t('memo.fileTree.empty')}
            </div>
          )}
          {renderRepositoryItems(tree.rootChildren, 0)}
        </div>
      )}
      </div>
      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <DialogContent className="rounded-xl border border-[var(--border-popup)] bg-[var(--card)]">
          <DialogHeader>
            <DialogTitle>{deleting?.type === 'folder' ? t('memo.fileTree.deleteFolderTitle') : t('document.external.deleteFileTitle')}</DialogTitle>
            <DialogDescription>{deleting?.type === 'folder' ? t('memo.fileTree.deleteFolderDescription') : t('document.external.deleteFileDescription', { name: deleting?.name ?? '' })}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setDeleting(null)} className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]">{t('dialog.cancel')}</button>
            <button type="button" onClick={() => void confirmDelete()} className="h-8 rounded-lg border border-[var(--border)] px-3 text-sm hover:border-[var(--destructive)] hover:bg-[var(--destructive)] hover:text-white">{t('dialog.delete')}</button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AgentRepositoriesSection({
  repositories,
  order,
  onHeightChange,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onAddRepository,
  onRemoveRepository,
  onExpandRepository,
  canAddRepository,
  onOpenFile,
  onOpenInNewTab,
  onCustomizeDisplay,
}: {
  repositories: WorkspaceAgentRepository[];
  order: number;
  onHeightChange: (height: number) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onAddRepository: () => void;
  onRemoveRepository: (repository: WorkspaceAgentRepository) => void;
  onExpandRepository: (element: HTMLElement) => void;
  canAddRepository: boolean;
  onOpenFile: (path: string, scopePath: string) => void;
  onOpenInNewTab?: (path: string) => void;
  onCustomizeDisplay?: (anchorRect: DOMRect) => void;
}) {
  const { t } = useI18n();
  const sectionRef = useRef<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const reportHeight = () => onHeightChange(section.getBoundingClientRect().height);
    reportHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reportHeight);
    observer.observe(section);
    return () => observer.disconnect();
  }, [collapsed, onHeightChange, repositories]);

  return (
    <section
      ref={sectionRef}
      className="pb-3"
      aria-label={t('memo.fileTree.repositoriesTitle')}
      data-notebook-repositories-section="true"
      style={{ order }}
    >
      <div
        className="notebook-file-tree__section-header group mb-0.5 flex h-7 items-center rounded-lg px-1.5 transition-colors hover:bg-[var(--muted)]"
        style={{ marginLeft: TREE_EDGE_GUTTER, width: `calc(100% - ${TREE_EDGE_GUTTER * 2}px)` }}
      >
        <button
          type="button"
          className="flex h-full items-center gap-0.5 text-[0.82rem] font-medium text-[var(--muted-foreground)] opacity-90 hover:text-[var(--foreground)] focus-visible:outline-none"
          aria-label={t(collapsed ? 'memo.fileTree.expandRepositories' : 'memo.fileTree.collapseRepositories')}
          title={t(collapsed ? 'memo.fileTree.expandRepositories' : 'memo.fileTree.collapseRepositories')}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span>{t('memo.fileTree.repositoriesTitle')}</span>
          <ChevronRight className={cn(
            'h-3.5 w-3.5 opacity-0 transition-[opacity,transform] group-hover:opacity-100 group-focus-within:opacity-100',
            collapsed && 'opacity-100',
            !collapsed && 'rotate-90',
          )} aria-hidden="true" />
        </button>
        <div className="ml-auto flex items-center">
          <TreeSectionMoreMenu
            canMoveUp={canMoveUp}
            canMoveDown={canMoveDown}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            onCustomizeDisplay={onCustomizeDisplay}
          />
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={t('agent.workspace.addRepository')}
            title={t('agent.workspace.addRepository')}
            disabled={!canAddRepository}
            onClick={onAddRepository}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      {!collapsed && (
        <>
          {repositories.length > 0 ? repositories.map((repository) => (
            <AgentRepositoryItem
              key={repository.path}
              repository={repository}
              onOpenFile={onOpenFile}
              onRemoveRepository={onRemoveRepository}
              onExpandRepository={onExpandRepository}
              onOpenInNewTab={onOpenInNewTab}
              onCustomizeDisplay={onCustomizeDisplay}
            />
          )) : (
            <div
              className="flex h-7 items-center justify-center px-1.5 text-xs text-[var(--muted-foreground)] opacity-50"
              style={{ marginLeft: TREE_EDGE_GUTTER, width: `calc(100% - ${TREE_EDGE_GUTTER * 2}px)` }}
            >
              {t('memo.fileTree.repositoriesEmpty')}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function relativeFolderPath(notebookPath: string, folderPath: string): string {
  const root = canonicalDirectoryPath(notebookPath);
  const folder = canonicalPath(folderPath);
  if (folder === root) return '';
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
  resourceKind?: DocTreeResourceKind | null;
  isFolder?: boolean;
}

interface NotebookFileTreeProps {
  notebookId?: string;
  notebookPath: string;
  notebookName: string;
  activeFilePath?: string | null;
  tree: FolderTreeController;
  isActive?: boolean;
  createFolderRequest?: NotebookFolderCreateRequest | null;
  createNoteRequest?: NotebookNoteCreateRequest | null;
  onCreateFolder?: () => void;
  onNoteSelect: (filePath: string) => void;
  onFolderSelect?: (folderPath: string) => void;
  onNoteOpenInNewTab?: (filePath: string) => void;
  onCreateNote: (parentPath: string, title: string) => Promise<void> | void;
  onMoveNote: (
    sources: NotebookMoveSource[],
    targetDirectoryPath: string,
  ) => Promise<NotebookMoveResult>;
  onDeleteFolder?: (folderPath: string) => Promise<void>;
  onDeleteFile?: (item: DocTreeItem) => Promise<void>;
  defaultCreateFolder?: string | null;
  onSetDefaultCreateFolder?: (folderPath: string) => void;
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
  notebookId: notebookIdProp,
  notebookPath,
  notebookName,
  activeFilePath = null,
  tree,
  isActive = true,
  createFolderRequest,
  createNoteRequest,
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
  const selectedFolderPath = useWorkColumnStore((state) => state.navigation.target.kind === 'document-list' ? state.navigation.target.scope.path : null);
  const refreshTrigger = useNoteStore((state) => state.refreshTrigger);
  const notebookIdFromStore = useNoteStore((state) => (
    state.notebooks.find((notebook) => samePath(notebook.path, notebookPath))?.id ?? null
  ));
  const notebookId = notebookIdProp ?? notebookIdFromStore;
  const loadNotebookFilters = useCustomFilterStore((state) => state.loadNotebookFilters);
  const agentAccessConfig = useAgentAccessStore((state) => state.config);
  const agentNotebookConfigs = useAgentAccessStore((state) => state.notebookConfigs);
  const agentRepositories = useMemo(
    () => getWorkspaceAgentRepositories(notebookId),
    [agentAccessConfig, agentNotebookConfigs, notebookId],
  );
  const [showScrollTopHint, setShowScrollTopHint] = useState(false);
  const [pinnedItems, setPinnedItems] = useState<DocTreeItem[]>([]);
  const [tableDocuments, setTableDocuments] = useState<TableDocumentListItem[]>([]);
  const [mediaLibraries, setMediaLibraries] = useState<MediaLibraryListItem[]>([]);
  const [newTableDialogOpen, setNewTableDialogOpen] = useState(false);
  const [newTableName, setNewTableName] = useState('');
  const [newTableInViews, setNewTableInViews] = useState(false);
  const [newTableParentFolder, setNewTableParentFolder] = useState<string | null>(null);
  const [isCreatingTable, setIsCreatingTable] = useState(false);
  const [newLibraryDialogOpen, setNewLibraryDialogOpen] = useState(false);
  const [newLibraryName, setNewLibraryName] = useState('');
  const [newLibraryInViews, setNewLibraryInViews] = useState(false);
  const [newLibraryParentFolder, setNewLibraryParentFolder] = useState<string | null>(null);
  const [isCreatingLibrary, setIsCreatingLibrary] = useState(false);
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
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [viewsCollapsed, setViewsCollapsed] = useState(false);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [repositorySectionHeight, setRepositorySectionHeight] = useState(0);
  const [sectionOrder, setSectionOrder] = useState<NotebookTreeSection[]>(DEFAULT_TREE_SECTION_ORDER);
  const [hiddenSections, setHiddenSections] = useState<NotebookTreeSection[]>([]);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [customizeAnchorRect, setCustomizeAnchorRect] = useState<DOMRect | null>(null);
  const [customizeOrder, setCustomizeOrder] = useState<NotebookTreeSection[]>(DEFAULT_TREE_SECTION_ORDER);
  const [customizeHidden, setCustomizeHidden] = useState<NotebookTreeSection[]>([]);
  const openCustomizeDisplay = useCallback((anchorRect: DOMRect) => {
    setCustomizeAnchorRect(anchorRect);
    setCustomizeOrder([...sectionOrder]);
    setCustomizeHidden([...hiddenSections]);
    setCustomizeOpen(true);
  }, [hiddenSections, sectionOrder]);
  const draggedSection = useRef<NotebookTreeSection | null>(null);
  const sectionDragPointerId = useRef<number | null>(null);
  const sectionDropTargetRef = useRef<{ section: NotebookTreeSection; after: boolean } | null>(null);
  const [sectionDropTarget, setSectionDropTarget] = useState<{ section: NotebookTreeSection; after: boolean } | null>(null);
  const [agentSectionHeight, setAgentSectionHeight] = useState(0);
  const [draft, setDraft] = useState<NotebookTreeDraftState | null>(null);
  const [selectedFilePaths, setSelectedFilePaths] = useState<string[]>([]);
  const [focusedTreePath, setFocusedTreePath] = useState<string | null>(null);
  const selectedFilePathsRef = useRef<string[]>([]);
  const selectionAnchorPathRef = useRef<string | null>(null);
  const previousActiveFilePathRef = useRef(
    activeFilePath ? canonicalPath(activeFilePath) : null,
  );
  const pointerDragRef = useRef<PointerNoteDrag | null>(null);
  const dropPendingRef = useRef(false);
  const externalDropTargetPathRef = useRef<string | null>(null);
  const treeScrollerRef = useRef<HTMLDivElement | null>(null);
  const pendingActiveFileScrollPathRef = useRef<string | null>(
    activeFilePath ? canonicalPath(activeFilePath) : null,
  );
  const externalDropSurfaceRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isActive) return;
    if (notebookId) void loadNotebookFilters(notebookId);
  }, [isActive, loadNotebookFilters, notebookId]);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    setSectionOrder(DEFAULT_TREE_SECTION_ORDER);
    setHiddenSections([]);
    if (!notebookId) return () => { cancelled = true; };
    void system.getNotebookFileTreePreferences(notebookId).then((preferences) => {
      if (cancelled) return;
      setSectionOrder(normalizeTreeSectionOrder(preferences.sectionOrder));
      setHiddenSections((preferences.hiddenSections ?? []).filter((item): item is NotebookTreeSection => DEFAULT_TREE_SECTION_ORDER.includes(item as NotebookTreeSection)));
    }).catch((error) => {
      logger.warn('failed to load notebook file tree preferences', { error, notebookId });
    });
    return () => { cancelled = true; };
  }, [isActive, notebookId]);

  const visibleSectionOrder = useMemo(() => sectionOrder.filter((section) => (
    !hiddenSections.includes(section) && (section === 'files'
    || section === 'repositories'
    || (section === 'agents' && Boolean(notebookId) && agentSectionHeight > 0)
    || (section === 'pinned' && pinnedItems.length > 0)
    || section === 'views')
  )), [agentSectionHeight, hiddenSections, notebookId, pinnedItems.length, sectionOrder]);

  const moveTreeSection = useCallback((section: NotebookTreeSection, direction: -1 | 1) => {
    if (!notebookId) return;
    const visibleIndex = visibleSectionOrder.indexOf(section);
    const targetSection = visibleSectionOrder[visibleIndex + direction];
    if (visibleIndex < 0 || !targetSection) return;
    const index = sectionOrder.indexOf(section);
    const targetIndex = sectionOrder.indexOf(targetSection);
    const next = [...sectionOrder];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    setSectionOrder(next);
    void system.setNotebookFileTreeSectionOrder(notebookId, next).catch((error) => {
      logger.warn('failed to save notebook file tree section order', { error, notebookId });
    });
  }, [notebookId, sectionOrder, visibleSectionOrder]);
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

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    setPinnedItems([]);
    if (!notebookId) return () => { cancelled = true; };
    void noteRepository.listByPath({
      notebookId,
      filter: 'favorited',
      sort: 'updatedAt',
      limit: 100,
    }).then((page) => {
      if (cancelled) return;
      setPinnedItems(page.notes.map((note) => {
        const relativePath = note.relativePath.replace(/\\/g, '/');
        const fullPath = pathInDirectory(notebookPath, relativePath);
        return {
          id: `pinned:${relativePath}`,
          fullPath,
          name: relativePath.split('/').pop() || relativePath,
          type: 'document' as const,
          parentId: null,
          children: null,
          sizeBytes: null,
          modifiedMs: note.updatedAt,
          createdMs: note.createdAt,
          memoCreatedMs: note.createdAt,
          resourceKind: 'note' as const,
          memoMeta: {
            id: relativePath,
            icon: note.icon,
            colors: note.colors,
            favorited: true,
          },
        };
      }));
    }).catch((error) => {
      logger.warn('failed to load pinned notes', { error, notebookPath });
      if (!cancelled) setPinnedItems([]);
    });
    return () => { cancelled = true; };
  }, [isActive, notebookId, notebookPath, refreshTrigger]);

  useEffect(() => {
    if (!isActive || !notebookId) {
      setTableDocuments([]);
      return;
    }
    let cancelled = false;
    void files.listTableDocuments(notebookId).then((documents) => {
      if (!cancelled) setTableDocuments(documents);
    }).catch((error) => {
      logger.warn('failed to load table documents', { error, notebookId });
      if (!cancelled) setTableDocuments([]);
    });
    return () => { cancelled = true; };
  }, [isActive, notebookId, refreshTrigger]);
  useEffect(() => {
    if (!isActive || !notebookId) {
      setMediaLibraries([]);
      return;
    }
    let cancelled = false;
    void files.listMediaLibraries(notebookId).then((libraries) => {
      if (!cancelled) setMediaLibraries(libraries);
    }).catch((error) => {
      logger.warn('failed to load media libraries', { error, notebookId });
      if (!cancelled) setMediaLibraries([]);
    });
    return () => { cancelled = true; };
  }, [isActive, notebookId, refreshTrigger]);
  useEffect(() => subscribe<{ notebookId: string }>('file-management-changed', (event) => {
    if (event.notebookId !== notebookId || !notebookId) return;
    void files.listTableDocuments(notebookId).then(setTableDocuments).catch((error) => {
      logger.warn('failed to refresh table documents', { error, notebookId });
    });
  }), [notebookId]);
  useEffect(() => subscribe<{ notebookId: string }>('file-management-changed', (event) => {
    if (event.notebookId !== notebookId || !notebookId) return;
    void files.listMediaLibraries(notebookId).then(setMediaLibraries).catch((error) => {
      logger.warn('failed to refresh media libraries', { error, notebookId });
    });
  }), [notebookId]);
  useEffect(() => subscribe<FileBrowserDirectoriesChangedEvent>(
    'file-browser-directories-changed',
    (event) => {
      if (!notebookId || canonicalPath(event.rootPath) !== canonicalPath(notebookPath)) return;
      void files.listTableDocuments(notebookId).then(setTableDocuments).catch((error) => {
        logger.warn('failed to refresh table documents after file change', { error, notebookId });
      });
    },
  ), [notebookId, notebookPath]);
  useEffect(() => subscribe<FileBrowserDirectoriesChangedEvent>(
    'file-browser-directories-changed',
    (event) => {
      if (!notebookId || canonicalPath(event.rootPath) !== canonicalPath(notebookPath)) return;
      void files.listMediaLibraries(notebookId).then(setMediaLibraries).catch((error) => {
        logger.warn('failed to refresh media libraries after file change', { error, notebookId });
      });
    },
  ), [notebookId, notebookPath]);

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
  const pinnedSectionHeight = pinnedItems.length > 0
    ? TREE_HEADER_HEIGHT + (pinnedCollapsed ? 0 : pinnedItems.length * TREE_ROW_SIZE) + 12
    : 0;
  const viewsSectionHeight = TREE_HEADER_HEIGHT + (viewsCollapsed ? 0 : (viewTableDocuments.length + viewMediaLibraries.length) * TREE_ROW_SIZE) + 12;
  const sectionHeights: Record<NotebookTreeSection, number> = {
    agents: notebookId ? agentSectionHeight : 0,
    pinned: pinnedSectionHeight,
    views: viewsSectionHeight,
    files: TREE_HEADER_HEIGHT,
    repositories: repositorySectionHeight,
  };
  const treeContentOffset = TREE_HEADER_HEIGHT + sectionOrder
    .slice(0, sectionOrder.indexOf('files'))
    .reduce((height, section) => height + (hiddenSections.includes(section) ? 0 : sectionHeights[section]), 0);
  const handleAgentSectionHeightChange = useCallback((height: number) => {
    setAgentSectionHeight((current) => current === height ? current : height);
  }, []);
  const handleRepositorySectionHeightChange = useCallback((height: number) => {
    setRepositorySectionHeight((current) => current === height ? current : height);
  }, []);
  const handleRepositoryExpand = useCallback((repositoryElement: HTMLElement) => {
    const scroller = treeScrollerRef.current;
    if (!scroller) return;
    const scrollerTop = scroller.getBoundingClientRect().top;
    const repositoryTop = repositoryElement.getBoundingClientRect().top;
    scroller.scrollTop += repositoryTop - scrollerTop - 36;
  }, []);
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
    enabled: !filesCollapsed,
    resetKey: notebookPath,
    overscan: TREE_VIRTUAL_OVERSCAN,
    keepAliveKeys,
    scrollMargin: treeContentOffset,
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
    const rowTop = treeContentOffset + index * TREE_ROW_SIZE;
    const rowBottom = rowTop + TREE_ROW_HEIGHT;
    if (rowTop < scroller.scrollTop) scroller.scrollTop = rowTop;
    else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, rowBottom - scroller.clientHeight);
    }
  }, [draft, renderRows, treeContentOffset]);
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
    const rowTop = treeContentOffset + index * TREE_ROW_SIZE;
    const rowBottom = rowTop + TREE_ROW_HEIGHT;
    if (rowTop < scroller.scrollTop) scroller.scrollTop = rowTop;
    else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, rowBottom - scroller.clientHeight);
    }
    pendingActiveFileScrollPathRef.current = null;
  }, [activeFilePath, renderRowIndexByPath, treeContentOffset]);
  const visibleDocumentPaths = useMemo(
    () => visibleTreeItems
      .filter(({ item }) => item.type === 'document')
      .map(({ item }) => item.fullPath),
    [visibleTreeItems],
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
  useLayoutEffect(() => {
    const nextActivePath = activeFilePath ? canonicalPath(activeFilePath) : null;
    if (previousActiveFilePathRef.current === nextActivePath) return;
    previousActiveFilePathRef.current = nextActivePath;
    if (selectedFilePathsRef.current.length === 0 && selectionAnchorPathRef.current === null) return;
    updateSelection([], null);
  }, [activeFilePath, updateSelection]);
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
    const rowTop = treeContentOffset + index * TREE_ROW_SIZE;
    const rowBottom = rowTop + TREE_ROW_HEIGHT;
    if (rowTop < scroller.scrollTop) scroller.scrollTop = rowTop;
    else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, rowBottom - scroller.clientHeight);
    }
    window.requestAnimationFrame(() => { focusMountedRow(); });
  }, [renderRowIndexByPath, treeContentOffset]);
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
    if (!isActive || !activeFilePath || tree.loading) return;
    void expandToRef.current(activeFilePath);
  }, [activeFilePath, isActive, tree.loading]);

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
    const isTableDocument = item.type === 'document' && isTableDocumentFilename(item.name);
    const isMediaLibrary = item.type === 'document' && isMediaLibraryFilename(item.name);
    const currentName = item.type === 'folder'
      ? item.name
      : isNote || isTableDocument || isMediaLibrary ? displayTitleFromFilename(item.name) : item.name;
    if (!trimmed || trimmed === currentName) return;

    try {
      if (item.type === 'folder') {
        const renamedPath = await files.renameFolder(item.fullPath, trimmed, notebookPath);
        updateNoteLinksAfterMove(item.fullPath, renamedPath, true);
      } else {
        if (isNote) {
          const fileIdentity = ensureFileDisplayIdentity(item.fullPath);
          const result = await renameMarkdownTitle({
            path: item.fullPath,
            title: trimmed,
            scopePath: notebookPath,
            displayId: fileIdentity.displayId,
            onPathChanged: (oldPath, newPath) => replaceExternalDocumentPath(fileIdentity.displayId, oldPath, newPath),
          });
          if (!result) return;
          if (!result.changed) return;
        } else {
          const extension = isTableDocument
            ? tableDocumentExtension(item.name)
            : isMediaLibrary ? mediaLibraryExtension(item.name)
              : isNote ? item.name.match(/\.(md|markdown)$/i)?.[0] ?? '' : '';
          await localDocumentOperations.rename({
            path: item.fullPath,
            name: `${trimmed}${extension}`,
            scopePath: notebookPath,
          });
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

  const handleRenameTableDocument = useCallback(async (item: DocTreeItem, nextName: string) => {
    const trimmed = nextName.trim();
    const currentName = displayTitleFromFilename(item.name);
    if (!trimmed || trimmed === currentName) return;
    try {
      await localDocumentOperations.rename({
        path: item.fullPath,
        name: `${trimmed}${tableDocumentExtension(item.name)}`,
        scopePath: notebookPath,
      });
      if (notebookId) setTableDocuments(await files.listTableDocuments(notebookId));
      toast.success(t('memo.fileTree.renamed', { name: trimmed }));
    } catch (error) {
      toast.error(t(String(error).includes('FILE_EXISTS')
        ? 'memo.fileTree.nameConflict'
        : 'memo.fileTree.renameFailed'));
    }
  }, [notebookId, notebookPath, t]);

  const handleDeleteTableDocument = useCallback(async (item: DocTreeItem) => {
    try {
      if (onDeleteFile) {
        await onDeleteFile(item);
      } else {
        const deleted = await files.delete(item.fullPath, notebookPath);
        if (!deleted) {
          toast.error(t('memo.fileTree.deleteFailed'));
          return;
        }
        toast.success(t('memo.fileTree.deleted', { name: displayTitleFromFilename(item.name) }));
      }
      if (notebookId) setTableDocuments(await files.listTableDocuments(notebookId));
    } catch {
      toast.error(t('memo.fileTree.deleteFailed'));
    }
  }, [notebookId, notebookPath, onDeleteFile, t]);
  const handleDeleteMediaLibrary = useCallback(async (item: DocTreeItem) => {
    try {
      if (onDeleteFile) {
        await onDeleteFile(item);
      } else {
        const deleted = await files.delete(item.fullPath, notebookPath);
        if (!deleted) {
          toast.error(t('memo.fileTree.deleteFailed'));
          return;
        }
        toast.success(t('memo.fileTree.deleted', { name: displayTitleFromFilename(item.name) }));
      }
      if (notebookId) setMediaLibraries(await files.listMediaLibraries(notebookId));
    } catch {
      toast.error(t('memo.fileTree.deleteFailed'));
    }
  }, [notebookId, notebookPath, onDeleteFile, t]);

  const handleTogglePath = useCallback((path: string) => {
    if (suppressOpenPathsRef.current.has(canonicalPath(path))) return;
    tree.toggle(path);
  }, [tree.toggle]);
  const handleOpenPath = useCallback((path: string, event?: ReactMouseEvent<HTMLDivElement>) => {
    if (suppressOpenPathsRef.current.has(canonicalPath(path))) return;
    selectNote(path, event);
  }, [selectNote]);
  const handleOpenRepositoryFile = useCallback((path: string, scopePath: string) => {
    void openExternalTarget(path, { destination: 'main-third', scopePath }).catch((error) => {
      logger.warn('failed to open repository file', { error, path });
      toast.error(t('memo.fileTree.openFailed'));
    });
  }, [t]);
  const handleOpenTableDocument = useCallback((relativePath: string) => {
    const path = joinNotebookMemoPath(notebookPath, relativePath);
    if (!path) return;
    void openExternalTarget(path, { destination: 'main-third', scopePath: notebookPath, notebookId }).catch((error) => {
      logger.warn('failed to open table document', { error, path });
      toast.error(t('memo.fileTree.openFailed'));
    });
  }, [notebookId, notebookPath, t]);
  const openNewTableDialog = useCallback((inViews = false, parentFolderPath?: string) => {
    setNewTableInViews(inViews);
    setNewTableParentFolder(parentFolderPath ?? null);
    setNewTableName(t('memo.create.tableDefaultName'));
    setNewTableDialogOpen(true);
  }, [t]);
  const handleSetTableDocumentInViews = useCallback(async (tableId: string, inViews: boolean) => {
    if (!notebookId) return;
    try {
      await files.setTableDocumentInViews(notebookId, tableId, inViews);
      setTableDocuments(await files.listTableDocuments(notebookId));
    } catch (error) {
      logger.warn('failed to update table view-group visibility', { error, notebookId, tableId });
      toast.error(t('multidimensionalTable.viewMembership.saveFailed'));
    }
  }, [notebookId, t]);
  const handleSetMediaLibraryInViews = useCallback(async (libraryId: string, inViews: boolean) => {
    if (!notebookId) return;
    try {
      await files.setMediaLibraryInViews(notebookId, libraryId, inViews);
      setMediaLibraries(await files.listMediaLibraries(notebookId));
    } catch (error) {
      logger.warn('failed to update media library view-group visibility', { error, notebookId, libraryId });
      toast.error(t('mediaLibrary.viewMembership.saveFailed'));
    }
  }, [notebookId, t]);
  const handleMakeTableIdentityUnique = useCallback(async (relativePath: string) => {
    if (!notebookId) return;
    try {
      const tableId = await files.makeViewDocumentIdentityUnique(notebookId, relativePath);
      setTableDocuments((current) => current.map((table) => table.relativePath === relativePath
        ? { ...table, tableId, inViews: false, identityConflict: false }
        : table));
      try {
        setTableDocuments(await files.listTableDocuments(notebookId));
      } catch (error) {
        logger.warn('failed to reload table catalog after assigning identity', { error, notebookId, relativePath });
      }
      toast.success(t('multidimensionalTable.identityRegenerated'));
    } catch (error) {
      logger.warn('failed to regenerate copied table identity', { error, notebookId, relativePath });
      toast.error(t('multidimensionalTable.identityRegenerateFailed'));
    }
  }, [notebookId, t]);
  const handleMakeMediaLibraryIdentityUnique = useCallback(async (relativePath: string) => {
    if (!notebookId) return;
    try {
      const libraryId = await files.makeViewDocumentIdentityUnique(notebookId, relativePath);
      setMediaLibraries((current) => current.map((library) => library.relativePath === relativePath
        ? { ...library, libraryId, inViews: false, identityConflict: false }
        : library));
      try {
        setMediaLibraries(await files.listMediaLibraries(notebookId));
      } catch (error) {
        logger.warn('failed to reload media library catalog after assigning identity', { error, notebookId, relativePath });
      }
      toast.success(t('mediaLibrary.identityRegenerated'));
    } catch (error) {
      logger.warn('failed to regenerate copied media library identity', { error, notebookId, relativePath });
      toast.error(t('mediaLibrary.identityRegenerateFailed'));
    }
  }, [notebookId, t]);
  const handleCreateTableDocument = useCallback(async () => {
    if (!notebookId || isCreatingTable) return;
    setIsCreatingTable(true);
    try {
      // A folder context menu targets that folder. Other entry points use the
      // notebook default; creating from Views additionally marks membership.
      const relativeFolder = newTableInViews || newTableParentFolder === null
        ? defaultCreateFolder
        : relativeFolderPath(notebookPath, newTableParentFolder);
      const { filePath, table } = await createTableDocumentFile(notebookPath, relativeFolder, newTableName);
      if (newTableInViews) {
        await files.setTableDocumentInViews(notebookId, table.table.id, true);
      }
      setNewTableDialogOpen(false);
      setNewTableName('');
      setNewTableInViews(false);
      setNewTableParentFolder(null);
      setTableDocuments(await files.listTableDocuments(notebookId));
      await openExternalTarget(filePath, { destination: 'main-third', scopePath: notebookPath, notebookId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建多维表格失败');
    } finally {
      setIsCreatingTable(false);
    }
  }, [defaultCreateFolder, isCreatingTable, newTableInViews, newTableName, newTableParentFolder, notebookId, notebookPath]);

  const openNewMediaLibraryDialog = useCallback((inViews = false, parentFolderPath?: string) => {
    setNewLibraryInViews(inViews);
    setNewLibraryParentFolder(parentFolderPath ?? null);
    setNewLibraryName(t('memo.create.mediaLibraryDefaultName'));
    setNewLibraryDialogOpen(true);
  }, [t]);
  const handleCreateMediaLibrary = useCallback(async () => {
    if (!notebookId || isCreatingLibrary) return;
    setIsCreatingLibrary(true);
    try {
      const relativeFolder = newLibraryParentFolder !== null
        ? relativeFolderPath(notebookPath, newLibraryParentFolder)
        : defaultCreateFolder;
      const { filePath, document } = await createMediaLibraryFile(notebookPath, relativeFolder, newLibraryName);
      if (newLibraryInViews) {
        await files.setMediaLibraryInViews(notebookId, document.library.id, true);
      }
      setNewLibraryDialogOpen(false);
      setNewLibraryName('');
      setNewLibraryInViews(false);
      setNewLibraryParentFolder(null);
      setMediaLibraries(await files.listMediaLibraries(notebookId));
      await openExternalTarget(filePath, { destination: 'main-third', scopePath: notebookPath, notebookId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建媒体库失败');
    } finally {
      setIsCreatingLibrary(false);
    }
  }, [defaultCreateFolder, isCreatingLibrary, newLibraryInViews, newLibraryName, newLibraryParentFolder, notebookId, notebookPath]);
  const handleAddRepository = useCallback(async () => {
    if (!notebookId) return;
    const result = await useAgentAccessStore.getState().addFolderFromPicker();
    if (!result.ok) {
      if (result.code === 'already-tracked') toast.error(t('agent.access.alreadyTracked'));
      else if (result.code === 'save-failed') toast.error(t('agent.access.saveFailed'));
      return;
    }

    const access = useAgentAccessStore.getState();
    const notebookFiles = resolveNotebookAgentFiles(access.config, access.notebookConfigs, notebookId);
    const folders = notebookFiles?.folders ?? [];
    const addedPath = normalizeWorkspacePath(result.entry.path).toLowerCase();
    if (folders.some((path) => normalizeWorkspacePath(path).toLowerCase() === addedPath)) {
      toast.info(t('agent.access.folderExists'));
      return;
    }
    const saved = await access.setDefaultFiles(notebookId, {
      folders: [...folders, result.entry.path],
      notebooks: notebookFiles?.notebooks ?? [],
    });
    if (!saved) toast.error(t('agent.access.saveFailed'));
  }, [notebookId, t]);
  const handleRemoveRepository = useCallback(async (repository: WorkspaceAgentRepository) => {
    if (!notebookId) return;
    const access = useAgentAccessStore.getState();
    const notebookFiles = resolveNotebookAgentFiles(access.config, access.notebookConfigs, notebookId);
    const folders = notebookFiles?.folders ?? [];
    const removedPath = normalizeWorkspacePath(repository.path).toLowerCase();
    const nextFolders = folders.filter((path) => normalizeWorkspacePath(path).toLowerCase() !== removedPath);
    if (nextFolders.length === folders.length) return;
    const saved = await access.setDefaultFiles(notebookId, {
      folders: nextFolders,
      notebooks: notebookFiles?.notebooks ?? [],
    });
    if (!saved) {
      toast.error(t('agent.access.saveFailed'));
      return;
    }
    toast.success(t('agent.access.folderDeleted', { name: repository.name }));
  }, [notebookId, t]);
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
      const resourceMetadata = sourceItem?.resourceKind
        ? { resourceKind: sourceItem.resourceKind }
        : {};
      return { path, ...resourceMetadata };
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
  }, [treeItemByPath]);

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
    const tableDocument = tableDocumentByPath.get(canonicalPath(item.fullPath));
    const mediaLibrary = mediaLibraryByPath.get(canonicalPath(item.fullPath));
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
          onRetryChildren={() => { void tree.retryDirectory?.(item.fullPath); }}
          active={item.type === 'folder'
            ? Boolean(selectedFolderPath) && canonicalPath(item.fullPath) === canonicalPath(selectedFolderPath!)
            : !selectedFolderPath && Boolean(activeFilePath) && canonicalPath(item.fullPath) === canonicalPath(activeFilePath!)}
          selected={item.type === 'document' && selectedFilePathSet.has(canonicalPath(item.fullPath))}
          moveStatus={moveStatus}
          onToggle={handleTogglePath}
          onSelectFolder={onFolderSelect}
          onOpen={handleOpenPath}
          onOpenInNewTab={onNoteOpenInNewTab ? handleOpenPathInNewTab : undefined}
          onCreateNote={handleCreateNoteAtPath}
          onCreateFolder={handleCreateFolderAtPath}
          onCreateView={(parentPath) => {
            openNewTableDialog(false, parentPath);
          }}
          onCreateMediaLibrary={(parentPath) => openNewMediaLibraryDialog(false, parentPath)}
          tableViewVisibility={tableDocument ? {
            tableId: tableDocument.tableId,
            inViews: tableDocument.inViews,
            identityConflict: tableDocument.identityConflict ?? false,
            onChange: (inViews) => { void handleSetTableDocumentInViews(tableDocument.tableId, inViews); },
            onMakeIdentityUnique: () => { void handleMakeTableIdentityUnique(tableDocument.relativePath); },
          } : undefined}
          mediaLibraryViewVisibility={mediaLibrary ? {
            inViews: mediaLibrary.inViews,
            identityConflict: mediaLibrary.identityConflict ?? false,
            onChange: (inViews) => { void handleSetMediaLibraryInViews(mediaLibrary.libraryId, inViews); },
            onMakeIdentityUnique: () => { void handleMakeMediaLibraryIdentityUnique(mediaLibrary.relativePath); },
          } : undefined}
          onCustomizeDisplay={(anchorRect) => {
            setCustomizeAnchorRect(anchorRect);
            setCustomizeOrder([...sectionOrder]);
            setCustomizeHidden([...hiddenSections]);
            setCustomizeOpen(true);
          }}
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
      <ListSurfaceViewport>
        <OverlayScrollbar
          className="h-full"
          scrollerClassName="h-full overflow-y-auto pt-1 pb-1"
          scrollerRef={treeScrollerRef}
          onScroll={(event) => {
            onVirtualTreeScroll(event);
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
              sectionActions={(
                <TreeSectionMoreMenu
                  canMoveUp={visibleSectionOrder.indexOf('agents') > 0}
                  canMoveDown={visibleSectionOrder.indexOf('agents') < visibleSectionOrder.length - 1}
                  onMoveUp={() => moveTreeSection('agents', -1)}
                  onMoveDown={() => moveTreeSection('agents', 1)}
                  onCustomizeDisplay={openCustomizeDisplay}
                />
              )}
            />
          )}
          {pinnedItems.length > 0 && !hiddenSections.includes('pinned') && <section
            className="pb-3"
            aria-label={t('memo.fileTree.pinnedSectionTitle')}
            data-notebook-pinned-section="true"
            style={{ order: sectionOrder.indexOf('pinned') + 1 }}
          >
              <div
                className="notebook-file-tree__section-header group mb-0.5 flex h-7 items-center rounded-lg px-1.5 transition-colors hover:bg-[var(--muted)]"
                style={{
                  marginLeft: TREE_EDGE_GUTTER,
                  width: `calc(100% - ${TREE_EDGE_GUTTER * 2}px)`,
                }}
              >
                <button
                  type="button"
                  className="flex h-full items-center gap-0.5 text-[0.82rem] font-medium text-[var(--muted-foreground)] opacity-90 hover:text-[var(--foreground)] focus-visible:outline-none"
                  aria-label={t(pinnedCollapsed ? 'memo.fileTree.expandPinned' : 'memo.fileTree.collapsePinned')}
                  title={t(pinnedCollapsed ? 'memo.fileTree.expandPinned' : 'memo.fileTree.collapsePinned')}
                  onClick={() => setPinnedCollapsed((collapsed) => !collapsed)}
                >
                  <span>{t('memo.fileTree.pinnedSectionTitle')}</span>
                  <ChevronRight className={cn('h-3.5 w-3.5 opacity-0 transition-[opacity,transform] group-hover:opacity-100 group-focus-within:opacity-100', pinnedCollapsed && 'opacity-100', !pinnedCollapsed && 'rotate-90')} />
                </button>
                <div className="ml-auto flex items-center">
                  <TreeSectionMoreMenu
                    canMoveUp={visibleSectionOrder.indexOf('pinned') > 0}
                    canMoveDown={visibleSectionOrder.indexOf('pinned') < visibleSectionOrder.length - 1}
                    onMoveUp={() => moveTreeSection('pinned', -1)}
                    onMoveDown={() => moveTreeSection('pinned', 1)}
                    onCustomizeDisplay={openCustomizeDisplay}
                  />
                </div>
              </div>
              {!pinnedCollapsed && pinnedItems.map((item) => (
                <NotebookTreeRow
                  key={item.fullPath}
                  item={item}
                  notebookPath={notebookPath}
                  parentPath={parentDirectoryPath(item.fullPath, notebookPath)}
                  depth={0}
                  expanded={false}
                  active={!selectedFolderPath && Boolean(activeFilePath) && samePath(item.fullPath, activeFilePath!)}
                  selected={selectedFilePathSet.has(canonicalPath(item.fullPath))}
                  onToggle={handleTogglePath}
                  onOpen={handleOpenPath}
                  onOpenInNewTab={onNoteOpenInNewTab ? handleOpenPathInNewTab : undefined}
                  onCreateNote={handleCreateNoteAtPath}
                  onCreateFolder={handleCreateFolderAtPath}
                  onCreateView={(parentPath) => {
                    openNewTableDialog(false, parentPath);
                  }}
                  onCustomizeDisplay={(anchorRect) => {
                    setCustomizeAnchorRect(anchorRect);
                    setCustomizeOrder([...sectionOrder]);
                    setCustomizeHidden([...hiddenSections]);
                    setCustomizeOpen(true);
                  }}
                  onRename={handleRename}
                  onDeleteFile={onDeleteFile}
                  onPointerDown={() => {}}
                  onFocus={handleFocusPath}
                  onKeepAliveChange={handleRowKeepAliveChange}
                  favoritePath={joinNotebookMemoPath(notebookPath, item.memoMeta?.id) ?? undefined}
                  onFavoriteChanged={(itemId, favorited) => {
                    if (!favorited) setPinnedItems((current) => current.filter((pinned) => pinned.id !== itemId));
                  }}
                  tabIndex={0}
                />
              ))}
          </section>}
          {!hiddenSections.includes('views') && <section
            className="pb-3"
            aria-label={t('memo.fileTree.viewsSectionTitle')}
            data-notebook-views-section="true"
            style={{ order: sectionOrder.indexOf('views') + 1 }}
          >
            <div
              className="notebook-file-tree__section-header group mb-0.5 flex h-7 items-center rounded-lg px-1.5 transition-colors hover:bg-[var(--muted)]"
              style={{
                marginLeft: TREE_EDGE_GUTTER,
                width: `calc(100% - ${TREE_EDGE_GUTTER * 2}px)`,
              }}
            >
              <button
                type="button"
                className="flex h-full items-center gap-0.5 text-[0.82rem] font-medium text-[var(--muted-foreground)] opacity-90 hover:text-[var(--foreground)] focus-visible:outline-none"
                aria-label={t(viewsCollapsed ? 'memo.fileTree.expandViews' : 'memo.fileTree.collapseViews')}
                title={t(viewsCollapsed ? 'memo.fileTree.expandViews' : 'memo.fileTree.collapseViews')}
                onClick={() => setViewsCollapsed((collapsed) => !collapsed)}
              >
                <span>{t('memo.fileTree.viewsSectionTitle')}</span>
                <ChevronRight className={cn('h-3.5 w-3.5 opacity-0 transition-[opacity,transform] group-hover:opacity-100 group-focus-within:opacity-100', viewsCollapsed && 'opacity-100', !viewsCollapsed && 'rotate-90')} />
              </button>
              <div className="ml-auto flex items-center">
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] opacity-0 transition-[color,opacity] hover:text-[var(--foreground)] focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
                  aria-label={t('memo.create.table')}
                  title={t('memo.create.table')}
                  onClick={() => openNewTableDialog(true)}
                >
                  <ListPlus className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] opacity-0 transition-[color,opacity] hover:text-[var(--foreground)] focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
                  aria-label={t('memo.create.mediaLibraryTitle')}
                  title={t('memo.create.mediaLibraryTitle')}
                  onClick={() => openNewMediaLibraryDialog(true)}
                >
                  <GalleryHorizontalEnd className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <TreeSectionMoreMenu
                  canMoveUp={visibleSectionOrder.indexOf('views') > 0}
                  canMoveDown={visibleSectionOrder.indexOf('views') < visibleSectionOrder.length - 1}
                  onMoveUp={() => moveTreeSection('views', -1)}
                  onMoveDown={() => moveTreeSection('views', 1)}
                />
              </div>
            </div>
            {!viewsCollapsed && viewTableDocuments.map((table) => {
              const tablePath = joinNotebookMemoPath(notebookPath, table.relativePath);
              const active = Boolean(!selectedFolderPath && activeFilePath && tablePath && samePath(activeFilePath, tablePath));
              if (!tablePath) return null;
              const tableItem = tableDocumentTreeItem(table, tablePath);
              const parentPath = parentDirectoryPath(tablePath, notebookPath);
              return <NotebookTreeRow
                key={table.relativePath}
                item={tableItem}
                notebookPath={notebookPath}
                parentPath={parentPath}
                depth={0}
                expanded={false}
                active={active}
                selected={active}
                onToggle={() => {}}
                onOpen={() => handleOpenTableDocument(table.relativePath)}
                onOpenInNewTab={onNoteOpenInNewTab ? handleOpenPathInNewTab : undefined}
                onCreateNote={handleCreateNoteAtPath}
                onCreateFolder={handleCreateFolderAtPath}
                onCreateView={() => {
                  openNewTableDialog(true);
                }}
                tableViewVisibility={{
                  tableId: table.tableId,
                  inViews: table.inViews,
                  identityConflict: table.identityConflict ?? false,
                  onChange: (inViews) => { void handleSetTableDocumentInViews(table.tableId, inViews); },
                  onMakeIdentityUnique: () => { void handleMakeTableIdentityUnique(table.relativePath); },
                }}
                onCustomizeDisplay={openCustomizeDisplay}
                onRename={handleRenameTableDocument}
                onDeleteFile={handleDeleteTableDocument}
                onPointerDown={() => {}}
                onFocus={handleFocusPath}
                tabIndex={0}
              />;
            })}
            {!viewsCollapsed && viewMediaLibraries.map((library) => {
              const libraryPath = joinNotebookMemoPath(notebookPath, library.relativePath);
              if (!libraryPath) return null;
              const active = Boolean(!selectedFolderPath && activeFilePath && samePath(activeFilePath, libraryPath));
              const libraryItem = mediaLibraryTreeItem(library, libraryPath);
              const parentPath = parentDirectoryPath(libraryPath, notebookPath);
              return <NotebookTreeRow
                key={library.relativePath}
                item={libraryItem}
                notebookPath={notebookPath}
                parentPath={parentPath}
                depth={0}
                expanded={false}
                active={active}
                selected={active}
                onToggle={() => {}}
                onOpen={() => handleOpenPath(libraryPath)}
                onOpenInNewTab={onNoteOpenInNewTab ? handleOpenPathInNewTab : undefined}
                onCreateNote={handleCreateNoteAtPath}
                onCreateFolder={handleCreateFolderAtPath}
                mediaLibraryViewVisibility={{
                  inViews: library.inViews,
                  identityConflict: library.identityConflict ?? false,
                  onChange: (inViews) => { void handleSetMediaLibraryInViews(library.libraryId, inViews); },
                  onMakeIdentityUnique: () => { void handleMakeMediaLibraryIdentityUnique(library.relativePath); },
                }}
                onCustomizeDisplay={openCustomizeDisplay}
                onRename={handleRename}
                onDeleteFile={handleDeleteMediaLibrary}
                onPointerDown={() => {}}
                onFocus={handleFocusPath}
                tabIndex={0}
              />;
            })}
          </section>}
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
              <button
                type="button"
                onClick={() => openNewTableDialog()}
                aria-label={t('memo.create.table')}
                title={t('memo.create.table')}
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] opacity-0 transition-[color,opacity] hover:text-[var(--foreground)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--brand)] group-hover:opacity-100"
              >
                <ListPlus className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => openNewMediaLibraryDialog()}
                aria-label={t('memo.create.mediaLibraryTitle')}
                title={t('memo.create.mediaLibraryTitle')}
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] opacity-0 transition-[color,opacity] hover:text-[var(--foreground)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--brand)] group-hover:opacity-100"
              >
                <GalleryHorizontalEnd className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <TreeSectionMoreMenu
                canMoveUp={visibleSectionOrder.indexOf('files') > 0}
                canMoveDown={visibleSectionOrder.indexOf('files') < visibleSectionOrder.length - 1}
                onMoveUp={() => moveTreeSection('files', -1)}
                onMoveDown={() => moveTreeSection('files', 1)}
                onCreateFolder={onCreateFolder}
                onCreateNote={() => handleCreateNoteAtPath(notebookPath)}
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
            {tree.error && (
              <div className="flex items-center justify-center gap-2 px-4 py-4 text-center text-xs text-[var(--muted-foreground)]" role="alert">
                <span>{t('memo.fileTree.unreadableHint')}</span>
                <Button type="button" size="xs" variant="ghost" onClick={() => void tree.reload()}>
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
          </div>}
          </section>}
          {!hiddenSections.includes('repositories') && (
            <AgentRepositoriesSection
              repositories={agentRepositories}
              order={sectionOrder.indexOf('repositories') + 1}
              onHeightChange={handleRepositorySectionHeightChange}
              canMoveUp={visibleSectionOrder.indexOf('repositories') > 0}
              canMoveDown={visibleSectionOrder.indexOf('repositories') < visibleSectionOrder.length - 1}
              onMoveUp={() => moveTreeSection('repositories', -1)}
              onMoveDown={() => moveTreeSection('repositories', 1)}
              onAddRepository={() => { void handleAddRepository(); }}
              onRemoveRepository={(repository) => { void handleRemoveRepository(repository); }}
              onExpandRepository={handleRepositoryExpand}
              canAddRepository={Boolean(notebookId)}
              onOpenFile={handleOpenRepositoryFile}
              onOpenInNewTab={onNoteOpenInNewTab ? handleOpenPathInNewTab : undefined}
              onCustomizeDisplay={(anchorRect) => {
                setCustomizeAnchorRect(anchorRect);
                setCustomizeOrder([...sectionOrder]);
                setCustomizeHidden([...hiddenSections]);
                setCustomizeOpen(true);
              }}
            />
          )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-[180px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
              <ContextMenuItem
                onClick={() => handleCreateNoteAtPath(notebookPath)}
                className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
              >
                <FileIcon className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('memo.fileTree.newNote')}
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => handleCreateFolderAtPath(notebookPath)}
                className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
              >
                <FolderSimplePlusIcon className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('memo.fileTree.newFolder')}
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => openNewTableDialog(false, notebookPath)}
                className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
              >
                <Table2 className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('memo.create.table')}
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => openNewMediaLibraryDialog(false, notebookPath)}
                className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
              >
                <GalleryHorizontalEnd className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('memo.create.mediaLibraryTitle')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={(event) => {
                  setCustomizeAnchorRect(getPopupOriginRect(event.currentTarget));
                  setCustomizeOrder([...sectionOrder]);
                  setCustomizeHidden([...hiddenSections]);
                  setCustomizeOpen(true);
                }}
                className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
              >
                <SquaresFourIcon className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('memo.fileTree.customizeDisplay')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </OverlayScrollbar>
        {!hasVisibleItems && tree.loading && (
          <ListSurfaceLoadingState
            label={t('memo.fileTree.loading')}
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
      <Dialog open={newTableDialogOpen} onOpenChange={setNewTableDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">{t('memo.create.tableDialogTitle')}</DialogTitle>
            <DialogDescription>{t('memo.create.tableDescription')}</DialogDescription>
          </DialogHeader>
          <form className="mt-2 space-y-4" onSubmit={(event) => { event.preventDefault(); void handleCreateTableDocument(); }}>
            <input
              autoFocus
              value={newTableName}
              onChange={(event) => setNewTableName(event.target.value)}
              placeholder={t('memo.create.tableDefaultName')}
              className="h-8 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--brand)]"
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" className="h-8 rounded-lg text-sm" onClick={() => setNewTableDialogOpen(false)}>{t('dialog.cancel')}</Button>
              <Button type="submit" size="sm" className="h-8 rounded-lg text-sm" disabled={!newTableName.trim() || isCreatingTable}>
                {isCreatingTable ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {isCreatingTable ? t('memo.create.creating') : t('memo.create.confirm')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={newLibraryDialogOpen} onOpenChange={setNewLibraryDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('memo.create.mediaLibraryTitle')}</DialogTitle>
            <DialogDescription>{t('memo.create.mediaLibraryDescription')}</DialogDescription>
          </DialogHeader>
          <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void handleCreateMediaLibrary(); }}>
            <input autoFocus value={newLibraryName} onChange={(event) => setNewLibraryName(event.target.value)} placeholder={t('memo.create.mediaLibraryDefaultName')} className="h-9 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--brand)]" />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => setNewLibraryDialogOpen(false)}>{t('dialog.cancel')}</Button>
              <Button type="submit" size="sm" className="rounded-lg" disabled={!newLibraryName.trim() || isCreatingLibrary}>
                {isCreatingLibrary ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {isCreatingLibrary ? t('memo.create.creating') : t('memo.create.confirm')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Popover open={customizeOpen} onOpenChange={setCustomizeOpen} anchorRect={customizeAnchorRect}>
        <PopoverContent side="bottom" align="start" sideOffset={0} className="w-[190px] max-w-[calc(100vw-16px)] rounded-2xl p-[5px] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <DialogHeader className="mb-0 flex min-h-8 items-center justify-between px-1">
            <DialogTitle className="text-sm">{t('memo.fileTree.customizeDisplay')}</DialogTitle>
            <button type="button" className="rounded-md px-2 py-1 text-xs font-medium text-[var(--primary)] transition-colors hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]" onClick={() => {
              setSectionOrder(customizeOrder);
              setHiddenSections(customizeHidden);
              if (notebookId) {
                void system.setNotebookFileTreeSectionOrder(notebookId, customizeOrder, customizeHidden).catch((error) => logger.warn('failed to save notebook file tree preferences', { error, notebookId }));
              }
              setCustomizeOpen(false);
            }}>完成</button>
          </DialogHeader>
          <div className="space-y-0.5" aria-label="文件树分区展示与顺序">
            {customizeOrder.map((section) => {
              const labels: Record<NotebookTreeSection, string> = {
                agents: t('memo.fileTree.agentsSectionTitle'),
                pinned: t('memo.fileTree.pinnedSectionTitle'),
                views: t('memo.fileTree.viewsSectionTitle'),
                files: t('memo.fileTree.sectionTitle'),
                repositories: t('memo.fileTree.repositoriesTitle'),
              };
              const selected = !customizeHidden.includes(section);
              return <div key={section} data-customize-section={section} className={cn('group relative flex h-8 items-center gap-2 rounded-lg px-2 transition-colors hover:bg-[var(--muted)]', draggedSection.current === section && 'opacity-50')}>
                {sectionDropTarget?.section === section && draggedSection.current !== section && <span aria-hidden="true" className={cn('pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-[var(--primary)]', sectionDropTarget.after ? '-bottom-0.5' : '-top-0.5')} />}
                <button type="button" role="checkbox" aria-checked={selected} aria-label={`展示${labels[section]}`} onClick={() => setCustomizeHidden((current) => selected ? [...current, section] : current.filter((item) => item !== section))} className={cn('notebook-file-tree__display-checkbox focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]', selected && 'notebook-file-tree__display-checkbox--checked')}>
                  {selected && <span className="notebook-file-tree__display-checkbox-mark" aria-hidden="true" />}
                </button>
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--foreground)]">{labels[section]}</span>
                <button type="button" onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  draggedSection.current = section;
                  sectionDragPointerId.current = event.pointerId;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  event.preventDefault();
                }} onPointerMove={(event) => {
                  if (sectionDragPointerId.current !== event.pointerId) return;
                  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-customize-section]');
                  const target = row?.dataset.customizeSection as NotebookTreeSection | undefined;
                  if (!row || !target || target === draggedSection.current) {
                    sectionDropTargetRef.current = null;
                    setSectionDropTarget(null);
                    return;
                  }
                  const bounds = row.getBoundingClientRect();
                  const next = { section: target, after: event.clientY >= bounds.top + bounds.height / 2 };
                  sectionDropTargetRef.current = next;
                  setSectionDropTarget(next);
                }} onPointerUp={(event) => {
                  if (sectionDragPointerId.current !== event.pointerId) return;
                  const source = draggedSection.current;
                  const target = sectionDropTargetRef.current;
                  if (source && target) setCustomizeOrder((current) => {
                    const next = current.filter((item) => item !== source);
                    next.splice(next.indexOf(target.section) + (target.after ? 1 : 0), 0, source);
                    return next;
                  });
                  draggedSection.current = null;
                  sectionDragPointerId.current = null;
                  sectionDropTargetRef.current = null;
                  setSectionDropTarget(null);
                }} onPointerCancel={() => {
                  draggedSection.current = null;
                  sectionDragPointerId.current = null;
                  sectionDropTargetRef.current = null;
                  setSectionDropTarget(null);
                }} onKeyDown={(event) => {
                  const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
                  if (!direction) return;
                  event.preventDefault();
                  setCustomizeOrder((current) => {
                    const index = current.indexOf(section);
                    const target = index + direction;
                    if (target < 0 || target >= current.length) return current;
                    const next = [...current];
                    [next[index], next[target]] = [next[target], next[index]];
                    return next;
                  });
                }} aria-label={`排序${labels[section]}，使用上下方向键调整`} className="flex h-7 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] active:cursor-grabbing">
                  <GripVertical className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>;
            })}
          </div>
        </PopoverContent>
      </Popover>
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
          'relative flex h-[18px] w-[18px] shrink-0 items-center justify-center',
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
          <NotebookTreeFileIcon className="notebook-file-tree__default-file-icon h-[18px] w-[18px]" />
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
