import { canonicalPath } from './path';
import {
  useDocumentHistoryStore,
  type DocumentHistoryEntry,
  type MemoHistoryEntry,
} from './store/document-history-store';
import { useDocumentStore } from './store/document-store';
import { useMemoStore, type Notebook } from './store/memo-store';
import { notebooks as notebooksClient } from './tauri/client';
import type { MemoItem } from '../types/memo-item';

export type DocumentHistoryDirection = 'back' | 'forward';

function currentMemoHistoryEntry(): MemoHistoryEntry | null {
  const session = useDocumentStore.getState().activeMemoSession;
  if (!session) return null;
  return {
    kind: 'memo',
    memoId: session.memoId,
    notebookId: session.notebookId,
    notebookPath: session.notebookPath,
    path: session.path,
    openedAt: session.openedAt,
  };
}

function filenameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function memoFromHistoryEntry(entry: MemoHistoryEntry): MemoItem {
  const existing = useMemoStore.getState().memos.find((memo) => memo.id === entry.memoId);
  if (existing) return existing;

  return {
    id: entry.memoId,
    filename: entry.title ?? filenameFromPath(entry.path),
    preview: '',
    tags: [],
    todos: [],
    createdAt: 0,
    updatedAt: entry.openedAt,
    favorited: false,
    icon: null,
    colors: [],
    isOpen: true,
  };
}

async function ensureNotebook(entry: MemoHistoryEntry): Promise<Notebook | null> {
  const memoStore = useMemoStore.getState();
  if (!entry.notebookId) return memoStore.selectedNotebook;
  if (memoStore.selectedNotebook?.id === entry.notebookId) return memoStore.selectedNotebook;

  let target = memoStore.notebooks.find((notebook) => notebook.id === entry.notebookId) ?? null;

  try {
    await notebooksClient.setCurrent(entry.notebookId);
  } catch (error) {
    console.warn('[document-navigation] Failed to switch notebook:', error);
    throw error;
  }

  if (!target) {
    await useMemoStore.getState().loadNotebooks();
    target = useMemoStore.getState().notebooks.find((notebook) => notebook.id === entry.notebookId) ?? null;
  }

  if (target) {
    useMemoStore.getState().setSelectedNotebook(target);
  }

  await useMemoStore.getState().loadMemos({ notebookId: entry.notebookId });
  return target;
}

async function openMemoHistoryEntry(entry: MemoHistoryEntry): Promise<void> {
  const notebook = await ensureNotebook(entry);
  const path = canonicalPath(entry.path);
  const memo = memoFromHistoryEntry(entry);
  const memoStore = useMemoStore.getState();

  if (!memoStore.memos.find((item) => item.id === memo.id)) {
    memoStore.upsertMemo(memo);
  }
  memoStore.setSelectedMemo(memo);
  await useDocumentStore.getState().openMemoDocument({
    memoId: entry.memoId,
    path,
    notebookId: entry.notebookId ?? notebook?.id ?? null,
    notebookPath: entry.notebookPath ?? notebook?.path ?? null,
    history: 'skip',
  });
}

function isMemoHistoryEntry(entry: DocumentHistoryEntry | null): entry is MemoHistoryEntry {
  return entry?.kind === 'memo';
}

function isSameMemoEntry(a: MemoHistoryEntry | null, b: MemoHistoryEntry | null): boolean {
  return !!a && !!b && a.memoId === b.memoId && canonicalPath(a.path) === canonicalPath(b.path);
}

export async function navigateDocumentHistory(direction: DocumentHistoryDirection): Promise<boolean> {
  const current = currentMemoHistoryEntry();
  let target: DocumentHistoryEntry | null = null;

  while (true) {
    const history = useDocumentHistoryStore.getState();
    target = direction === 'back' ? history.peekBack() : history.peekForward();

    if (!isMemoHistoryEntry(target)) {
      return false;
    }

    if (!isSameMemoEntry(current, target)) {
      break;
    }

    if (direction === 'back') {
      useDocumentHistoryStore.getState().commitBackNavigation(null);
    } else {
      useDocumentHistoryStore.getState().commitForwardNavigation(null);
    }
  }

  if (direction === 'back') {
    useDocumentHistoryStore.getState().commitBackNavigation(current);
  } else {
    useDocumentHistoryStore.getState().commitForwardNavigation(current);
  }

  await openMemoHistoryEntry(target);

  return true;
}
