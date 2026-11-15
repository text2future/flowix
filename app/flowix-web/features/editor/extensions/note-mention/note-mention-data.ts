import { notes } from '@platform/tauri/client';
import { useNoteStore } from '@features/memo/store/note-store';
import { joinNotebookMemoPath } from '@/lib/path';
import type { NoteReferenceAttrs } from '@features/editor/extensions/note-link/view-note';

export interface MentionNoteItem {
  relativePath: string;
  filename: string;
  title: string;
  updatedAt: number;
  notebookId: string;
  notebookName: string;
  notebookPath: string;
  originalPath: string | null;
}

interface NotebookMentionCache {
  items: MentionNoteItem[] | null;
  promise: Promise<MentionNoteItem[]> | null;
}

const cacheByNotebookId = new Map<string, NotebookMentionCache>();

/** The picker renders titles only, so it asks for the title-only projection. */
const MENTION_LIMIT = 200;

async function fetchMentionNotes(notebookId: string): Promise<MentionNoteItem[]> {
  const state = useNoteStore.getState();
  if (!state.notebooksInitialized) await state.loadNotebooks();

  const notebook = useNoteStore.getState().notebooks.find((item) => item.id === notebookId);
  if (!notebook) return [];

  const summaries = await notes.listSummaries(notebookId);
  return summaries
    .map((note): MentionNoteItem => ({
      relativePath: note.relativePath,
      filename: note.relativePath.split('/').pop() || note.relativePath,
      title: note.title,
      updatedAt: note.updatedAt,
      notebookId: notebook.id,
      notebookName: notebook.name,
      notebookPath: notebook.path,
      originalPath: null,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Cache summaries independently so one notebook cannot poison another. */
function loadMentionNotes(notebookId: string): Promise<MentionNoteItem[]> {
  let entry = cacheByNotebookId.get(notebookId);
  if (!entry) {
    entry = { items: null, promise: null };
    cacheByNotebookId.set(notebookId, entry);
  }
  if (entry.items) return Promise.resolve(entry.items);
  if (entry.promise) return entry.promise;

  const currentEntry = entry;
  const promise = fetchMentionNotes(notebookId)
    .then((items) => {
      if (cacheByNotebookId.get(notebookId) === currentEntry) {
        currentEntry.items = items;
      }
      return items;
    })
    .catch((err) => {
      if (cacheByNotebookId.get(notebookId) === currentEntry) {
        cacheByNotebookId.delete(notebookId);
      }
      throw err;
    });
  currentEntry.promise = promise;
  return promise;
}

/**
 * Query notes from exactly one notebook. A missing notebook context produces
 * no candidates; failures for the target notebook are allowed to reach the UI
 * so they are not presented as an empty search result.
 */
export function queryMentionNotes(
  query: string,
  notebookId: string | null | undefined,
): Promise<MentionNoteItem[]> {
  if (!notebookId) return Promise.resolve([]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  return loadMentionNotes(notebookId).then((items) => {
    const matched = normalizedQuery
      ? items.filter((item) => item.title.toLocaleLowerCase().includes(normalizedQuery))
      : items;
    return matched.slice(0, MENTION_LIMIT);
  });
}

/** Historical references must check every candidate, including duplicate names. */
export function listNoteReferenceCandidates(
  _query: string,
  notebookId?: string,
): Promise<MentionNoteItem[]> {
  return notebookId ? loadMentionNotes(notebookId) : Promise.resolve([]);
}

/** Invalidate one notebook, or all caches when no identity is available. */
export function invalidateMentionNotes(notebookId?: string | null): void {
  if (notebookId) cacheByNotebookId.delete(notebookId);
  else cacheByNotebookId.clear();
}

export function toNoteReferenceAttrs(item: MentionNoteItem): NoteReferenceAttrs {
  return {
    notebookId: item.notebookId,
    relativePath: item.relativePath,
    notebookName: item.notebookName,
    title: item.title,
    originalPath: item.originalPath ?? joinNotebookMemoPath(item.notebookPath, item.relativePath),
    linkStyle: 'flowix',
    linkTarget: null,
    heading: null,
    stale: false,
  };
}
