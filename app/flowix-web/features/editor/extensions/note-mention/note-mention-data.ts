import { memos } from '@platform/tauri/client';
import type { NoteReferenceAttrs } from '@features/editor/extensions/note-link/view-note';

export interface MentionNoteItem {
  id: string;
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

async function fetchMentionNotes(query: string): Promise<MentionNoteItem[]> {
  return memos.searchMentionNotes(query, 200);
}

function loadMentionNotes(): Promise<MentionNoteItem[]> {
  if (cachedItems) return Promise.resolve(cachedItems);
  if (!cachePromise) {
    cachePromise = fetchMentionNotes('')
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
  const normalizedQuery = query.trim().toLowerCase();
  return normalizedQuery ? fetchMentionNotes(normalizedQuery) : loadMentionNotes();
}

export function toNoteReferenceAttrs(item: MentionNoteItem): NoteReferenceAttrs {
  return {
    memoId: item.id,
    notebookId: item.notebookId,
    notebookName: item.notebookName,
    title: item.title,
    originalPath: item.originalPath,
    stale: false,
  };
}