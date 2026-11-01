/** Internal inputs for document list UI; not a registered workspace surface. */
export interface DocumentListViewContext {
  displayId: string;
  folderPath: string;
  notebookPath: string;
  notebookId: string | null;
  filters: { resourceKinds?: string[]; tags?: string[]; customFilterId?: string };
  mediaScope?: { relativePath: string; depth: 'direct_children' | 'descendants' };
  mediaDatasetActive?: boolean;
  workDocumentsFilter?: {
    file_name_contains?: string;
    file_type?: string;
    file_types?: string[];
    path_contains?: string;
    path_scope?: 'all';
  };
}
