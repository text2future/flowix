import { joinNotebookMemoPath } from '@/lib/path';
import { useDocumentStore } from '@features/document';
import { useMemoStore, type MemoItem, type Notebook } from '@features/memo';
import { memos as memosClient } from '@platform/tauri/client';
import { createLogger } from '@/lib/logger';
import {
  openArtifactTarget,
  openMemoTarget,
} from '@features/workspace/use-cases/workspace-navigation';
import type { WorkspaceContentLocation } from '@features/workspace/use-cases/workspace-content-activation';
import { getPluginNoteInfo } from '@features/plugin/plugin-note';

const logger = createLogger('memo-session');

export interface OpenMemoSessionOptions {
  initialFocus?: 'title' | 'body';
}

export function resolveMemoSessionPath(memo: MemoItem, notebook: Notebook | null): string | null {
  return notebook?.path ? joinNotebookMemoPath(notebook.path, memo.filename) : memo.filename ?? null;
}

export async function openMemoSession(
  memo: MemoItem,
  notebook: Notebook | null,
  options?: OpenMemoSessionOptions,
): Promise<WorkspaceContentLocation | null> {
  try {
    const pluginNote = getPluginNoteInfo(memo);
    if (pluginNote) {
      return await openArtifactTarget({
        pointerMemoId: memo.id,
        notebook,
        pluginId: pluginNote.pluginId,
        renderer: pluginNote.renderer,
        memo,
      });
    }

    const fullPath = resolveMemoSessionPath(memo, notebook);
    return await openMemoTarget({
      memoId: memo.id,
      path: fullPath,
      notebookId: notebook?.id ?? null,
      notebookPath: notebook?.path ?? null,
      memo,
      notebook,
      initialFocus: options?.initialFocus,
    });
  } catch (error) {
    logger.error('open document failed', { error, memoId: memo.id });
    return null;
  }
}

let restoringMemoId: string | null = null;

/**
 * Restore the memo persisted by the workspace store exactly once at main
 * window startup. Keeping this orchestration outside MemoList prevents a
 * hover/secondary list instance from reopening a document and avoids a
 * mount-only React effect with captured state.
 */
export async function restorePersistedMemoSession(): Promise<void> {
  const memoState = useMemoStore.getState();
  const memoId = memoState.selectedMemoId ?? memoState.selectedMemo?.id ?? null;
  if (!memoId || restoringMemoId === memoId) return;

  const documentState = useDocumentStore.getState();
  if (documentState.currentDocumentSource === 'external') return;
  if (documentState.activeMemoSession?.memoId === memoId) return;

  restoringMemoId = memoId;
  try {
    // The persisted store contains only the identity. Resolve the current
    // backend entity so filename/properties/plugin metadata are authoritative.
    const memo = memoState.selectedMemo?.id === memoId
      ? memoState.selectedMemo
      : await memosClient.readMemo(memoId);
    if (!memo) {
      useMemoStore.getState().setSelectedMemo(null);
      return;
    }
    useMemoStore.getState().setSelectedMemo(memo);
    await openMemoSession(memo, memoState.selectedNotebook);
  } finally {
    if (restoringMemoId === memoId) restoringMemoId = null;
  }
}
