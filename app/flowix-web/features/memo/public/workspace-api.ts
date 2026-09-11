import { notebooks as notebooksClient } from '@platform/tauri/client';
import {
  useMemoStore,
  type MemoStore,
  type Notebook,
} from '@features/memo/store/memo-store';
import type { MemoItem } from '@/types/memo-item';

/** Memo-list and notebook-selection capabilities required by workspace flows. */
export type WorkspaceMemoState = Pick<
  MemoStore,
  | 'memos'
  | 'notebooks'
  | 'selectedMemo'
  | 'selectedNotebook'
  | 'selectedNotebookId'
  | 'setMemos'
  | 'setNotebooks'
  | 'setSelectedMemo'
  | 'setSelectedNotebook'
  | 'setActiveFilter'
  | 'setActivePluginId'
  | 'upsertMemo'
  | 'loadMemos'
  | 'loadNotebooks'
>;

export function getWorkspaceMemoState(): WorkspaceMemoState {
  return useMemoStore.getState();
}

export function getSelectedWorkspaceNotebookId(): string | null {
  const state = useMemoStore.getState();
  return state.selectedNotebookId ?? state.selectedNotebook?.id ?? null;
}

/** Persist the notebook selected by a workspace navigation transaction. */
export async function setCurrentWorkspaceNotebook(
  notebook: Pick<Notebook, 'id'> | string | null,
): Promise<void> {
  const notebookId = typeof notebook === 'string' ? notebook : notebook?.id ?? null;
  await notebooksClient.setCurrent(notebookId);
}

export type { MemoItem, Notebook };
