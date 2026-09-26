import type { MemoEvent } from '@/types/memo';
import type { MemoItem } from '@/types/memo-item';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';

export interface MainWindowMemoEventActions {
  getSelectedNotebookId: () => string | null;
  invalidateMentionCaches: () => void;
  openMemoInBrowserColumn: (memoId: string) => Promise<void>;
  reportOpenFailure: (error: unknown) => void;
  handleMemoCreated: (memo: MemoItem) => void;
  handleMemoUpdated: (memo: MemoItem) => void;
  handleMemoDeleted: (memoId: string) => void;
  removeBrowserColumnTabsByMemoId: (memoId: string) => void;
  handleTagsRenamed: (event: Extract<MemoEvent, { kind: 'tags_renamed' }>) => void;
  handleTagsDeleted: (event: Extract<MemoEvent, { kind: 'tags_deleted' }>) => void;
  replaceActiveMemoPath: (memoId: string, path: string) => void;
  replaceBrowserColumnMemoPath: (memoId: string, path: string) => void;
  refreshSelectedNotebookMetadata: (event: MemoEvent) => void;
  refreshBackgroundTodoCount: (notebookId: string) => void;
}

/**
 * Route one memo event inside the main Webview.
 *
 * Externally created notes and notes created in a background notebook may
 * auto-open according to the user preference. Template notes skip that side
 * effect. List and tag metadata updates remain scoped to the selected
 * notebook, while notebook-keyed todo counts refresh in background.
 *
 * `tags_renamed` / `tags_deleted` 都是 tag 子树操作的收口事件, 后端已经
 * 完成所有 affected memo 的 body 改写 + index 同步。 这里只走
 * `handleTagsRenamed` / `handleTagsDeleted` 局部 patch memos 数组的 .tags
 * 字段, **不再**走 handleMemoUpdated / refreshSelectedNotebookMetadata ──
 * 后者会触发 triggerRefresh / loadData / loadMemos 重拉, 让"重命名 / 删除
 * tag 时无关列表闪烁"再次发生。
 */
export function handleMainWindowMemoEvent(
  event: MemoEvent,
  actions: MainWindowMemoEventActions,
): void {
  // tags_renamed / tags_deleted 不是单条 memo 写入事件, 走独立分支: 局
  // 部 patch memos 数组, 不替换 memo 整体, 不走 triggerMetadataRefresh
  // / loadData。 notebookId 失配也照样 patch (背景 notebook 的 memos 也
  // 得跟着重写, 否则用户切回时看到 stale tag token)。
  if (event.kind === 'tags_renamed') {
    actions.invalidateMentionCaches();
    actions.handleTagsRenamed(event);
    return;
  }
  if (event.kind === 'tags_deleted') {
    actions.invalidateMentionCaches();
    actions.handleTagsDeleted(event);
    return;
  }

  actions.invalidateMentionCaches();

  // BrowserColumn tabs are independent of the currently selected notebook.
  // Keep their identity/path projection in sync even for background notebook
  // events, otherwise a later tab activation can resurrect the old filename.
  if (event.kind === 'updated') {
    actions.replaceBrowserColumnMemoPath(event.id, event.path);
  } else if (event.kind === 'deleted') {
    actions.removeBrowserColumnTabsByMemoId(event.id);
  }

  const selectedNotebookId = actions.getSelectedNotebookId();
  const shouldOpenCreatedNote = event.kind === 'created'
    && event.memo.filename !== 'AGENTS.md'
    && (
      event.source === 'external_tool'
      || (!!selectedNotebookId && selectedNotebookId !== event.notebookId)
    )
    && event.source !== 'notebook_template'
    && useUserSettingsStore.getState().settings.autoOpenCreatedNotesInBrowser;
  if (shouldOpenCreatedNote) {
    void actions.openMemoInBrowserColumn(event.memo.id).catch(actions.reportOpenFailure);
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
