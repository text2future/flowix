'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';

import { canonicalDirectoryPath, canonicalPath, parentDirectoryPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { resourceKindFromPath } from '@features/editor/public/code-file';
import {
  NotebookFileTree,
  type NotebookFolderCreateRequest,
  type NotebookNoteCreateRequest,
  type NotebookMoveResult,
  type NotebookMoveSource,
} from '@features/memo/components/notebook-file-tree';
import { useFolderTree } from '@features/memo/components/use-folder-tree';
import { updateNoteLinksAfterMove } from '@features/memo/services/note-link-rewriter';
import { openNotebookNote } from '@features/memo/use-cases/open-notebook-note';
import {
  openBrowserColumnFileBrowser,
  openBrowserColumnMedia,
  openBrowserColumnText,
} from '@features/workspace/use-cases/browser-column-navigation';
import {
  openExternalTarget,
  openMediaTarget,
  openDocumentListTarget,
} from '@features/workspace/use-cases/workspace-navigation';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { createDocumentListTarget, workColumnTargetFilePath } from '@features/workspace/store/work-column-target';
import {
  files,
  mediaResources,
  notes,
  type DocTreeItem,
  type FileBrowserDirectoriesChangedEvent,
} from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import { type Notebook } from '@features/memo/store';

const FILE_BROWSER_DIRECTORIES_CHANGED_EVENT = 'file-browser-directories-changed';
const logger = createLogger('notebook-folder-view');

export function sortNotebookTreeItems(items: DocTreeItem[]): DocTreeItem[] {
  const timestamp = (item: DocTreeItem) => item.memoCreatedMs ?? item.createdMs ?? 0;
  return [...items].sort((left, right) => {
    if (left.type !== right.type) return left.type === 'folder' ? -1 : 1;
    if (left.type === 'folder') return left.name.localeCompare(right.name);
    return timestamp(right) - timestamp(left) || left.name.localeCompare(right.name);
  });
}

export function NotebookFolderView({
  notebook,
  createFolderRequest,
  createNoteRequest,
  onCreateFolder,
  onCreateNote,
  defaultCreateFolder,
  onSetDefaultCreateFolder,
  isActive = true,
}: {
  notebook: Notebook;
  createFolderRequest?: NotebookFolderCreateRequest | null;
  createNoteRequest?: NotebookNoteCreateRequest | null;
  onCreateFolder?: () => void;
  onCreateNote?: (parentPath: string, title: string) => Promise<void> | void;
  defaultCreateFolder?: string | null;
  onSetDefaultCreateFolder?: (folderPath: string) => void;
  isActive?: boolean;
}) {
  const { t } = useI18n();
  const tree = useFolderTree(notebook.path, {
    enabled: isActive,
  });
  const noteTree = useMemo(() => {
    if (!isActive) return tree;
    return {
      ...tree,
      rootChildren: sortNotebookTreeItems(tree.rootChildren),
      nodes: new Map([...tree.nodes].map(([path, item]) => [
        path,
        item.children
          ? {
              ...item,
                children: sortNotebookTreeItems(item.children),
            }
          : item,
      ])),
    };
  }, [
    isActive,
    notebook.path,
    tree.rootChildren,
    tree.nodes,
    tree.expanded,
    tree.loading,
    tree.error,
    tree.toggle,
    tree.expandTo,
    tree.collapseAll,
    tree.refresh,
    tree.refreshDirectories,
    tree.reload,
  ]);
  const activeFilePath = useWorkColumnStore((state) => (
    workColumnTargetFilePath(state.navigation.target)
  ));
  const refreshDirectoriesRef = useRef(tree.refreshDirectories);
  refreshDirectoriesRef.current = tree.refreshDirectories;

  useEffect(() => subscribe<{ notebookId: string }>('file-management-changed', ({ notebookId }) => {
    if (isActive && notebookId === notebook.id) void tree.reload();
  }), [isActive, notebook.id, tree.reload]);

  useEffect(() => subscribe<{ notebookPath: string; treeVisibilityChanged: boolean }>(
    'notebook-view-preferences-changed',
    ({ notebookPath, treeVisibilityChanged }) => {
      if (isActive && treeVisibilityChanged && canonicalDirectoryPath(notebookPath) === canonicalDirectoryPath(notebook.path)) {
        void tree.reload();
      }
    },
  ), [isActive, notebook.path, tree.reload]);

  useEffect(() => {
    if (!isActive) return;
    let disposed = false;
    let leaseId: string | null = null;
    const rootPath = canonicalDirectoryPath(notebook.path);
    const unlisten = subscribe<FileBrowserDirectoriesChangedEvent>(
      FILE_BROWSER_DIRECTORIES_CHANGED_EVENT,
      (payload) => {
        if (disposed || canonicalDirectoryPath(payload.rootPath) !== rootPath) return;
        if (leaseId && payload.leaseId !== leaseId) return;
        if (tree.ignoreCollectionPathEvents(payload.paths)) return;
        void refreshDirectoriesRef.current(payload.directories);
      },
    );

    void files.watchRoot(notebook.path)
      .then((nextLeaseId) => {
        if (disposed) {
          void files.unwatchRoot(nextLeaseId).catch(() => undefined);
          return;
        }
        leaseId = nextLeaseId;
      })
      .catch((error) => {
        if (!disposed) logger.warn('registering notebook tree watcher failed', { error });
      });

    return () => {
      disposed = true;
      unlisten();
      if (leaseId) void files.unwatchRoot(leaseId).catch(() => undefined);
    };
  }, [isActive, notebook.path]);

  const openFile = useCallback(async (filePath: string) => {
    const startedAt = performance.now();
    try {
      if (resourceKindFromPath(filePath) !== 'note') {
        const resourceKind = resourceKindFromPath(filePath);
        if (resourceKind === 'image' || resourceKind === 'video') {
          await openMediaTarget({
            filePath,
            notebookId: notebook.id,
            notebookPath: notebook.path,
            resourceKind,
          });
        } else {
          await openExternalTarget(filePath, {
            scopePath: notebook.path,
            destination: 'main-third',
          });
        }
        return;
      }
      await openNotebookNote(filePath, notebook, {
        destination: 'main-third',
      });
      console.info('[perf:file-tree-open] path opened', { elapsedMs: performance.now() - startedAt });
    } catch (error) {
      logger.warn('opening notebook tree file failed', { error, filePath });
      toast.error(t('memo.fileTree.openFailed'));
    }
  }, [notebook, t, tree.nodes]);

  const openFileInNewTab = useCallback(async (filePath: string) => {
    try {
      if (resourceKindFromPath(filePath) !== 'note') {
        const resourceKind = resourceKindFromPath(filePath);
        if (resourceKind === 'image' || resourceKind === 'video') {
          await openBrowserColumnMedia(filePath, notebook.id, notebook.path, resourceKind);
        } else {
          await openBrowserColumnFileBrowser(notebook.path, filePath);
        }
        return;
      }
      await openBrowserColumnText(filePath, notebook.path);
    } catch (error) {
      logger.warn('opening notebook tree file in new tab failed', { error, filePath });
      toast.error(t('memo.fileTree.openFailed'));
    }
  }, [notebook.id, notebook.path, t]);

  const moveItem = useCallback(async (sources: NotebookMoveSource[], targetDirectoryPath: string): Promise<NotebookMoveResult> => {
    const sourcePaths = sources.map((source) => source.path);
    const root = canonicalDirectoryPath(notebook.path);
    const target = canonicalDirectoryPath(targetDirectoryPath);
    if (target !== root && !target.startsWith(`${root}/`)) {
      return { movedPaths: [], failedPaths: sourcePaths };
    }
    const parentRelativePath = target === root ? '' : target.slice(root.length + 1);
    const movedPaths: string[] = [];
    const failedPaths: string[] = [];
    for (const source of sources) {
      const sourcePath = source.path;
      try {
        const canonicalSourcePath = canonicalPath(sourcePath);
        const sourceInNotebook = canonicalSourcePath === root
          || canonicalSourcePath.startsWith(`${root}/`);
        if (!sourceInNotebook) {
          const importedPath = await files.importFile(sourcePath, target, notebook.path);
          movedPaths.push(importedPath);
          continue;
        }
        if (source.isFolder) {
          const movedPath = await files.moveFolder(sourcePath, target, notebook.path);
          movedPaths.push(movedPath);
          updateNoteLinksAfterMove(sourcePath, movedPath, true);
          continue;
        }
        const isMarkdownNote = source.resourceKind === 'note'
          || /\.(md|markdown)$/i.test(sourcePath);
        if (isMarkdownNote) {
          const moved = await notes.moveToDirectory(
            sourcePath,
            notebook.id,
            parentRelativePath,
          );
          movedPaths.push(moved.path);
          if (moved.path !== sourcePath) updateNoteLinksAfterMove(sourcePath, moved.path);
        } else {
          const movedPath = await files.move(sourcePath, target, notebook.path);
          movedPaths.push(movedPath);
        }
      } catch (error) {
        logger.warn('moving notebook tree item failed', { error, sourcePath, targetDirectoryPath });
        failedPaths.push(sourcePath);
      }
    }
    return { movedPaths, failedPaths };
  }, [notebook.id, notebook.path]);

  const deleteFolder = useCallback(async (folderPath: string) => {
    try {
      const ok = await files.deleteFolder(folderPath, notebook.path);
      if (!ok) throw new Error('delete failed');
      const parent = folderPath.slice(0, folderPath.replace(/[\\/]+$/, '').lastIndexOf('/')) || notebook.path;
      await tree.refresh(parent);
      toast.success(t('memo.fileTree.deleted', { name: folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? folderPath }));
    } catch (error) {
      logger.warn('deleting notebook folder failed', { error, folderPath });
      const parent = folderPath.slice(0, folderPath.replace(/[\\/]+$/, '').lastIndexOf('/')) || notebook.path;
      await tree.refresh(parent).catch((refreshError) => logger.warn('refreshing folder after failed deletion failed', { refreshError, parent }));
      toast.error(t(String(error).includes('FOLDER_DELETE_PARTIAL') ? 'memo.fileTree.deletePartialFailed' : 'memo.fileTree.deleteFailed'));
    }
  }, [notebook.path, t, tree.refresh]);

  const deleteFile = useCallback(async (item: DocTreeItem) => {
    const kind = item.resourceKind ?? resourceKindFromPath(item.name);
    if (kind === 'note') return;
    const isMedia = kind === 'image' || kind === 'video';
    const ok = isMedia
      ? await mediaResources.delete(item.fullPath, notebook.path)
      : await files.delete(item.fullPath, notebook.path);
    if (!ok) {
      toast.error(t(isMedia ? 'media.fileTree.deleteFailed' : 'memo.fileTree.deleteFailed'));
      return;
    }
    const parent = parentDirectoryPath(item.fullPath, notebook.path);
    await tree.refresh(parent);
    toast.success(t(isMedia ? 'media.fileTree.deleted' : 'memo.fileTree.deleted', { name: item.name }));
  }, [notebook.path, t, tree.refresh]);

  return (
    <NotebookFileTree
      notebookId={notebook.id}
      notebookName={notebook.name}
      notebookPath={notebook.path}
      activeFilePath={activeFilePath}
      tree={noteTree}
      isActive={isActive}
      defaultCreateFolder={defaultCreateFolder}
      onSetDefaultCreateFolder={onSetDefaultCreateFolder}
      createFolderRequest={createFolderRequest}
      createNoteRequest={createNoteRequest}
      onCreateFolder={onCreateFolder}
      onNoteSelect={(filePath) => { void openFile(filePath); }}
      onFolderSelect={(folderPath) => {
        const target = createDocumentListTarget(
          { kind: 'folder', path: folderPath, notebookPath: notebook.path, notebookId: notebook.id },
          {},
        );
        openDocumentListTarget(target);
      }}
      onNoteOpenInNewTab={(filePath) => { void openFileInNewTab(filePath); }}
      onCreateNote={(parentPath, title) => onCreateNote?.(parentPath, title)}
      onMoveNote={moveItem}
      onDeleteFolder={deleteFolder}
      onDeleteFile={deleteFile}
    />
  );
}
