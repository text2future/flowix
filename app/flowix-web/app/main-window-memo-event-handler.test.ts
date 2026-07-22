import { describe, expect, it, vi } from 'vitest';

import {
  handleMainWindowMemoEvent,
  type MainWindowMemoEventActions,
} from './main-window-memo-event-handler';
import type { MemoEvent } from '@/types/memo';
import type { MemoItem } from '@/types/memo-item';

const memo: MemoItem = {
  id: 'memo-b',
  filename: 'Created.md',
  preview: '',
  tags: [],
  todos: [],
  agents: [],
  createdAt: 1,
  updatedAt: 1,
  favorited: false,
  icon: null,
  colors: [],
  properties: {},
};

function createdEvent(overrides: Partial<Extract<MemoEvent, { kind: 'created' }>> = {}): MemoEvent {
  return {
    kind: 'created',
    memo,
    notebookId: 'notebook-b',
    derivedChanged: { tags: false, todos: false, agents: false },
    source: 'external_tool',
    ...overrides,
  };
}

function createActions(selectedNotebookId = 'notebook-a'): MainWindowMemoEventActions {
  return {
    getSelectedNotebookId: vi.fn(() => selectedNotebookId),
    invalidateMentionCaches: vi.fn(),
    openNoteTab: vi.fn().mockResolvedValue(undefined),
    reportOpenFailure: vi.fn(),
    handleMemoCreated: vi.fn(),
    handleMemoUpdated: vi.fn(),
    handleMemoDeleted: vi.fn(),
    handleTagsRenamed: vi.fn(),
    handleTagsDeleted: vi.fn(),
    replaceActiveMemoPath: vi.fn(),
    refreshSelectedNotebookMetadata: vi.fn(),
    refreshBackgroundTodoCount: vi.fn(),
  };
}

