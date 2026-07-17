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
    openNoteWindow: vi.fn().mockResolvedValue(undefined),
    reportOpenFailure: vi.fn(),
    handleMemoCreated: vi.fn(),
    handleMemoUpdated: vi.fn(),
    handleMemoDeleted: vi.fn(),
    replaceActiveMemoPath: vi.fn(),
    refreshSelectedNotebookMetadata: vi.fn(),
    refreshBackgroundTodoCount: vi.fn(),
  };
}

describe('handleMainWindowMemoEvent', () => {
  it('opens an externally created note from another notebook without changing the current list', () => {
    const actions = createActions('notebook-a');

    handleMainWindowMemoEvent(createdEvent(), actions);

    expect(actions.openNoteWindow).toHaveBeenCalledWith('memo-b');
    expect(actions.handleMemoCreated).not.toHaveBeenCalled();
    expect(actions.refreshSelectedNotebookMetadata).not.toHaveBeenCalled();
    expect(actions.invalidateMentionCaches).toHaveBeenCalledOnce();
  });

  it('opens an externally created note before notebook hydration without touching the list', () => {
    const actions = createActions('');

    handleMainWindowMemoEvent(createdEvent(), actions);

    expect(actions.openNoteWindow).toHaveBeenCalledWith('memo-b');
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

    expect(actions.openNoteWindow).not.toHaveBeenCalled();
    expect(actions.handleMemoCreated).toHaveBeenCalledWith(memo);
    expect(actions.refreshSelectedNotebookMetadata).toHaveBeenCalledWith(event);
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
    expect(actions.openNoteWindow).not.toHaveBeenCalled();
  });

  it('reports automatic window-open failures', async () => {
    const error = new Error('window unavailable');
    const actions = createActions('notebook-a');
    vi.mocked(actions.openNoteWindow).mockRejectedValue(error);

    handleMainWindowMemoEvent(createdEvent(), actions);

    await vi.waitFor(() => expect(actions.reportOpenFailure).toHaveBeenCalledWith(error));
  });
});
