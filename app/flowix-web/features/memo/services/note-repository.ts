import { setDocumentProperties } from '@features/document/public/path-properties';
import {
  notes,
  notebooks,
  type FilterType,
  type NoteColorFilter,
  type NoteListPage,
  type NotebookSortEntry,
  type SortType,
} from '@platform/tauri/client';
import type { NoteColor } from '@/types/note-item';
import type { Notebook } from '@features/memo/store/note-store';

export type { FilterType, SortType } from '@platform/tauri/client';

export type FavoriteMutationOutcome = 'updated' | 'missingCleaned' | 'notSaved';

async function setFavorite(path: string, favorited: boolean): Promise<FavoriteMutationOutcome> {
  const cleanMissing = async (): Promise<FavoriteMutationOutcome> => (
    await notes.pruneMissing(path) === 'missingCleaned' ? 'missingCleaned' : 'notSaved'
  );
  if (await notes.pathStatus(path) === 'missing') return cleanMissing();
  if (await setDocumentProperties(path, { flowix_favorited: favorited })) return 'updated';
  if (await notes.pathStatus(path) === 'missing') return cleanMissing();
  return 'notSaved';
}

export const noteRepository = {
  listByPath: (params: {
    notebookId: string;
    filter?: FilterType;
    sort?: SortType;
    tagId?: string;
    color?: NoteColorFilter;
    cursor?: string;
    limit?: number;
  }): Promise<NoteListPage> => notes.getPage(params),
  listAllByPath: (notebookId: string) => notes.list(notebookId),
  /** Omit parentRelativePath to use the notebook default; pass '' for its root. */
  create: (tag: string | undefined, notebookId: string, parentRelativePath?: string, title?: string) =>
    notes.create(notebookId, tag, parentRelativePath, title),
  delete: (path: string) => notes.delete(path),
  favorite: (path: string, _expectedCacheId?: string) => setFavorite(path, true),
  unfavorite: (path: string, _expectedCacheId?: string) => setFavorite(path, false),
  setColors: (path: string, colors: NoteColor[], _expectedCacheId?: string) => setDocumentProperties(path, { flowix_colors: colors }),
};

/** @deprecated Compatibility export; use `noteRepository`. */

export const notebookRepository = {
  list: (): Promise<Notebook[]> => notebooks.getAll(),
  getDefaultPath: (name: string) => notebooks.getDefaultPath(name),
  ensureDefaultPath: (name: string) => notebooks.ensureDefaultPath(name),
  create: (name: string, path?: string, icon?: string | null, activate = true, templateId?: string | null) =>
    notebooks.create(name, path, icon, activate, templateId),
  ensureTemplateSetup: (notebookId: string, templateId: string) =>
    notebooks.ensureTemplateSetup(notebookId, templateId),
  getTemplateSetupStatus: (notebookId: string) =>
    notebooks.getTemplateSetupStatus(notebookId),
  startTemplateSetup: (notebookId: string, retry = false) =>
    notebooks.startTemplateSetup(notebookId, retry),
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
