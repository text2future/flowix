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
    openPathInBrowserColumn: vi.fn().mockResolvedValue(undefined),
    reportOpenFailure: vi.fn(),
    handleMemoCreated: vi.fn(),
    handleMemoUpdated: vi.fn(),
    handleMemoDeleted: vi.fn(),
    removeBrowserColumnTabsByPath: vi.fn(),
    handleTagsRenamed: vi.fn(),
    handleTagsDeleted: vi.fn(),
    refreshSelectedNotebookMetadata: vi.fn(),
    refreshBackgroundTodoCount: vi.fn(),
  };
}

describe('handleMainWindowMemoEvent', () => {
  it('opens an externally created note from another notebook without changing the current list', () => {
    const actions = createActions('notebook-a');

    handleMainWindowMemoEvent(createdEvent(), actions);

    expect(actions.openPathInBrowserColumn).toHaveBeenCalledWith('notebook-b', 'Created.md');
    expect(actions.handleMemoCreated).not.toHaveBeenCalled();
    expect(actions.refreshSelectedNotebookMetadata).not.toHaveBeenCalled();
    expect(actions.invalidateMentionCaches).toHaveBeenCalledOnce();
  });

  it('opens an externally created note before notebook hydration without touching the list', () => {
    const actions = createActions('');

    handleMainWindowMemoEvent(createdEvent(), actions);

    expect(actions.openPathInBrowserColumn).toHaveBeenCalledWith('notebook-b', 'Created.md');
    expect(actions.handleMemoCreated).not.toHaveBeenCalled();
    expect(actions.refreshSelectedNotebookMetadata).not.toHaveBeenCalled();
  });

  it('does not auto-open AGENTS.md when the watcher reports it as a new note', () => {
    const actions = createActions('notebook-a');
    handleMainWindowMemoEvent(createdEvent({ memo: { ...memo, filename: 'AGENTS.md' } }), actions);
    expect(actions.openPathInBrowserColumn).not.toHaveBeenCalled();
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

    expect(actions.openPathInBrowserColumn).not.toHaveBeenCalled();
    expect(actions.handleMemoCreated).toHaveBeenCalledWith(memo);
    expect(actions.refreshSelectedNotebookMetadata).toHaveBeenCalledWith(event);
  });

  it('opens a user-created note when it belongs to a background notebook', () => {
    const actions = createActions('notebook-a');
    const event = createdEvent({ source: 'user_new' });

    handleMainWindowMemoEvent(event, actions);

    expect(actions.openPathInBrowserColumn).toHaveBeenCalledWith('notebook-b', 'Created.md');
    expect(actions.handleMemoCreated).not.toHaveBeenCalled();
    expect(actions.refreshSelectedNotebookMetadata).not.toHaveBeenCalled();
  });

  it('opens an imported note when it belongs to a background notebook', () => {
    const actions = createActions('notebook-a');
    const event = createdEvent({ source: 'user_import' });

    handleMainWindowMemoEvent(event, actions);

    expect(actions.openPathInBrowserColumn).toHaveBeenCalledWith('notebook-b', 'Created.md');
  });

  it('does not auto-open a template note from a background notebook', () => {
    const actions = createActions('notebook-a');
    const event = createdEvent({ source: 'notebook_template' });

    handleMainWindowMemoEvent(event, actions);

    expect(actions.openPathInBrowserColumn).not.toHaveBeenCalled();
    expect(actions.invalidateMentionCaches).toHaveBeenCalledOnce();
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
    expect(actions.openPathInBrowserColumn).not.toHaveBeenCalled();
  });

  it('reports automatic window-open failures', async () => {
    const error = new Error('window unavailable');
    const actions = createActions('notebook-a');
    vi.mocked(actions.openPathInBrowserColumn).mockRejectedValue(error);

    handleMainWindowMemoEvent(createdEvent(), actions);

    await vi.waitFor(() => expect(actions.reportOpenFailure).toHaveBeenCalledWith(error));
  });

  it('routes tags_renamed to handleTagsRenamed and bypasses memo/replace/refresh paths', () => {
    const actions = createActions('notebook-b');
    const event: MemoEvent = {
      kind: 'tags_renamed',
      notebookId: 'notebook-b',
      renamedTags: [['old', 'new']],
      affectedRelativePaths: ['memo-1', 'memo-2'],
    };

    handleMainWindowMemoEvent(event, actions);

    expect(actions.handleTagsRenamed).toHaveBeenCalledWith(event);
    expect(actions.handleMemoUpdated).not.toHaveBeenCalled();
    expect(actions.handleMemoCreated).not.toHaveBeenCalled();
    expect(actions.handleMemoDeleted).not.toHaveBeenCalled();
    expect(actions.removeBrowserColumnTabsByPath).not.toHaveBeenCalled();
    expect(actions.refreshSelectedNotebookMetadata).not.toHaveBeenCalled();
    expect(actions.refreshBackgroundTodoCount).not.toHaveBeenCalled();
    expect(actions.openPathInBrowserColumn).not.toHaveBeenCalled();
    expect(actions.invalidateMentionCaches).toHaveBeenCalledOnce();
  });

  it('routes tags_renamed to handleTagsRenamed even for background notebooks', () => {
    const actions = createActions('notebook-a');
    const event: MemoEvent = {
      kind: 'tags_renamed',
      notebookId: 'notebook-b',
      renamedTags: [],
      affectedRelativePaths: [],
    };

    handleMainWindowMemoEvent(event, actions);

    expect(actions.handleTagsRenamed).toHaveBeenCalledWith(event);
    expect(actions.refreshBackgroundTodoCount).not.toHaveBeenCalled();
    expect(actions.invalidateMentionCaches).toHaveBeenCalledOnce();
  });

  it('routes tags_deleted to handleTagsDeleted and bypasses memo/replace/refresh paths', () => {
    const actions = createActions('notebook-b');
    const event: MemoEvent = {
      kind: 'tags_deleted',
      notebookId: 'notebook-b',
      deletedTags: ['old', 'old/child'],
      affectedRelativePaths: ['memo-1'],
    };

    handleMainWindowMemoEvent(event, actions);

    expect(actions.handleTagsDeleted).toHaveBeenCalledWith(event);
    expect(actions.handleMemoUpdated).not.toHaveBeenCalled();
    expect(actions.handleMemoCreated).not.toHaveBeenCalled();
    expect(actions.handleMemoDeleted).not.toHaveBeenCalled();
    expect(actions.removeBrowserColumnTabsByPath).not.toHaveBeenCalled();
    expect(actions.refreshSelectedNotebookMetadata).not.toHaveBeenCalled();
    expect(actions.refreshBackgroundTodoCount).not.toHaveBeenCalled();
    expect(actions.openPathInBrowserColumn).not.toHaveBeenCalled();
    expect(actions.invalidateMentionCaches).toHaveBeenCalledOnce();
  });

  it('routes tags_deleted to handleTagsDeleted even for background notebooks', () => {
    const actions = createActions('notebook-a');
    const event: MemoEvent = {
      kind: 'tags_deleted',
      notebookId: 'notebook-b',
      deletedTags: [],
      affectedRelativePaths: [],
    };

    handleMainWindowMemoEvent(event, actions);

    expect(actions.handleTagsDeleted).toHaveBeenCalledWith(event);
    expect(actions.refreshBackgroundTodoCount).not.toHaveBeenCalled();
    expect(actions.invalidateMentionCaches).toHaveBeenCalledOnce();
  });
});
