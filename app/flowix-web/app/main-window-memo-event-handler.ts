import type { MemoEvent } from '@/types/memo';
import type { MemoItem } from '@/types/memo-item';

export interface MainWindowMemoEventActions {
  getSelectedNotebookId: () => string | null;
  invalidateMentionCaches: () => void;
  openNoteWindow: (memoId: string) => Promise<void>;
  reportOpenFailure: (error: unknown) => void;
  handleMemoCreated: (memo: MemoItem) => void;
  handleMemoUpdated: (memo: MemoItem) => void;
  handleMemoDeleted: (memoId: string) => void;
  replaceActiveMemoPath: (memoId: string, path: string) => void;
  refreshSelectedNotebookMetadata: (event: MemoEvent) => void;
  refreshBackgroundTodoCount: (notebookId: string) => void;
}

/**
 * Route one memo event inside the main Webview.
 *
 * Window opening is intentionally independent of the selected notebook. List
 * and tag metadata updates are scoped to the selected notebook, while the
 * notebook-keyed todo count may safely refresh in the background.
 */
export function handleMainWindowMemoEvent(
  event: MemoEvent,
  actions: MainWindowMemoEventActions,
): void {
  actions.invalidateMentionCaches();

  if (event.kind === 'created' && event.source === 'external_tool') {
    void actions.openNoteWindow(event.memo.id).catch(actions.reportOpenFailure);
  }

  const selectedNotebookId = actions.getSelectedNotebookId();
  if (!selectedNotebookId || selectedNotebookId !== event.notebookId) {
    if (event.derivedChanged.todos) {
      actions.refreshBackgroundTodoCount(event.notebookId);
    }
    return;
  }

  if (event.kind === 'created') {
    actions.handleMemoCreated(event.memo);
  } else if (event.kind === 'updated') {
    actions.handleMemoUpdated(event.memo);
    actions.replaceActiveMemoPath(event.id, event.path);
  } else {
    actions.handleMemoDeleted(event.id);
  }

  actions.refreshSelectedNotebookMetadata(event);
}
