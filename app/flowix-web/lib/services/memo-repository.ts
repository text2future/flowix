import { memos, notebooks, type FilterType, type SortType } from '../tauri/client';
import type { MemoColor, MemoItem, Notebook } from '../store';

export type { FilterType, SortType } from '../tauri/client';

export const memoRepository = {
  list: (params?: {
    notebookId?: string;
    filter?: FilterType;
    sort?: SortType;
    tagId?: string;
  }) => memos.getMemos(params),
  create: (tag?: string, notebookId?: string) => memos.addDocument(tag, notebookId) as Promise<MemoItem>,
  delete: (id: string) => memos.deleteMemo(id),
  favorite: (id: string) => memos.favoriteMemo(id),
  unfavorite: (id: string) => memos.unfavoriteMemo(id),
  setColors: (id: string, colors: MemoColor[]) => memos.setMemoColors(id, colors),
};

export const notebookRepository = {
  list: () => notebooks.getAll() as Promise<Notebook[]>,
  create: (name: string, path: string, icon?: string) =>
    notebooks.create(name, path, icon) as Promise<Notebook | null>,
  update: (id: string, name?: string, icon?: string) =>
    notebooks.update(id, name, icon) as Promise<Notebook | null>,
};
