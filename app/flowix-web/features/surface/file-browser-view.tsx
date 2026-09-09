import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { ChevronRight, Trash2 } from 'lucide-react';
import { CaretDownIcon, DotsThreeIcon, FolderSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import { DocumentContainer } from '@features/document/components/document-container';
import { FolderFileTree } from '@features/memo/components/folder-file-tree';
import { useFolderTree } from '@features/memo/components/use-folder-tree';
import { useMemoStore } from '@features/memo/store';
import type { FileBrowserContext } from '@features/workspace/store/file-browser-target';
import { useAgentAccessStore } from '@features/agent/store/agent-access-store';
import { resolveNotebookAgentFiles } from '@/lib/agent-access-defaults';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { openPath } from '@platform/tauri/opener';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@shared/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { resolveFileBrowserBreadcrumbItems, type FileBrowserBreadcrumbItem } from './file-browser-breadcrumb';
import { files, type FileBrowserDirectoriesChangedEvent } from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import { canonicalPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';
import { resolveFileBrowserRoot, type FileBrowserTarget } from '@features/workspace/store/file-browser-target';

const FILE_BROWSER_DIRECTORIES_CHANGED_EVENT = 'file-browser-directories-changed';
const fileBrowserLogger = createLogger('file-browser-watch');
function canonicalDirectoryPath(path: string): string {
  return canonicalPath(path).replace(/\/+$/, '') || '/';
}

export interface FileBrowserViewSurface extends FileBrowserTarget {
  documentProps: ComponentProps<typeof DocumentContainer>;
  onSelectFile: (path: string) => void;
  onSelectFolder?: (path: string) => void;
  onOpenFileInNewTab: (path: string) => void;
  onContextChange: (patch: Partial<FileBrowserContext>) => void;
  onTreeVisibleChange: (visible: boolean) => void;
  onTreeWidthChange: (width: number) => void;
}

function BrowserBreadcrumbFolderTree({
  folderPath,
  folderName,
  activeFilePath,
  onFileSelect,
  onFileOpenInNewTab,
}: {
  folderPath: string;
  folderName: string;
  activeFilePath: string | null;
  onFileSelect: (filePath: string) => void;
  onFileOpenInNewTab: (filePath: string) => void;
}) {
  const tree = useFolderTree(folderPath);

  return (
    <div className="w-[min(236px,calc(100vw-2rem))] overflow-hidden rounded-[inherit]">
      <FolderFileTree
        folderPath={folderPath}
        folderName={folderName}
        activeFilePath={activeFilePath}
        expandToActiveFile={false}
        layout="content"
        treeViewportClassName="max-h-[min(376px,calc(100vh-7rem))]"
        tree={tree}
        onFileSelect={onFileSelect}
        onFileOpenInNewTab={onFileOpenInNewTab}
      />
    </div>
  );
}

function BrowserBreadcrumbFolderPopover({
  item,
  activeFilePath,
  onFileSelect,
  onFileOpenInNewTab,
}: {
  item: FileBrowserBreadcrumbItem;
  activeFilePath: string | null;
  onFileSelect: (filePath: string) => void;
  onFileOpenInNewTab: (filePath: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`打开文件夹 ${item.label}`}
          aria-expanded={open}
          title={item.path}
          className="max-w-[180px] truncate rounded px-1 text-left transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--muted)] data-[state=open]:text-[var(--foreground)]"
        >
          {item.label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        className="w-auto overflow-hidden rounded-xl p-0 shadow-[0_8px_30px_-5px_rgb(0_0_0_/_0.28)]"
      >
        {open && (
          <BrowserBreadcrumbFolderTree
            folderPath={item.path}
            folderName={item.label}
            activeFilePath={activeFilePath}
            onFileOpenInNewTab={onFileOpenInNewTab}
            onFileSelect={(filePath) => {
              setOpen(false);
              onFileSelect(filePath);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

export function FileBrowserView({ surface: input }: { surface: FileBrowserViewSurface }) {
  const { t } = useI18n();
  const config = useAgentAccessStore((state) => state.config);
  const notebookConfigs = useAgentAccessStore((state) => state.notebookConfigs);
  const addFolderFromPicker = useAgentAccessStore((state) => state.addFolderFromPicker);
  const setDefaultFiles = useAgentAccessStore((state) => state.setDefaultFiles);
  const selectedNotebookId = useMemoStore((state) => state.selectedNotebookId ?? state.selectedNotebook?.id ?? null);
  const legacyNotebookRef = useRef<string | null>(null);
  if (input.restoreNotebookContext && !legacyNotebookRef.current && selectedNotebookId) {
    legacyNotebookRef.current = selectedNotebookId;
  }
  const notebookId = input.restoreNotebookContext ? legacyNotebookRef.current : input.notebookId;
  useEffect(() => {
    if (input.restoreNotebookContext && notebookId) {
      input.onContextChange({ notebookId, restoreNotebookContext: false });
    }
  }, [input.restoreNotebookContext, input.onContextChange, notebookId]);
  const defaultFiles = resolveNotebookAgentFiles(config, notebookConfigs, notebookId);
  const root = input.activeFilePath
    ? resolveFileBrowserRoot(input.activeFilePath, defaultFiles?.folders ?? [])
    : input.folderPath;
  const surface = { ...input, folderPath: root ?? '' };
  const breadcrumbs = root ? resolveFileBrowserBreadcrumbItems(root, input.activeFilePath) : [];
  const currentPath = input.activeFilePath ?? input.folderPath ?? '';
  const folderItems = (defaultFiles?.folders ?? []).map((path) => {
    const entry = config.entries.find(
      (candidate) => candidate.kind === 'folder'
        && candidate.path.trim().replace(/[\\/]+$/, '').toLowerCase()
          === path.trim().replace(/[\\/]+$/, '').toLowerCase(),
    );
    const trimmed = path.replace(/[\\/]+$/, '');
    return {
      path,
      name: entry?.name ?? trimmed.split(/[\\/]/).pop() ?? trimmed,
      missing: entry?.missing ?? true,
    };
  });

  const handleRemoveFolder = useCallback(async (path: string) => {
    if (!notebookId) return;
    const latestConfig = useAgentAccessStore.getState().config;
    const latestFiles = resolveNotebookAgentFiles(
      latestConfig,
      useAgentAccessStore.getState().notebookConfigs,
      notebookId,
    );
    const latestFolders = latestFiles?.folders ?? [];
    const comparable = (value: string) => value.trim().replace(/[\\/]+$/, '').toLowerCase();
    const nextFolders = latestFolders.filter((candidate) => comparable(candidate) !== comparable(path));
    const saved = await setDefaultFiles(notebookId, {
      folders: nextFolders,
      notebooks: latestFiles?.notebooks ?? [],
    });
    if (!saved) {
      toast.error(t('agent.access.saveFailed'));
      return;
    }
    const item = folderItems.find((candidate) => comparable(candidate.path) === comparable(path));
    toast.success(t('agent.access.folderDeleted', { name: item?.name ?? path }));
  }, [folderItems, notebookId, setDefaultFiles, t]);

  const handleAddFolder = useCallback(async () => {
    const result = await addFolderFromPicker();
    if (!result.ok) {
      if (result.code === 'already-tracked') {
        toast.error(t('agent.access.alreadyTracked'));
      } else if (result.code === 'save-failed') {
        toast.error(t('agent.access.saveFailed'));
      }
      return;
    }
    if (!notebookId) return;

    const latestConfig = useAgentAccessStore.getState().config;
    const latestFiles = resolveNotebookAgentFiles(
      latestConfig,
      useAgentAccessStore.getState().notebookConfigs,
      notebookId,
    );
    if (
      (latestFiles?.folders ?? []).some(
        (path) => path.trim().replace(/[\\/]+$/, '').toLowerCase()
          === result.entry.path.trim().replace(/[\\/]+$/, '').toLowerCase(),
      )
    ) {
      toast.info(t('agent.access.folderExists'));
      return;
    }
    const nextFolders = Array.from(new Set([...(latestFiles?.folders ?? []), result.entry.path]));
    const saved = await setDefaultFiles(notebookId, {
      folders: nextFolders,
      notebooks: latestFiles?.notebooks ?? [],
    });
    if (!saved) toast.error(t('agent.access.saveFailed'));
  }, [addFolderFromPicker, notebookId, setDefaultFiles, t]);

  const handleCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(currentPath);
      toast.success(t('memo.fileTree.pathCopied'));
    } catch {
      toast.error(t('memo.fileTree.copyFailed'));
    }
  }, [currentPath, t]);

  const handleOpenWithDefaultApp = useCallback(() => {
    void openPath(currentPath).catch(() => {
      toast.error(t('memo.fileTree.openFailed'));
    });
  }, [currentPath, t]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      {root && <nav
        aria-label="文件路径"
        className="flex h-9 min-w-0 shrink-0 items-center gap-1 border-b border-[color-mix(in_oklch,var(--border)_68%,transparent)] px-2.5 text-xs text-[var(--muted-foreground)]"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {breadcrumbs.map((item, index) => (
            <span key={`${item.path}-${index}`} className="flex min-w-0 shrink-0 items-center gap-1">
              {index > 0 && <ChevronRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />}
              {item.type === 'folder' ? (
                <BrowserBreadcrumbFolderPopover
                  item={item}
                  activeFilePath={surface.activeFilePath}
                  onFileOpenInNewTab={surface.onOpenFileInNewTab}
                  onFileSelect={(filePath) => surface.onSelectFile(filePath)}
                />
              ) : (
                <span
                  className="max-w-[220px] truncate text-[var(--foreground)]"
                  title={item.label}
                >
                  {item.label}
                </span>
              )}
            </span>
          ))}
        </div>
        {surface.onSelectFolder && <DropdownMenu className="shrink-0">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('memo.fileTree.sourceMenu')}
              title={t('memo.fileTree.sourceMenu')}
              className="flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1 text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] data-[state=open]:bg-[var(--muted)]"
            >
              <span>{t('memo.navigation.files')}</span>
              <CaretDownIcon size={10} weight="bold" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="bottom"
            className="min-w-[220px] rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
          >
            {folderItems.map((item) => (
              <DropdownMenuItem
                key={item.path}
                title={item.missing ? t('agent.access.pathMissing') : item.path}
                onClick={() => {
                  if (!item.missing) surface.onSelectFolder?.(item.path);
                }}
                onTrailingAction={() => void handleRemoveFolder(item.path)}
                trailingAction={<Trash2 className="h-3 w-3" aria-hidden="true" />}
                trailingActionLabel={t('agent.access.deleteFolder')}
                className={`group h-7 gap-2 rounded-lg px-2 py-0 text-left text-sm hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)] ${item.missing ? 'text-[var(--muted-foreground)]' : ''}`}
              >
                <FolderSimpleIcon size={15} weight={item.missing ? 'regular' : 'fill'} aria-hidden="true" />
                <span className="min-w-0 truncate">{item.name}</span>
              </DropdownMenuItem>
            ))}
            {folderItems.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onClick={() => void handleAddFolder()}
              className="h-7 gap-2 rounded-lg px-2 py-0 text-left text-sm text-[var(--muted-foreground)] hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
            >
              <PlusIcon size={15} weight="regular" aria-hidden="true" />
              {t('memo.fileTree.addFolder')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>}
        <DropdownMenu className="shrink-0">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('memo.fileTree.moreActions')}
              title={t('memo.fileTree.moreActions')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--muted)] data-[state=open]:text-[var(--foreground)]"
            >
              <DotsThreeIcon size={16} weight="bold" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            side="bottom"
            className="min-w-[160px] rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
          >
            <DropdownMenuItem
              onClick={() => void handleCopyPath()}
              className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left text-sm hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
            >
              {t('memo.fileTree.copyPath')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={handleOpenWithDefaultApp}
              className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left text-sm hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
            >
              {t('memo.fileTree.openDefaultApp')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          aria-label={surface.fileTreeVisible ? '关闭文件树' : '展开文件树'}
          title={surface.fileTreeVisible ? '关闭文件树' : '展开文件树'}
          aria-pressed={surface.fileTreeVisible}
          onClick={() => surface.onTreeVisibleChange(!surface.fileTreeVisible)}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${surface.fileTreeVisible
            ? 'bg-[var(--muted)] text-[var(--foreground)]'
            : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]'}`}
        >
          <FolderSimpleIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </nav>}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div className="min-w-0 flex-1">
          {surface.activeFilePath ? (
            <DocumentContainer
              {...surface.documentProps}
              filePath={surface.activeFilePath}
              externalScopePath={surface.scopePath}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-8 text-center text-sm text-[var(--muted-foreground)]">
              从右侧文件树选择文件
            </div>
          )}
        </div>
        {root && <BrowserFileBrowserTreePane
          surface={surface}
          onRequestClose={() => surface.onTreeVisibleChange(false)}
          onFileOpenInNewTab={surface.onOpenFileInNewTab}
          onFileSelect={(filePath) => surface.onSelectFile(filePath)}
        />}
      </div>
    </div>
  );
}

/**
 * Own the tree state separately from the document surface. Directory events
 * can then update a visible tree without rerendering the open document.
 * The component stays mounted while the panel is hidden, so its active-tab
 * watcher and lazy-tree cache survive the toolbar toggle.
 */
function BrowserFileBrowserTreePane({
  surface,
  onRequestClose,
  onFileSelect,
  onFileOpenInNewTab,
}: {
  surface: FileBrowserViewSurface & { folderPath: string };
  onRequestClose: () => void;
  onFileSelect: (filePath: string) => void;
  onFileOpenInNewTab: (filePath: string) => void;
}) {
  const setTreeWidth = surface.onTreeWidthChange;
  const tree = useFolderTree(surface.folderPath);
  const refreshDirectoriesRef = useRef(tree.refreshDirectories);
  refreshDirectoriesRef.current = tree.refreshDirectories;
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef({ x: 0, width: surface.fileTreeWidth });

  // BrowserColumn only mounts the active surface. Keep this lease at the
  // surface level so switching tabs stops the recursive watcher even when the
  // file-tree panel itself is currently closed.
  useEffect(() => {
    let disposed = false;
    let leaseId: string | null = null;
    const rootPath = canonicalDirectoryPath(surface.folderPath);
    const unlisten = subscribe<FileBrowserDirectoriesChangedEvent>(
      FILE_BROWSER_DIRECTORIES_CHANGED_EVENT,
      (payload) => {
        if (disposed || canonicalDirectoryPath(payload.rootPath) !== rootPath) return;
        if (leaseId && payload.leaseId !== leaseId) return;
        void refreshDirectoriesRef.current(payload.directories);
      },
    );

    void files.watchRoot(surface.folderPath)
      .then((nextLeaseId) => {
        if (disposed) {
          void files.unwatchRoot(nextLeaseId).catch((error) => {
            fileBrowserLogger.warn('releasing late directory watcher failed', { error });
          });
          return;
        }
        leaseId = nextLeaseId;
      })
      .catch((error) => {
        if (!disposed) {
          fileBrowserLogger.warn('registering directory watcher failed', {
            folderPath: surface.folderPath,
            error,
          });
        }
      });

    return () => {
      disposed = true;
      unlisten();
      if (leaseId) {
        void files.unwatchRoot(leaseId).catch((error) => {
          fileBrowserLogger.warn('releasing directory watcher failed', { error });
        });
      }
    };
  }, [surface.folderPath]);

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (event: PointerEvent) => {
      setTreeWidth(resizeStartRef.current.width + resizeStartRef.current.x - event.clientX);
    };
    const stop = () => setIsResizing(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [isResizing, setTreeWidth]);

  if (!surface.fileTreeVisible) return null;

  return (
    <div
      className="relative shrink-0 border-l border-[color-mix(in_oklch,var(--border)_68%,transparent)]"
      style={{ width: surface.fileTreeWidth }}
    >
      <div
        role="separator"
        aria-label="调整文件树宽度"
        aria-orientation="vertical"
        onPointerDown={(event) => {
          event.preventDefault();
          resizeStartRef.current = { x: event.clientX, width: surface.fileTreeWidth };
          setIsResizing(true);
        }}
        className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize"
      />
      <FolderFileTree
        folderPath={surface.folderPath}
        folderName={surface.folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? surface.folderPath}
        embedded
        activeFilePath={surface.activeFilePath}
        tree={tree}
        onRequestClose={onRequestClose}
        onFileOpenInNewTab={onFileOpenInNewTab}
        onFileSelect={(filePath) => onFileSelect(filePath)}
      />
    </div>
  );
}
