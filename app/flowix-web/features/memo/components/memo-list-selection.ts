import { notebookRelativeDirectoryPath } from '@/lib/path';
import { noteIndexFor, noteLookupKey } from '@features/memo/store/note-store';
import { noteListItemKey, type NoteListItem } from '@/types/note-item';

/**
 * Key of the row the memo list should highlight.
 *
 * Only the middle column counts. `selectedNote` is written by the Work session
 * alone and focus can sit in the other column, so after the columns exchange
 * positions both of them point at a document the user is not reading.
 */
export function middleColumnSelectionKey(input: {
  middleColumnFilePath: string | null;
  notebook: { id: string; path: string } | null;
  notes: readonly NoteListItem[];
}): string | undefined {
  const { middleColumnFilePath, notebook, notes } = input;
  if (!middleColumnFilePath || !notebook) return undefined;
  const relativePath = notebookRelativeDirectoryPath(notebook.path, middleColumnFilePath);
  if (!relativePath) return undefined;
  const item = noteIndexFor(notes).get(noteLookupKey(notebook.id, relativePath));
  // A just-opened note can be missing from the loaded page; keep the key shape
  // identical to `noteListItemKey` so the row still matches once it renders.
  return item ? noteListItemKey(item) : `path:${notebook.id}:${relativePath}`;
}
