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
  handleTagsRenamed: (event: Extract<MemoEvent, { kind: 'tags_renamed' }>) => void;
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
 *
 * `tags_renamed` 是 move_memo_tag IPC 的一次性收口事件: 后端已经把所有
 * affected memo 的 body 改写完, 这里只走 `handleTagsRenamed` 局部 patch
 * memos 数组的 .tags 字段, **不再**走 handleMemoUpdated /
 * refreshSelectedNotebookMetadata ── 后者会触发 triggerRefresh / loadData
 * / loadMemos 重拉, 让"重命名 B 时 A 的列表闪烁"再次发生。
 */
export function handleMainWindowMemoEvent(
  event: MemoEvent,
  actions: MainWindowMemoEventActions,
): void {
  // tags_renamed 不是单条 memo 写入事件, 走独立分支: 局部 patch memos
  // 数组, 不替换 memo 整体, 不走 triggerMetadataRefresh / loadData。
  // notebookId 失配也照样 patch (背景 notebook 的 memos 也得跟着重写,
  // 否则用户切回时看到 stale tag token)。
  if (event.kind === 'tags_renamed') {
    actions.invalidateMentionCaches();
    actions.handleTagsRenamed(event);
    return;
  }

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
