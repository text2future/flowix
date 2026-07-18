import type { MemoEvent } from '@/types/memo';
import type { MemoItem } from '@/types/memo-item';

export interface MainWindowMemoEventActions {
  getSelectedNotebookId: () => string | null;
  invalidateMentionCaches: () => void;
  openNoteTab: (memoId: string) => Promise<void>;
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
 * Externally created notes always open. Application-created notes also open
 * when they belong to a known background notebook, because the selected list
 * cannot present them. List and tag metadata updates remain scoped to the
 * selected notebook, while notebook-keyed todo counts refresh in background.
 */
export function handleMainWindowMemoEvent(
  event: MemoEvent,
  actions: MainWindowMemoEventActions,
): void {
  actions.invalidateMentionCaches();

  const selectedNotebookId = actions.getSelectedNotebookId();
  const shouldOpenCreatedNote = event.kind === 'created' && (
    event.source === 'external_tool'
    || (!!selectedNotebookId && selectedNotebookId !== event.notebookId)
  );
  if (shouldOpenCreatedNote) {
    void actions.openNoteTab(event.memo.id).catch(actions.reportOpenFailure);
  }

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
