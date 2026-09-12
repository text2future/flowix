'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';

import { canonicalPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { useDocumentStore } from '@features/document/store';
import { isMarkdownFilePath } from '@features/editor/code-file';
import {
  NotebookFileTree,
  type NotebookFolderCreateRequest,
  type NotebookNoteCreateRequest,
} from '@features/memo/components/notebook-file-tree';
import { useFolderTree } from '@features/memo/components/use-folder-tree';
import { openNoteByTarget, resolveMemoByPath } from '@features/memo/use-cases/open-by-target';
import { openBrowserColumnFileBrowser, openBrowserColumnMemoById } from '@features/workspace/use-cases/browser-column-navigation';
import { openExternalTarget } from '@features/workspace/use-cases/workspace-navigation';
import { files, memos, type DocTreeItem, type FileBrowserDirectoriesChangedEvent } from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import type { Notebook } from '@features/memo/store';
import type { SortType } from '@features/memo/services';

const FILE_BROWSER_DIRECTORIES_CHANGED_EVENT = 'file-browser-directories-changed';
const logger = createLogger('notebook-folder-view');

function canonicalDirectoryPath(path: string): string {
  return canonicalPath(path).replace(/\/+$/, '') || '/';
}

export function isNotebookTreeItemVisible(item: DocTreeItem): boolean {
  if (item.type === 'folder') {
    return !['attachment', 'attachments'].includes(item.name.toLowerCase());
  }
  return isMarkdownFilePath(item.name);
}

function memoPath(notebookPath: string, memo: { filename: string; relativePath?: string }): string {
  const relative = memo.relativePath?.trim() || memo.filename;
  return canonicalPath(`${notebookPath.replace(/[\\/]+$/, '')}/${relative.replace(/^[/\\]+/, '')}`);
}

export function filterNotebookTreeItems(
  items: DocTreeItem[],
  visibleMemoPaths: Set<string> | null,
): DocTreeItem[] {
  if (!visibleMemoPaths) return items;
  return items.filter((item) => (
    item.type === 'folder' || visibleMemoPaths.has(canonicalPath(item.fullPath))
  ));
}

export function sortNotebookTreeItems(items: DocTreeItem[], sort: SortType): DocTreeItem[] {
  const timestamp = (item: DocTreeItem) => (
    sort === 'updatedAt' ? item.modifiedMs : item.createdMs
  ) ?? 0;
  return [...items].sort((left, right) => {
    if (left.type !== right.type) return left.type === 'folder' ? -1 : 1;
    if (left.type === 'folder') return left.name.localeCompare(right.name);
    if (sort === 'filenameAsc' || sort === 'filenameDesc') {
      const filenameOrder = left.name.toLowerCase().localeCompare(right.name.toLowerCase())
        || left.name.localeCompare(right.name);
      return sort === 'filenameDesc' ? -filenameOrder : filenameOrder;
    }
    return timestamp(right) - timestamp(left) || left.name.localeCompare(right.name);
  });
}

export function NotebookFolderView({
  notebook,
  createFolderRequest,
  createNoteRequest,
  onCreateFolder,
  sort,
  onCreateNote,
  visibleMemos,
  isActive = true,
}: {
  notebook: Notebook;
  createFolderRequest?: NotebookFolderCreateRequest | null;
  createNoteRequest?: NotebookNoteCreateRequest | null;
  onCreateFolder?: () => void;
  sort: SortType;
  onCreateNote?: (parentPath: string, title: string) => Promise<void> | void;
  visibleMemos?: Array<{ filename: string; relativePath?: string }> | null;
  isActive?: boolean;
}) {
  const { t } = useI18n();
  const tree = useFolderTree(notebook.path);
  const visibleMemoPaths = useMemo(() => {
    if (!isActive || visibleMemos == null) return null;
    return new Set(visibleMemos.map((memo) => memoPath(notebook.path, memo)));
  }, [isActive, notebook.path, visibleMemos]);
  const noteTree = useMemo(() => {
    if (!isActive) return tree;
    return {
      ...tree,
      rootChildren: sortNotebookTreeItems(
        filterNotebookTreeItems(tree.rootChildren.filter(isNotebookTreeItemVisible), visibleMemoPaths),
        sort,
      ),
      nodes: new Map([...tree.nodes].map(([path, item]) => [
        path,
        item.children
          ? {
              ...item,
              children: sortNotebookTreeItems(
                filterNotebookTreeItems(item.children.filter(isNotebookTreeItemVisible), visibleMemoPaths),
                sort,
              ),
            }
          : item,
      ])),
    };
  }, [
    isActive,
    sort,
    visibleMemoPaths,
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
  const currentDocumentPath = useDocumentStore((state) => state.currentDocumentPath);
  const refreshDirectoriesRef = useRef(tree.refreshDirectories);
  refreshDirectoriesRef.current = tree.refreshDirectories;

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
    try {
      const memo = await resolveMemoByPath(filePath);
      if (memo?.notebookId === notebook.id) {
        await openNoteByTarget(memo);
        return;
      }
      await openExternalTarget(filePath, {
        scopePath: notebook.path,
        destination: 'main-third',
      });
    } catch (error) {
      logger.warn('opening notebook tree file failed', { error, filePath });
      toast.error(t('memo.fileTree.openFailed'));
    }
  }, [notebook.id, notebook.path, t]);

  const openFileInNewTab = useCallback(async (filePath: string) => {
    try {
      const memo = await resolveMemoByPath(filePath);
      if (memo?.notebookId === notebook.id) {
        await openBrowserColumnMemoById(memo.memoId);
        return;
      }
      await openBrowserColumnFileBrowser(notebook.path, filePath);
    } catch (error) {
      logger.warn('opening notebook tree file in new tab failed', { error, filePath });
      toast.error(t('memo.fileTree.openFailed'));
    }
  }, [notebook.id, notebook.path, t]);

  const moveNote = useCallback(async (sourcePath: string, targetDirectoryPath: string) => {
    const memo = await resolveMemoByPath(sourcePath);
    if (!memo || memo.notebookId !== notebook.id) {
      throw new Error('selected file is not an indexed note in this notebook');
    }
    const root = canonicalDirectoryPath(notebook.path);
    const target = canonicalDirectoryPath(targetDirectoryPath);
    if (target !== root && !target.startsWith(`${root}/`)) {
      throw new Error('destination is outside the notebook');
    }
    const parentRelativePath = target === root ? '' : target.slice(root.length + 1);
    const moved = await memos.moveMemoToDirectory(
      memo.memoId,
      notebook.id,
      parentRelativePath,
    );
    useDocumentStore.getState().replaceActiveMemoPath(moved.memo.id, moved.path);
  }, [notebook.id, notebook.path]);

  const deleteFolder = useCallback(async (folderPath: string) => {
    const ok = await files.deleteFolder(folderPath, notebook.path);
    if (!ok) {
      toast.error(t('memo.fileTree.deleteFailed'));
      return;
    }
    const parent = folderPath.slice(0, folderPath.replace(/[\\/]+$/, '').lastIndexOf('/')) || notebook.path;
    await tree.refresh(parent);
    toast.success(t('memo.fileTree.deleted', { name: folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? folderPath }));
  }, [notebook.path, t, tree.refresh]);

  // MemoList remains mounted while the middle column shows conversations.
  // Avoid retaining a large hidden tree in the DOM while it is inactive.
  if (!isActive) return null;

  return (
    <NotebookFileTree
      notebookName={notebook.name}
      notebookPath={notebook.path}
      activeFilePath={currentDocumentPath}
      tree={noteTree}
      createFolderRequest={createFolderRequest}
      createNoteRequest={createNoteRequest}
      onCreateFolder={onCreateFolder}
      onNoteSelect={(filePath) => { void openFile(filePath); }}
      onNoteOpenInNewTab={(filePath) => { void openFileInNewTab(filePath); }}
      onCreateNote={(parentPath, title) => onCreateNote?.(parentPath, title)}
      onMoveNote={moveNote}
      onDeleteFolder={deleteFolder}
    />
  );
}
