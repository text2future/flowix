import {
  memos,
  notebooks,
  plugins,
  type FilterType,
  type MemoColorFilter,
  type MemoListPage,
  type NotebookSortEntry,
  type SortType,
} from '@platform/tauri/client';
import type { MemoColor, Notebook } from '@features/memo';

export type { FilterType, SortType } from '@platform/tauri/client';

export const memoRepository = {
  list: (params?: {
    notebookId?: string;
    filter?: FilterType;
    sort?: SortType;
    tagId?: string;
    pluginId?: string;
    color?: MemoColorFilter;
    cursor?: string;
    limit?: number;
  }): Promise<MemoListPage> => memos.getMemos(params),
  listPluginNotes: (pluginId: string, notebookId: string) => plugins.listNotes(pluginId, notebookId),
  create: (tag?: string, notebookId?: string, parentRelativePath?: string) =>
    memos.addDocument(tag, notebookId, parentRelativePath),
  delete: (id: string) => memos.deleteMemo(id),
  favorite: (id: string) => memos.favoriteMemo(id),
  unfavorite: (id: string) => memos.unfavoriteMemo(id),
  setColors: (id: string, colors: MemoColor[]) => memos.setMemoColors(id, colors),
};

export const notebookRepository = {
  list: (): Promise<Notebook[]> => notebooks.getAll(),
  create: (name: string, path?: string, icon?: string | null) =>
    notebooks.create(name, path, icon),
  createFromCloud: (id: string, name: string, path: string, icon?: string | null) =>
    notebooks.createFromCloud(id, name, path, icon),
  startImport: (notebookId: string) => notebooks.startImport(notebookId),
  getImportStatus: (notebookId: string) => notebooks.getImportStatus(notebookId),
  update: (id: string, name?: string, icon?: string | null) =>
    notebooks.update(id, name, icon),
  /**
   * Reorder notebooks by submitting (id, sort) pairs to the backend.
   * `order` is the desired final sequence (id in the order it should appear);
   * sort values are assigned by the caller (typically `index * 10`).
   * Returns the freshly ordered notebook list.
   */
  reorder: (order: NotebookSortEntry[]) => notebooks.reorder(order),
};
