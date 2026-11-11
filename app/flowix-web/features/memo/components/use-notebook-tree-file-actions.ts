import { useCallback, useMemo } from 'react';
import { canonicalPath, notebookRelativeDirectoryPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { documentIdentityFromFile, saveWorkspaceDocumentPath } from '@features/document/public/workspace-api';
import { ensureFileDisplayIdentity } from '@/lib/file-display-registry';
import { noteRepository } from '@features/memo/services/note-repository';
import { useNoteStore } from '@features/memo/store/note-store';
import type { DocTreeItem } from '@platform/tauri/client';

const logger = createLogger('notebook-file-tree');

interface UseNotebookTreeFileActionsOptions {
  notebookId?: string | null;
  notebookPath: string;
  selectedFilePaths: string[];
  itemsByPath: ReadonlyMap<string, DocTreeItem>;
  onDeleteFolder?: (folderPath: string) => Promise<void | boolean>;
  onDeleteFile?: (item: DocTreeItem, options?: { silent?: boolean }) => Promise<boolean | void>;
  updateSelection: (paths: string[], anchorPath: string | null) => void;
  updatePinnedFolders: (update: (paths: string[]) => string[] | null) => Promise<void>;
}

/** Owns file deletion and pinned-folder mutations for the notebook tree. */
export function useNotebookTreeFileActions({
  notebookId,
  notebookPath,
  selectedFilePaths,
  itemsByPath,
  onDeleteFolder,
  onDeleteFile,
  updateSelection,
  updatePinnedFolders,
}: UseNotebookTreeFileActionsOptions) {
  const { t } = useI18n();
  const canDeleteSelectedDocuments = useMemo(() => selectedFilePaths.length > 1
    && selectedFilePaths.every((path) => itemsByPath.get(canonicalPath(path))?.type === 'document'),
  [itemsByPath, selectedFilePaths]);

  const handleDeleteSelected = useCallback(async () => {
    const failedPaths: string[] = [];
    for (const path of selectedFilePaths) {
      try {
        const item = itemsByPath.get(canonicalPath(path));
        if (!item) throw new Error('Selected document is no longer loaded');
        if (item.resourceKind === 'note' || /\.(md|markdown)$/i.test(item.name)) {
          const saved = await saveWorkspaceDocumentPath(
            documentIdentityFromFile(ensureFileDisplayIdentity(path)), path, notebookPath,
          );
          if (!saved) throw new Error('Could not save selected document');
          await noteRepository.delete(path);
        } else if (!onDeleteFile || await onDeleteFile(item, { silent: true }) === false) {
          throw new Error('Could not delete selected document');
        }
      } catch (error) {
        failedPaths.push(path);
        logger.warn('batch document deletion failed', { error, path });
      }
    }

    updateSelection(failedPaths, failedPaths[0] ?? null);
    useNoteStore.getState().triggerRefresh();
    const message = t('memo.fileTree.deleteSelectedResult', {
      deleted: selectedFilePaths.length - failedPaths.length,
      failed: failedPaths.length,
    });
    if (failedPaths.length > 0) toast.error(message);
    else toast.success(message);
  }, [itemsByPath, notebookPath, onDeleteFile, selectedFilePaths, t, updateSelection]);

  const handleTogglePinnedFolder = useCallback(async (folderPath: string) => {
    if (!notebookId) return;
    const relativePath = notebookRelativeDirectoryPath(notebookPath, folderPath);
    if (relativePath === null || relativePath === '') return;
    const key = canonicalPath(relativePath);
    try {
      await updatePinnedFolders((paths) => (
        paths.some((path) => canonicalPath(path) === key)
          ? paths.filter((path) => canonicalPath(path) !== key)
          : [relativePath, ...paths]
      ));
    } catch {
      toast.error(t('memo.fileTree.pinnedFolderSaveFailed'));
    }
  }, [notebookId, notebookPath, t, updatePinnedFolders]);

  const removePinnedFolderSubtree = useCallback(async (folderPath: string) => {
    const relativePath = notebookRelativeDirectoryPath(notebookPath, folderPath);
    if (relativePath === null || relativePath === '') return;
    const key = canonicalPath(relativePath);
    try {
      await updatePinnedFolders((paths) => {
        const next = paths.filter((path) => {
          const candidate = canonicalPath(path);
          return candidate !== key && !candidate.startsWith(`${key}/`);
        });
        return next.length === paths.length ? null : next;
      });
    } catch {
      toast.error(t('memo.fileTree.pinnedFolderSaveFailed'));
    }
  }, [notebookPath, t, updatePinnedFolders]);

  const handleDeleteFolder = useCallback(async (folderPath: string) => {
    const deleted = await onDeleteFolder?.(folderPath);
    if (deleted !== false) await removePinnedFolderSubtree(folderPath);
  }, [onDeleteFolder, removePinnedFolderSubtree]);

  return {
    canDeleteSelectedDocuments,
    handleDeleteSelected,
    handleTogglePinnedFolder,
    removePinnedFolderSubtree,
    handleDeleteFolder,
  };
}