describe('handleMainWindowMemoEvent', () => {
  it('opens an externally created note from another notebook without changing the current list', () => {
    const actions = createActions('notebook-a');

    handleMainWindowMemoEvent(createdEvent(), actions);

    expect(actions.openNoteTab).toHaveBeenCalledWith('memo-b');
    expect(actions.handleMemoCreated).not.toHaveBeenCalled();
    expect(actions.refreshSelectedNotebookMetadata).not.toHaveBeenCalled();
    expect(actions.invalidateMentionCaches).toHaveBeenCalledOnce();
  });

  it('opens an externally created note before notebook hydration without touching the list', () => {
    const actions = createActions('');

    handleMainWindowMemoEvent(createdEvent(), actions);

    expect(actions.openNoteTab).toHaveBeenCalledWith('memo-b');
    expect(actions.handleMemoCreated).not.toHaveBeenCalled();
    expect(actions.refreshSelectedNotebookMetadata).not.toHaveBeenCalled();
  });

  it('refreshes only the notebook-keyed todo count for a background notebook', () => {
    const actions = createActions('notebook-a');
    const event = createdEvent({
      derivedChanged: { tags: true, todos: true, agents: true },
    });

    handleMainWindowMemoEvent(event, actions);

    expect(actions.refreshBackgroundTodoCount).toHaveBeenCalledWith('notebook-b');
    expect(actions.refreshSelectedNotebookMetadata).not.toHaveBeenCalled();
  });

  it('updates the current notebook but does not auto-open user-created notes', () => {
    const actions = createActions('notebook-b');
    const event = createdEvent({ source: 'user_new' });

    handleMainWindowMemoEvent(event, actions);

    expect(actions.openNoteTab).not.toHaveBeenCalled();
    expect(actions.handleMemoCreated).toHaveBeenCalledWith(memo);
    expect(actions.refreshSelectedNotebookMetadata).toHaveBeenCalledWith(event);
  });

  it('opens a user-created note when it belongs to a background notebook', () => {
    const actions = createActions('notebook-a');
    const event = createdEvent({ source: 'user_new' });

    handleMainWindowMemoEvent(event, actions);

    expect(actions.openNoteTab).toHaveBeenCalledWith('memo-b');
    expect(actions.handleMemoCreated).not.toHaveBeenCalled();
    expect(actions.refreshSelectedNotebookMetadata).not.toHaveBeenCalled();
  });

  it('opens an imported note when it belongs to a background notebook', () => {
    const actions = createActions('notebook-a');
    const event = createdEvent({ source: 'user_import' });

    handleMainWindowMemoEvent(event, actions);

    expect(actions.openNoteTab).toHaveBeenCalledWith('memo-b');
  });

  it('updates metadata and the active path for a current-notebook update', () => {
    const actions = createActions('notebook-b');
    const event: MemoEvent = {
      kind: 'updated',
      id: memo.id,
      path: '/notebook-b/Renamed.md',
      memo: { ...memo, filename: 'Renamed.md' },
      notebookId: 'notebook-b',
      derivedChanged: { tags: false, todos: false, agents: false },
      source: 'external_tool',
    };

    handleMainWindowMemoEvent(event, actions);

    expect(actions.handleMemoUpdated).toHaveBeenCalledWith(event.memo);
    expect(actions.replaceActiveMemoPath).toHaveBeenCalledWith(memo.id, event.path);
    expect(actions.openNoteTab).not.toHaveBeenCalled();
  });

  it('reports automatic window-open failures', async () => {
    const error = new Error('window unavailable');
    const actions = createActions('notebook-a');
    vi.mocked(actions.openNoteTab).mockRejectedValue(error);

    handleMainWindowMemoEvent(createdEvent(), actions);

    await vi.waitFor(() => expect(actions.reportOpenFailure).toHaveBeenCalledWith(error));
  });

  it('routes tags_renamed to handleTagsRenamed and bypasses memo/replace/refresh paths', () => {
    // tags_renamed 是 metadata 事件, 不是单条 memo 写入 ── 即使
    // notebookId 跟当前选中 notebook 匹配, 也**不**走 handleMemoUpdated /
    // replaceActiveMemoPath / refreshSelectedNotebookMetadata, 避免触发
    // loadData + loadMemos 全量重拉 (选中与重命名无关的标签时, 列表
    // 也会闪烁)。 同样, notebookId 失配也不应该丢到 background todo
    // count 路径 (rename 不改 todos)。
    const actions = createActions('notebook-b');
    const event: MemoEvent = {
      kind: 'tags_renamed',
      notebookId: 'notebook-b',
      renamedTags: [['中国', '华']],
      affectedMemoIds: ['memo-1', 'memo-2'],
    };

    handleMainWindowMemoEvent(event, actions);

    expect(actions.handleTagsRenamed).toHaveBeenCalledWith(event);
    expect(actions.handleMemoUpdated).not.toHaveBeenCalled();
    expect(actions.handleMemoCreated).not.toHaveBeenCalled();
    expect(actions.handleMemoDeleted).not.toHaveBeenCalled();
    expect(actions.replaceActiveMemoPath).not.toHaveBeenCalled();
    expect(actions.refreshSelectedNotebookMetadata).not.toHaveBeenCalled();
    expect(actions.refreshBackgroundTodoCount).not.toHaveBeenCalled();
    expect(actions.openNoteTab).not.toHaveBeenCalled();
    expect(actions.invalidateMentionCaches).toHaveBeenCalledOnce();
  });

  it('routes tags_renamed to handleTagsRenamed even for background notebooks', () => {
    // 即使用户选中的 notebook 跟事件 notebookId 不匹配, 也照样 patch
    // memos 数组 (切回时不能看到 stale tag token)。 但不调 background
    // todo count ── rename 不改 todos。
    const actions = createActions('notebook-a');
    const event: MemoEvent = {
      kind: 'tags_renamed',
      notebookId: 'notebook-b',
      renamedTags: [],
      affectedMemoIds: [],
    };

    handleMainWindowMemoEvent(event, actions);

    expect(actions.handleTagsRenamed).toHaveBeenCalledWith(event);
    expect(actions.refreshBackgroundTodoCount).not.toHaveBeenCalled();
    expect(actions.invalidateMentionCaches).toHaveBeenCalledOnce();
  });

  it('routes tags_deleted to handleTagsDeleted and bypasses memo/replace/refresh paths', () => {
    // tags_deleted 是 metadata 事件, 跟 tags_renamed 同形 ── 直接走
    // handleTagsDeleted, 不走 handleMemoUpdated / replaceActiveMemoPath
    // / refreshSelectedNotebookMetadata / refreshBackgroundTodoCount。
    const actions = createActions('notebook-b');
    const event: MemoEvent = {
      kind: 'tags_deleted',
      notebookId: 'notebook-b',
      deletedTags: ['中国', '中国/湖南'],
      affectedMemoIds: ['memo-1'],
    };

    handleMainWindowMemoEvent(event, actions);

    expect(actions.handleTagsDeleted).toHaveBeenCalledWith(event);
    expect(actions.handleMemoUpdated).not.toHaveBeenCalled();
    expect(actions.handleMemoCreated).not.toHaveBeenCalled();
    expect(actions.handleMemoDeleted).not.toHaveBeenCalled();
    expect(actions.replaceActiveMemoPath).not.toHaveBeenCalled();
    expect(actions.refreshSelectedNotebookMetadata).not.toHaveBeenCalled();
    expect(actions.refreshBackgroundTodoCount).not.toHaveBeenCalled();
    expect(actions.openNoteTab).not.toHaveBeenCalled();
    expect(actions.invalidateMentionCaches).toHaveBeenCalledOnce();
  });

  it('routes tags_deleted to handleTagsDeleted even for background notebooks', () => {
    const actions = createActions('notebook-a');
    const event: MemoEvent = {
      kind: 'tags_deleted',
      notebookId: 'notebook-b',
      deletedTags: [],
      affectedMemoIds: [],
    };

    handleMainWindowMemoEvent(event, actions);

    expect(actions.handleTagsDeleted).toHaveBeenCalledWith(event);
    expect(actions.refreshBackgroundTodoCount).not.toHaveBeenCalled();
    expect(actions.invalidateMentionCaches).toHaveBeenCalledOnce();
  });
});
