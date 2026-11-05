'use client';

import { columnAtIndex } from '@features/workspace/public/session-api';

import { useCallback, useEffect, useRef } from 'react';

import { canonicalDirectoryPath, canonicalPath, parentDirectoryPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { normalizeNotebookMoveFailure, type NotebookMoveFailure } from './notebook-move-failure-toast';
import { resourceKindFromPath } from '@features/editor/public/code-file';
import {
  NotebookFileTree,
  type NotebookFolderCreateRequest,
  type NotebookMoveResult,
  type NotebookMoveSource,
} from '@features/memo/components/notebook-file-tree';
import { useFolderTree } from '@features/memo/components/use-folder-tree';
import { useSpaceTreeVisibility } from '@features/preferences/public/runtime-api';
import { updateNoteLinksAfterMove } from '@features/memo/services/note-link-rewriter';
import { openNotebookNote } from '@features/memo/use-cases/open-notebook-note';
import { openFolderCollectionFromFolder } from '@features/workspace/public/main-window-api';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { createFileBrowserTarget } from '@features/workspace/public/browser-column-api';
import { useColumnTarget } from '@features/workspace/public/column-navigation-api';
import { clearWorkspaceTargetsForDeletedDirectory } from '@features/workspace/public/shell-api';
import { useActiveFilePath } from '@features/workspace/public/active-file-path-api';
import {
  files,
  mediaResources,
  notes,
  type DocTreeItem,
  type FileBrowserDirectoriesChangedEvent,
} from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import { subscribeNotebookMetadata } from '../services/note-metadata-service';
import { type Notebook } from '@features/memo/store';

const FILE_BROWSER_DIRECTORIES_CHANGED_EVENT = 'file-browser-directories-changed';
const logger = createLogger('notebook-folder-view');

export function NotebookFolderView({
  notebook,
  createFolderRequest,
  onCreateFolder,
  onCreateNote,
  defaultCreateFolder,
  onSetDefaultCreateFolder,
  isActive = true,
  skipInitialLoading = false,
}: {
  notebook: Notebook;
  createFolderRequest?: NotebookFolderCreateRequest | null;
  onCreateFolder?: () => void;
  onCreateNote: (parentPath?: string, title?: string) => Promise<void> | void;
  defaultCreateFolder?: string | null;
  onSetDefaultCreateFolder?: (folderPath: string) => void;
  isActive?: boolean;
  skipInitialLoading?: boolean;
}) {
  const { t } = useI18n();
  const tree = useFolderTree(notebook.path, {
    enabled: isActive,
  });
  // 隐藏 / 系统文件夹的过滤在 Rust 侧（读全局 preference.json）完成，所以开关
  // 变化后必须重新拉整棵树。用 ref 记住「已经应用到树上的口径」：首帧只记录不
  // 重拉（树自己会加载），不可见期间也不更新，等切回可见时再补一次 reload。
  const { showHiddenFolders, showSystemFolders } = useSpaceTreeVisibility();
  const reloadTree = tree.reload;
  const visibilityKey = `${showHiddenFolders}:${showSystemFolders}`;
  const appliedVisibilityRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isActive) return;
    const applied = appliedVisibilityRef.current;
    appliedVisibilityRef.current = visibilityKey;
    if (applied === null || applied === visibilityKey) return;
    void reloadTree();
  }, [isActive, visibilityKey, reloadTree]);
  const target = useColumnTarget(0);
  // 树高亮跟随中间列（槽位），而不是 Work 会话：交换两列后 Work 可能在右侧，
  // 继续用 Work target 会高亮到用户没在看的那份文档。
  const activeFilePath = useActiveFilePath();
  const activeFileRevealRatio = target.kind === 'external' && target.treeReveal === 'created-note'
    ? 0.4 : undefined;
  const refreshDirectoriesRef = useRef(tree.refreshDirectories);
  refreshDirectoriesRef.current = tree.refreshDirectories;

  useEffect(() => subscribeNotebookMetadata({ notebookId: notebook.id, notebookPath: notebook.path }), [notebook.id, notebook.path]);

  useEffect(() => subscribe<{ notebookId: string; operationId?: string }>('file-management-changed', ({ notebookId, operationId }) => {
    if (isActive && notebookId === notebook.id && !operationId) void tree.refresh();
  }), [isActive, notebook.id, tree.refresh]);

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
          await openWorkspaceSurface({
            index: 0,
            source: 'notebook-tree',
            target: { kind: 'media', filePath, notebookId: notebook.id, notebookPath: notebook.path, resourceKind },
          });
        } else {
          await openWorkspaceSurface({
            index: 0,
            source: 'notebook-tree',
            target: { kind: 'external', path: filePath, scopePath: notebook.path, transitionId: null },
          });
        }
        return;
      }
      await openNotebookNote(filePath, notebook, {
        destination: 0,
        source: 'notebook-tree',
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
          await openWorkspaceSurface({
            index: 1,
            source: 'notebook-tree-new-tab',
            target: { kind: 'media', filePath, notebookId: notebook.id, notebookPath: notebook.path, resourceKind },
          });
        } else {
          await openWorkspaceSurface({
            index: 1,
            source: 'notebook-tree-new-tab',
            target: createFileBrowserTarget(filePath, notebook.path, notebook.path),
          });
        }
        return;
      }
      await openWorkspaceSurface({
        index: 1,
        source: 'notebook-tree-new-tab',
        target: { kind: 'external', path: filePath, scopePath: notebook.path, transitionId: null },
      });
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
      return {
        movedPaths: [],
        failedPaths: sourcePaths,
        failures: sourcePaths.map(() => ({ code: 'FILE_PERMISSION_DENIED' })),
      };
    }
    const parentRelativePath = target === root ? '' : target.slice(root.length + 1);
    const movedPaths: string[] = [];
    const failedPaths: string[] = [];
    const failures: NotebookMoveFailure[] = [];
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
          updateNoteLinksAfterMove(sourcePath, movedPath);
        }
      } catch (error) {
        logger.warn('moving notebook tree item failed', { error, sourcePath, targetDirectoryPath });
        failedPaths.push(sourcePath);
        failures.push(normalizeNotebookMoveFailure(error));
      }
    }
    return { movedPaths, failedPaths, failures };
  }, [notebook.id, notebook.path]);

  const deleteFolder = useCallback(async (folderPath: string) => {
    try {
      const ok = await files.deleteFolder(folderPath, notebook.path);
      if (!ok) throw new Error('delete failed');
      try {
        await clearWorkspaceTargetsForDeletedDirectory(folderPath);
      } catch (cleanupError) {
        logger.warn('folder deleted, but workspace targets could not be fully cleared', { cleanupError, folderPath });
        toast.error(t('memo.fileTree.deleteFolderViewCleanupFailed'));
      }
      const parent = folderPath.slice(0, folderPath.replace(/[\\/]+$/, '').lastIndexOf('/')) || notebook.path;
      await tree.refresh(parent);
      toast.success(t('status.deleteCompleted'));
      return true;
    } catch (error) {
      logger.warn('deleting notebook folder failed', { error, folderPath });
      const parent = folderPath.slice(0, folderPath.replace(/[\\/]+$/, '').lastIndexOf('/')) || notebook.path;
      await tree.refresh(parent).catch((refreshError) => logger.warn('refreshing folder after failed deletion failed', { refreshError, parent }));
      toast.error(t(String(error).includes('FOLDER_DELETE_PARTIAL') ? 'memo.fileTree.deletePartialFailed' : 'memo.fileTree.deleteFailed'));
      return false;
    }
  }, [notebook.path, t, tree.refresh]);

  const deleteFile = useCallback(async (item: DocTreeItem, options?: { silent?: boolean }) => {
    const kind = item.resourceKind ?? resourceKindFromPath(item.name);
    if (kind === 'note') return false;
    const isMedia = kind === 'image' || kind === 'video';
    const ok = isMedia
      ? await mediaResources.delete(item.fullPath, notebook.path)
      : await files.delete(item.fullPath, notebook.path);
    if (!ok) {
      if (!options?.silent) toast.error(t(isMedia ? 'media.fileTree.deleteFailed' : 'memo.fileTree.deleteFailed'));
      return false;
    }
    const parent = parentDirectoryPath(item.fullPath, notebook.path);
    // Deletion already succeeded; a refresh failure must not classify it as failed.
    await tree.refresh(parent).catch((error) => logger.warn('refreshing after file deletion failed', { error, parent }));
    if (!options?.silent) toast.success(t('status.deleteCompleted'));
    return true;
  }, [notebook.path, t, tree.refresh]);

  return (
    <>
    <NotebookFileTree
      notebookId={notebook.id}
      notebookName={notebook.name}
      notebookPath={notebook.path}
      activeFilePath={activeFilePath}
      activeFileRevealRatio={activeFileRevealRatio}
      tree={tree}
      isActive={isActive}
      skipInitialLoading={skipInitialLoading}
      contentClassName="flowix-list-content-enter"
      defaultCreateFolder={defaultCreateFolder}
      onSetDefaultCreateFolder={onSetDefaultCreateFolder}
      createFolderRequest={createFolderRequest}
      onCreateFolder={onCreateFolder}
      onNoteSelect={(filePath) => { void openFile(filePath); }}
      onFolderSelect={(folderPath) => {
        const opening = openFolderCollectionFromFolder(notebook.id, folderPath, columnAtIndex(0));
        void opening.catch((error) => {
          logger.warn('opening folder collection failed', { folderPath, error });
          toast.error(error instanceof Error ? error.message : '无法打开文件夹集合');
        });
      }}
      onNoteOpenInNewTab={(filePath) => { void openFileInNewTab(filePath); }}
      onCreateNote={onCreateNote}
      onMoveNote={moveItem}
      onDeleteFolder={deleteFolder}
      onDeleteFile={deleteFile}
    />
  </>
  );
}
