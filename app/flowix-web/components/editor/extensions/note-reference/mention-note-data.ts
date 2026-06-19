import { memos, notebooks } from '../../../../lib/tauri/client';
import { joinNotebookMemoPath } from '../../../../lib/path';
import { useMemoStore, type Notebook } from '../../../../lib/store';
import type { MemoItem } from '../../../../types/memo-item';
import type { NoteReferenceAttrs } from './node-note';

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

function noteTitle(filename: string): string {
  return filename.replace(/\.md$/i, '');
}

async function fetchNotebookMemos(notebook: Notebook): Promise<MentionNoteItem[]> {
  try {
    const result = await memos.getMemos({
      notebookId: notebook.id,
      filter: 'all',
      sort: 'updatedAt',
    });
    const entries = (result?.memos ?? []) as MemoItem[];
    return entries
      .filter((memo) => memo?.id && memo?.filename)
      .map((memo) => ({
        id: memo.id,
        filename: memo.filename,
        title: noteTitle(memo.filename),
        updatedAt: memo.updatedAt || memo.createdAt || 0,
        notebookId: notebook.id,
        notebookName: notebook.name,
        notebookPath: notebook.path,
        originalPath: joinNotebookMemoPath(notebook.path, memo.filename),
      }));
  } catch {
    return [];
  }
}

async function fetchAllMentionNotes(): Promise<MentionNoteItem[]> {
  const store = useMemoStore.getState();
  let notebookList = store.notebooks;
  const selectedNotebookId = store.selectedNotebook?.id ?? null;

  if (notebookList.length === 0) {
    const loaded = await notebooks.getAll();
    notebookList = (Array.isArray(loaded) ? loaded : []) as Notebook[];
    useMemoStore.getState().setNotebooks(notebookList);
  }

  const selectedNotebook = selectedNotebookId
    ? notebookList.find((notebook) => notebook.id === selectedNotebookId)
    : null;
  const otherNotebooks = selectedNotebook
    ? notebookList.filter((notebook) => notebook.id !== selectedNotebook.id)
    : notebookList;

  const groups = await Promise.all(otherNotebooks.map(fetchNotebookMemos));
  // get_memos mutates the backend current_notebook_id. Read the selected
  // notebook last so editor saves keep resolving the active memo in its
  // original notebook after the mention index has been loaded.
  const selectedItems = selectedNotebook
    ? await fetchNotebookMemos(selectedNotebook)
    : [];

  return [...groups.flat(), ...selectedItems];
}

export function loadMentionNotes(): Promise<MentionNoteItem[]> {
  if (cachedItems) return Promise.resolve(cachedItems);
  if (!cachePromise) {
    cachePromise = fetchAllMentionNotes()
      .then((items) => {
        cachedItems = items;
        return items;
      })
      .catch((err) => {
        console.warn('[mention-note] load failed:', err);
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

export function queryMentionNotes(query: string): MentionNoteItem[] {
  const items = cachedItems ?? [];
  const selectedNotebookId = useMemoStore.getState().selectedNotebook?.id ?? null;
  const normalizedQuery = query.trim().toLowerCase();

  if (normalizedQuery) {
    return items
      .filter((item) => item.filename.toLowerCase().includes(normalizedQuery))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return [...items].sort((a, b) => {
    const aCurrent = selectedNotebookId && a.notebookId === selectedNotebookId ? 1 : 0;
    const bCurrent = selectedNotebookId && b.notebookId === selectedNotebookId ? 1 : 0;
    if (aCurrent !== bCurrent) return bCurrent - aCurrent;
    return b.updatedAt - a.updatedAt;
  });
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
