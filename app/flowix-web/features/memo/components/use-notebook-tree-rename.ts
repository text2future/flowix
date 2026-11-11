import { useCallback } from 'react';
import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';
import { displayTitleFromFilename, isMediaLibraryFilename, isTableDocumentFilename, mediaLibraryExtension, tableDocumentExtension } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { ensureFileDisplayIdentity } from '@/lib/file-display-registry';
import { updateNoteLinksAfterMove } from '@features/memo/services/note-link-rewriter';
import { replaceExternalDocumentPath } from '@features/workspace/public/note-navigation-api';
import { renameMarkdownTitle } from '@features/document/public/file-operations-api';
import { renameWorkspaceFile } from '@features/workspace/public/shell-api';
import { resourceKindFromPath } from '@features/editor/code-file';
import { fileTreeRenameFailureKey } from './file-tree-failure';
import type { FolderTreeController } from './use-folder-tree';
import type { DocTreeItem, TableDocumentListItem, MediaLibraryListItem } from '@platform/tauri/client';

export function useNotebookTreeRename({ notebookId, notebookPath, tree, tableDocumentByPath, mediaLibraryByPath }: {
  notebookId: string | null;
  notebookPath: string;
  tree: FolderTreeController;
  tableDocumentByPath: ReadonlyMap<string, TableDocumentListItem>;
  mediaLibraryByPath: ReadonlyMap<string, MediaLibraryListItem>;
}) {
  const { t } = useI18n();
  const { renameFolder, expanded, loadingDirectories, nodes, refresh } = tree;
  return useCallback(async (item: DocTreeItem, nextName: string) => {
    const trimmed = nextName.trim();
    const isNote = item.type === 'document'
      && (item.resourceKind ?? resourceKindFromPath(item.name)) === 'note';
    const isTableDocument = item.type === 'document' && isTableDocumentFilename(item.name);
    const isMediaLibrary = item.type === 'document' && isMediaLibraryFilename(item.name);
    const currentName = item.type === 'folder'
      ? item.name
      : isNote || isTableDocument || isMediaLibrary ? displayTitleFromFilename(item.name) : item.name;
    if (!trimmed || trimmed === currentName) return true;

    try {
      if (item.type === 'folder') {
        const renamedPath = await renameFolder(item.fullPath, trimmed, notebookPath);
        const oldFolderPath = canonicalDirectoryPath(item.fullPath);
        const newFolderPath = canonicalDirectoryPath(renamedPath);
        const expandedPathsToRefresh = [...expanded]
          .filter((path) => (path === oldFolderPath || path.startsWith(`${oldFolderPath}/`))
            && (loadingDirectories.has(path) || !nodes.get(path)?.children?.length))
          .map((path) => `${newFolderPath}${path.slice(oldFolderPath.length)}`);
        updateNoteLinksAfterMove(item.fullPath, renamedPath, true);
        await Promise.all(expandedPathsToRefresh.map((path) => refresh(path)));
      } else {
        if (isNote) {
          const fileIdentity = ensureFileDisplayIdentity(item.fullPath);
          const result = await renameMarkdownTitle({
            path: item.fullPath,
            title: trimmed,
            scopePath: notebookPath,
            notebook: notebookId ? { id: notebookId, path: notebookPath } : null,
            displayId: fileIdentity.displayId,
            onPathChanged: (oldPath, newPath) => replaceExternalDocumentPath(fileIdentity.displayId, oldPath, newPath),
          });
          if (!result) return false;
          if (!result.changed) return true;
        } else {
          const extension = isTableDocument
            ? tableDocumentExtension(item.name)
            : isMediaLibrary ? mediaLibraryExtension(item.name) : '';
          await renameWorkspaceFile({
            path: item.fullPath,
            name: `${trimmed}${extension}`,
            scopePath: notebookPath,
            notebookId: notebookId ?? undefined,
            collectionId: tableDocumentByPath.get(canonicalPath(item.fullPath))?.collectionId ?? mediaLibraryByPath.get(canonicalPath(item.fullPath))?.collectionId,
          });
        }
      }

      const normalizedPath = canonicalPath(item.fullPath);
      const parent = normalizedPath.slice(0, normalizedPath.lastIndexOf('/'));
      if (item.type !== 'folder' && !isTableDocument && !isMediaLibrary) await refresh(parent || notebookPath);
      toast.success(t('memo.fileTree.renamed', { name: trimmed }));
      return true;
    } catch (error) {
      toast.error(t(fileTreeRenameFailureKey(error)));
      return false;
    }
  }, [notebookPath, notebookId, tableDocumentByPath, mediaLibraryByPath, t, renameFolder, expanded, loadingDirectories, nodes, refresh]);

}
