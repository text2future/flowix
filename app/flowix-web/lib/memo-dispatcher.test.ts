import { describe, expect, it, vi } from 'vitest';
import { handleMainWindowMemoEvent } from '@/app/main-window-memo-event-handler';
import type { MemoEvent } from '@/types/memo';

const subscribeMock = vi.hoisted(() => vi.fn());

vi.mock('@platform/tauri/event-bus', () => ({
  subscribe: subscribeMock,
}));

describe('memo dispatcher window isolation', () => {
  it('installs only the Tauri bridge and no window-specific handlers', async () => {
    const { memoDispatcher } = await import('./memo-dispatcher');

    expect(subscribeMock).toHaveBeenCalledOnce();
    expect(subscribeMock).toHaveBeenCalledWith('memo-event', expect.any(Function));
    expect(memoDispatcher.size()).toBe(0);
  });

  it('routes a backend external-created event through the bridge to the main window opener', async () => {
    const { memoDispatcher } = await import('./memo-dispatcher');
    const openNoteTab = vi.fn().mockResolvedValue(undefined);
    const unsubscribe = memoDispatcher.subscribe((event) => {
      handleMainWindowMemoEvent(event, {
        getSelectedNotebookId: () => 'notebook-a',
        invalidateMentionCaches: vi.fn(),
        openNoteTab,
        reportOpenFailure: vi.fn(),
        handleMemoCreated: vi.fn(),
        handleMemoUpdated: vi.fn(),
        handleMemoDeleted: vi.fn(),
        handleTagsRenamed: vi.fn(),
        replaceActiveMemoPath: vi.fn(),
        refreshSelectedNotebookMetadata: vi.fn(),
        refreshBackgroundTodoCount: vi.fn(),
      });
    });
    const bridge = subscribeMock.mock.calls[0]?.[1] as ((event: MemoEvent) => void) | undefined;

    expect(bridge).toBeTypeOf('function');
    bridge?.({
      kind: 'created',
      memo: {
        id: 'memo-external',
        filename: 'External.md',
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
      },
      notebookId: 'notebook-b',
      derivedChanged: { tags: false, todos: false, agents: false },
      source: 'external_tool',
    });

    expect(openNoteTab).toHaveBeenCalledWith('memo-external');
    unsubscribe();
  });
});
