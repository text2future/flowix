import { useCallback, useMemo, useState } from 'react';
import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';
import type { TableViewType } from '@features/multidimensional-table/public/create-api';
import { NotebookDocumentCreateDialog, type NotebookDocumentCreateRequest } from './notebook-document-create-dialog';

const refreshNothing = () => Promise.resolve();

export function relativeFolderPath(notebookPath: string, folderPath: string): string {
  const root = canonicalDirectoryPath(notebookPath);
  const folder = canonicalPath(folderPath);
  if (folder === root) return '';
  return folder.startsWith(`${root}/`) ? folder.slice(root.length + 1) : folder;
}

export function useNotebookTreeCreation({ notebookId, notebookPath, defaultCreateFolder, refreshTables, refreshMediaLibraries, refreshWorkDocumentCollections = refreshNothing }: {
  notebookId: string | null;
  notebookPath: string;
  /**
   * Implicit destination when the create action does not name a parent
   * folder. Callers pass the folder the user is currently browsing in the
   * Work column (notebook-relative, or null for the notebook root); the
   * former stored `defaultCreateFolder` preference feeds the same slot.
   */
  defaultCreateFolder?: string | null;
  refreshTables: () => Promise<void>;
  refreshMediaLibraries: () => Promise<void>;
  refreshWorkDocumentCollections?: () => Promise<void>;
}) {
  const [request, setRequest] = useState<NotebookDocumentCreateRequest | null>(null);
  const open = useCallback((kind: NotebookDocumentCreateRequest['kind'], parentPath?: string, viewType?: TableViewType) => {
    if (!notebookId) return;
    setRequest({
      kind, notebook: { id: notebookId, path: notebookPath }, viewType,
      parentFolder: () => parentPath === undefined ? defaultCreateFolder ?? null : relativeFolderPath(notebookPath, parentPath),
      refresh: kind === 'table' ? refreshTables : kind === 'media-library' ? refreshMediaLibraries : refreshWorkDocumentCollections,
    });
  }, [notebookId, notebookPath, defaultCreateFolder, refreshTables, refreshMediaLibraries, refreshWorkDocumentCollections]);
  const actions = useMemo(() => ({
    openNewTableDialog: (parentPath?: string, viewType?: TableViewType) => open('table', parentPath, viewType),
    openNewMediaLibraryDialog: (parentPath?: string) => open('media-library', parentPath),
    handleCreateMediaLibraryAtPath: (parentPath: string) => open('media-library', parentPath),
    openNewWorkDocumentsDialog: (parentPath?: string) => open('work-documents', parentPath),
  }), [open]);
  return {
    ...actions,
    creationDialog: request ? <NotebookDocumentCreateDialog request={request} onClose={() => setRequest(null)} /> : null,
  };
}
