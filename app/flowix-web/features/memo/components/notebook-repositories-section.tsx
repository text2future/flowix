import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowRight, ChevronRight, GitBranch, Plus } from 'lucide-react';
import { CopyIcon, FolderOpenIcon, MinusCircleIcon, PencilSimpleIcon, SquareSplitHorizontalIcon, TrashSimpleIcon } from '@phosphor-icons/react';
import { useActiveFilePath } from '@features/workspace/public/active-file-path-api';
import type { WorkspaceAgentRepository } from '@features/agent/public/workspace-api';
import { renameWorkspaceFile } from '@features/workspace/public/shell-api';
import { ResourceFileIcon, ResourceFolderIcon } from '@features/surface/resource-file-icon';
import { resourceKindFromPath } from '@features/editor/code-file';
import { files, dialogs, product, type DocTreeItem } from '@platform/tauri/client';
import { canonicalPath, parentDirectoryPath, samePath } from '@/lib/path';
import { cn, displayTitleFromFilename, isMediaLibraryFilename, isTableDocumentFilename, mediaLibraryExtension, tableDocumentExtension } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { ListSurfaceSpinner } from '@shared/ui/list-surface';
import { TreeSectionEmptyState } from '@shared/ui/tree-section-empty-state';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSubmenu, ContextMenuTrigger } from '@shared/ui/context-menu';
import { NotebookCopyContextMenu } from './notebook-copy-context-menu';
import {
  normalizeNotebookMoveFailure,
  showNotebookMoveFailureToasts,
  type NotebookMoveFailure,
} from './notebook-move-failure-toast';
import { getNotebookFolderImportErrorKey } from './notebook-folder-import';
import { clearWorkspaceTargetsForDeletedDirectory } from '@features/workspace/public/shell-api';
import { useFolderTree } from './use-folder-tree';
import { TREE_EDGE_GUTTER, INDENT_PER_LEVEL } from './notebook-tree-layout';
import { fileTreeRenameFailureKey } from './file-tree-failure';

const logger = createLogger('notebook-repositories');

