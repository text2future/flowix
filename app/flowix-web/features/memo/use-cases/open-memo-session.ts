import { joinNotebookMemoPath } from '@/lib/path';
import { useDocumentStore } from '@features/document';
import { useMemoStore, type MemoItem, type Notebook } from '@features/memo';

export function resolveMemoSessionPath(memo: MemoItem, notebook: Notebook | null): string | null {
  return notebook?.path ? joinNotebookMemoPath(notebook.path, memo.filename) : memo.filename ?? null;
}

export async function openMemoSession(memo: MemoItem, notebook: Notebook | null): Promise<void> {
  const fullPath = resolveMemoSessionPath(memo, notebook);
  const previousSelectedMemo = useMemoStore.getState().selectedMemo;
  useMemoStore.getState().setSelectedMemo(memo);

  try {
    await useDocumentStore.getState().openMemoDocument({
      memoId: memo.id,
      path: fullPath,
      notebookId: notebook?.id ?? null,
      notebookPath: notebook?.path ?? null,
    });
  } catch (err) {
    console.error('[openMemoSession] openMemoDocument rejected', err);
    useMemoStore.getState().setSelectedMemo(previousSelectedMemo);
  }
}
