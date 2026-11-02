import { notes } from '@platform/tauri/client';
import { useNoteStore } from '@features/memo/store/note-store';
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

let cachedItems: MentionNoteItem[] | null = null;
let cachePromise: Promise<MentionNoteItem[]> | null = null;

/** The picker renders titles only, so it asks for the title-only projection. */
const MENTION_LIMIT = 200;

async function fetchMentionNotes(): Promise<MentionNoteItem[]> {
  const state = useNoteStore.getState();
  if (!state.notebooksInitialized) await state.loadNotebooks();
  const notebooks = useNoteStore.getState().notebooks;
  const groups = await Promise.all(notebooks.map(async (notebook) => {
    const summaries = await notes.listSummaries(notebook.id);
    return summaries.map((note): MentionNoteItem => ({
      relativePath: note.relativePath,
      filename: note.relativePath.split('/').pop() || note.relativePath,
      title: note.title,
      updatedAt: note.updatedAt,
      notebookId: notebook.id,
      notebookName: notebook.name,
      notebookPath: notebook.path,
      originalPath: null,
    }));
  }));
  return groups.flat().sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Load every note title once. Filtering happens in memory: refetching on each
 * keystroke meant one full IPC round trip per notebook per character typed.
 * `invalidateMentionNotes` is called on the notebook change events that can add
 * or remove a note, so the cache tracks the tree.
 */
function loadMentionNotes(): Promise<MentionNoteItem[]> {
  if (cachedItems) return Promise.resolve(cachedItems);
  if (!cachePromise) {
    cachePromise = fetchMentionNotes()
      .then((items) => {
        cachedItems = items;
        return items;
      })
      .catch((err) => {
        console.warn('[note-mention] load failed:', err);
        cachePromise = null;
        return [];
      });
  }
  return cachePromise;
}

export function invalidateMentionNotes(): void {
  cachedItems = null;
  cachePromise = null;
}

export function queryMentionNotes(query: string): Promise<MentionNoteItem[]> {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return loadMentionNotes().then((items) => {
    const matched = normalizedQuery
      ? items.filter((item) => item.title.toLocaleLowerCase().includes(normalizedQuery))
      : items;
    return matched.slice(0, MENTION_LIMIT);
  });
}

export function toNoteReferenceAttrs(item: MentionNoteItem): NoteReferenceAttrs {
  return {
    notebookId: item.notebookId,
    relativePath: item.relativePath,
    notebookName: item.notebookName,
    title: item.title,
    originalPath: item.originalPath,
    linkStyle: 'flowix',
    linkTarget: null,
    heading: null,
    stale: false,
  };
}