function AgentRepositoryItem({
  repository,
  onOpenFile,
  onOpenFileInMainColumn,
  onRemoveRepository,
  onExpandRepository,
}: {
  repository: WorkspaceAgentRepository;
  onOpenFile: (path: string, scopePath: string) => void;
  onOpenFileInMainColumn: (path: string, scopePath: string) => void;
  onRemoveRepository: (repository: WorkspaceAgentRepository) => void;
  onExpandRepository: (element: HTMLElement) => void;
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
  // Repository files open in the Browser column by default, so the "current"
  // marker has to follow whichever host actually shows the file.
  const activeFilePath = useActiveFilePath();
  const renameItem = async (item: DocTreeItem, value: string) => {
    const name = value.trim();
    setRenaming(null);
    const isTableDocument = item.type === 'document' && isTableDocumentFilename(item.name);
    const isMediaLibrary = item.type === 'document' && isMediaLibraryFilename(item.name);
    const currentName = isTableDocument || isMediaLibrary ? displayTitleFromFilename(item.name) : item.name;
    if (!name || name === currentName) return;
    try {
      if (item.type === 'folder') {
        await tree.renameFolder(item.fullPath, name, repository.path);
      }
      else {
        const extension = isTableDocument ? tableDocumentExtension(item.name) : isMediaLibrary ? mediaLibraryExtension(item.name) : '';
        await renameWorkspaceFile({ path: item.fullPath, name: `${name}${extension}`, scopePath: repository.path });
      }
      if (item.type !== 'folder') await tree.refresh(parentDirectoryPath(item.fullPath, repository.path));
      toast.success(t('memo.fileTree.renamed', { name }));
    } catch (error) {
      toast.error(t(fileTreeRenameFailureKey(error)));
    }
  };
  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      const ok = deleting.type === 'folder'
        ? await files.deleteFolder(deleting.fullPath, repository.path)
        : await files.delete(deleting.fullPath, repository.path);
      if (!ok) throw new Error('delete failed');
      if (deleting.type === 'folder') {
        try {
          await clearWorkspaceTargetsForDeletedDirectory(deleting.fullPath);
        } catch (cleanupError) {
          logger.warn('folder deleted, but workspace targets could not be fully cleared', { cleanupError, folderPath: deleting.fullPath });
          toast.error(t('memo.fileTree.deleteFolderViewCleanupFailed'));
        }
      }
      await tree.refresh(parentDirectoryPath(deleting.fullPath, repository.path));
      toast.success(t('status.deleteCompleted'));
      setDeleting(null);
    } catch (error) {
      await tree.refresh(parentDirectoryPath(deleting.fullPath, repository.path)).catch(() => {});
      toast.error(t(String(error).includes('FOLDER_DELETE_PARTIAL') ? 'memo.fileTree.deletePartialFailed' : 'memo.fileTree.deleteFailed'));
    }
  };
  const importIntoRepository = async (targetDirectoryPath: string) => {
    const selectedPaths = await dialogs.selectFiles({ multiple: true });
    if (!selectedPaths?.length) return;
    const failures: NotebookMoveFailure[] = [];
    for (const sourcePath of selectedPaths) {
      try {
        await files.importFile(sourcePath, targetDirectoryPath, repository.path);
      } catch (error) {
        logger.warn('importing file into access space failed', { error, sourcePath, targetDirectoryPath });
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
  };
  const importFolderIntoRepository = async (targetDirectoryPath: string) => {
    let sourceDirectoryPath: string | null | undefined;
    let progressToastId: string | number | undefined;
    try {
      sourceDirectoryPath = await dialogs.selectImportDirectory();
      if (!sourceDirectoryPath) return;
      progressToastId = toast.info(t('memo.fileTree.importFolderInProgress'), { duration: Number.POSITIVE_INFINITY });
      await files.importFolder(sourceDirectoryPath, targetDirectoryPath, repository.path);
      await tree.refresh(targetDirectoryPath);
      toast.dismiss(progressToastId);
      progressToastId = undefined;
      toast.success(t('memo.fileTree.importFolderSuccess'));
    } catch (error) {
      logger.warn('importing folder into access space failed', { error, sourceDirectoryPath, targetDirectoryPath });
      if (sourceDirectoryPath) {
        try {
          await tree.refresh(targetDirectoryPath);
        } catch (refreshError) {
          logger.warn('refreshing access space after folder import failed', { refreshError, targetDirectoryPath });
        }
      }
      toast.error(t(getNotebookFolderImportErrorKey(error)));
    } finally {
      if (progressToastId !== undefined) toast.dismiss(progressToastId);
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
                  'absolute left-1/2 top-1/2 h-[15px] w-[15px] -translate-x-1/2 -translate-y-1/2 text-[color-mix(in_oklch,var(--foreground)_70%,black_30%)] [[data-theme="dark"]_&]:text-[var(--foreground)] [[data-theme="mist"]_&]:text-[var(--foreground)] opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 group-focus-visible:opacity-100',
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
        {!isFolder && <ContextMenuItem onClick={() => onOpenFileInMainColumn(item.fullPath, repository.path)} className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"><SquareSplitHorizontalIcon className="mr-2 h-4 w-4" aria-hidden="true" />{t('memo.fileTree.openInLeft')}</ContextMenuItem>}
        <ContextMenuSubmenu label={t('memo.fileTree.import')} icon={<Plus className="h-4 w-4" aria-hidden="true" />}>
          <ContextMenuItem onClick={() => { void importIntoRepository(isFolder ? item.fullPath : parentDirectoryPath(item.fullPath, repository.path)); }} className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]">
            {t('memo.fileTree.importFiles')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => { void importFolderIntoRepository(isFolder ? item.fullPath : parentDirectoryPath(item.fullPath, repository.path)); }} className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]">
            {t('memo.fileTree.importFolder')}
          </ContextMenuItem>
        </ContextMenuSubmenu>
        <ContextMenuItem onClick={() => setRenaming({ item, value: item.type === 'document' && (isTableDocumentFilename(item.name) || isMediaLibraryFilename(item.name)) ? displayTitleFromFilename(item.name) : item.name })} className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"><PencilSimpleIcon className="mr-2 h-4 w-4" aria-hidden="true" />{t('memo.fileTree.rename')}</ContextMenuItem>
        {!isFolder && <NotebookCopyContextMenu path={item.fullPath} isNote={(item.resourceKind ?? resourceKindFromPath(item.name)) === 'note'} />}
        {isFolder && <ContextMenuItem onClick={async () => { try { await navigator.clipboard.writeText(item.fullPath); toast.success(t('memo.fileTree.pathCopied')); } catch { toast.error(t('memo.fileTree.copyFailed')); } }} className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"><CopyIcon className="mr-2 h-4 w-4" aria-hidden="true" />{t('memo.fileTree.copyPath')}</ContextMenuItem>}
        <ContextMenuItem onClick={() => { void product.revealInFileManager(item.fullPath).catch(() => toast.error(t('memo.fileTree.openFailed'))); }} className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"><FolderOpenIcon className="mr-2 h-4 w-4" aria-hidden="true" />{t('memo.fileTree.reveal')}</ContextMenuItem>
        {!isFolder && (item.resourceKind ?? resourceKindFromPath(item.name)) !== 'note' && <ContextMenuSeparator />}
        <ContextMenuItem onClick={() => setDeleting(item)} className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left hover:bg-transparent hover:text-[var(--destructive)]"><TrashSimpleIcon className="mr-2 h-4 w-4" aria-hidden="true" />{t('memo.fileTree.delete')}</ContextMenuItem>
      </ContextMenuContent>
      </ContextMenu>
    );
  });

  return (
    <>
      <div className={cn(
        'overflow-hidden rounded-xl border transition-colors',
        expanded && 'mb-1',
      )} ref={repositoryRef} style={{ borderColor: expanded ? 'var(--border)' : 'transparent' }}>
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
                  'absolute left-1/2 top-1/2 h-[15px] w-[15px] -translate-x-1/2 -translate-y-1/2 text-[color-mix(in_oklch,var(--foreground)_70%,black_30%)] [[data-theme="dark"]_&]:text-[var(--foreground)] [[data-theme="mist"]_&]:text-[var(--foreground)] opacity-100 transition-[opacity,transform]',
                  expanded && 'rotate-90',
                )} aria-hidden="true" />
              </span>
              <span className="ml-1.5 min-w-0 flex-1 truncate font-semibold opacity-[0.82]">
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
        </ContextMenuContent>
      </ContextMenu>
      {expanded && (
        <div className="folder-file-tree__items">
          {tree.loading && tree.nodes.size === 0 && (
            <div className="flex min-h-7 items-center px-2" style={{ marginLeft: TREE_EDGE_GUTTER + 20 }}>
              <ListSurfaceSpinner className="h-3.5 w-3.5" ariaLabel={t('memo.fileTree.loading')} />
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
            <button type="button" onClick={() => void confirmDelete()} className="h-8 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)] px-3 text-sm text-white hover:opacity-90">{t('memo.fileTree.delete')}</button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AgentRepositoriesSection({
  repositories,
  order,
  onHeightChange,
  sectionActions,
  onAddRepository,
  onRemoveRepository,
  onExpandRepository,
  canAddRepository,
  onOpenFile,
  onOpenFileInMainColumn,
  viewMode = 'tree',
  onOpenRepositoryList,
  hideSectionHeader = false,
  onHideSection,
}: {
  repositories: WorkspaceAgentRepository[];
  order: number;
  onHeightChange: (height: number) => void;
  sectionActions?: ReactNode;
  onAddRepository: () => void;
  onRemoveRepository: (repository: WorkspaceAgentRepository) => void;
  onExpandRepository: (element: HTMLElement) => void;
  canAddRepository: boolean;
  /** Row click: the file tree defaults documents to the Browser column. */
  onOpenFile: (path: string, scopePath: string) => void;
  /** Row menu: the Work column stays reachable. */
  onOpenFileInMainColumn: (path: string, scopePath: string) => void;
  viewMode?: 'tree' | 'links';
  onOpenRepositoryList?: () => void;
  hideSectionHeader?: boolean;
  /** Empty-state escape hatch: hide the whole section from the file tree. */
  onHideSection?: () => void;
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
      {!hideSectionHeader && (
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
            {sectionActions}
            {viewMode === 'links' && (
              <button
                type="button"
                onClick={onOpenRepositoryList}
                aria-label={t('memo.fileTree.openAllRepositories')}
                title={t('memo.fileTree.openAllRepositories')}
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
              >
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
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
      )}
      {!collapsed && viewMode === 'links' && (
        <div className="group/repository-list relative space-y-0.5">
          {repositories.length ? repositories.map((repository) => (
            <button key={repository.path} type="button" onClick={onOpenRepositoryList}
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--brand)]"
              style={{ marginLeft: TREE_EDGE_GUTTER, width: `calc(100% - ${TREE_EDGE_GUTTER * 2}px)` }}>
              <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate opacity-[0.82]">{repository.name}</span>
            </button>
          )) : (
            <TreeSectionEmptyState
              message={t('memo.fileTree.sectionEmpty')}
              hideLabel={t('memo.fileTree.sectionEmptyHide')}
              onHide={onHideSection}
              edgeGutter={TREE_EDGE_GUTTER}
            />
          )}
          {repositories.length > 0 && onOpenRepositoryList && (
            <button
              type="button"
              onClick={onOpenRepositoryList}
              aria-label={t('memo.fileTree.openAllRepositories')}
              title={t('memo.fileTree.openAllRepositories')}
              className="absolute bottom-1 z-10 mr-1 inline-flex h-6 w-6 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--document-bg)] text-[var(--muted-foreground)] opacity-0 shadow-[0_1px_4px_rgb(0_0_0_/_4.5%)] transition-[color,opacity] group-hover/repository-list:opacity-100 group-focus-within/repository-list:opacity-100 hover:text-[var(--foreground)]"
              style={{ right: TREE_EDGE_GUTTER }}
            >
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      {!collapsed && viewMode === 'tree' && (
        <>
          {repositories.length > 0 ? repositories.map((repository) => (
            <AgentRepositoryItem
              key={repository.path}
              repository={repository}
              onOpenFile={onOpenFile}
              onOpenFileInMainColumn={onOpenFileInMainColumn}
              onRemoveRepository={onRemoveRepository}
              onExpandRepository={onExpandRepository}
            />
          )) : (
            <TreeSectionEmptyState
              message={t('memo.fileTree.sectionEmpty')}
              hideLabel={t('memo.fileTree.sectionEmptyHide')}
              onHide={onHideSection}
              edgeGutter={TREE_EDGE_GUTTER}
            />
          )}
        </>
      )}
    </section>
  );
}
