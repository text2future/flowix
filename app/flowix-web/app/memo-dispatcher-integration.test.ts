import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, createElement, useEffect } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { handleMainWindowMemoEvent } from '@/app/main-window-memo-event-handler';
import type { MemoEvent } from '@/types/memo';

const subscribeMock = vi.hoisted(() => vi.fn());

vi.mock('@platform/tauri/event-bus', () => ({
  subscribe: subscribeMock,
}));

describe('memo dispatcher window isolation', () => {
  beforeEach(() => {
    vi.resetModules();
    subscribeMock.mockReset();
  });

  it('keeps derived-only notifications away from document subscribers and releases handlers', async () => {
    const { memoDispatcher, registerMemoDerivedRefreshHandler } = await import('@/lib/memo-dispatcher');
    const documentHandler = vi.fn();
    const refresh = vi.fn();
    const releaseDocument = memoDispatcher.subscribe(documentHandler);
    const releaseRefresh = registerMemoDerivedRefreshHandler(refresh);
    const event: MemoEvent = {
      kind: 'deleted', id: 'memo', path: '/memo.md', relativePath: 'memo.md', notebookId: 'notebook',
      source: 'external_tool', derivedOnly: true,
      derivedChanged: { tags: true, todos: true, agents: false },
    };
    memoDispatcher.dispatch(event);
    expect(documentHandler).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledWith({ notebookId: 'notebook', derivedChanged: event.derivedChanged });
    releaseRefresh();
    memoDispatcher.dispatch(event);
    expect(refresh).toHaveBeenCalledOnce();
    releaseDocument();
  });

  it('does not connect to Tauri while importing the dispatcher', async () => {
    const { memoDispatcher } = await import('@/lib/memo-dispatcher');

    expect(subscribeMock).not.toHaveBeenCalled();
    expect(memoDispatcher.size()).toBe(0);
  });

  it('shares one Tauri listener and releases it after the final acquire', async () => {
    const unlisten = vi.fn();
    subscribeMock.mockReturnValue(unlisten);
    const { acquireMemoEventBridge } = await import('@/lib/memo-dispatcher');

    const releaseFirst = acquireMemoEventBridge();
    const releaseSecond = acquireMemoEventBridge();

    expect(subscribeMock).toHaveBeenCalledOnce();
    expect(subscribeMock).toHaveBeenCalledWith('memo-event', expect.any(Function));
    releaseFirst();
    releaseFirst();
    expect(unlisten).not.toHaveBeenCalled();
    releaseSecond();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('keeps exactly one live bridge across a StrictMode mount cycle', async () => {
    const actEnvironment = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const liveHandlers = new Set<(event: MemoEvent) => void>();
    let maximumLiveHandlers = 0;
    subscribeMock.mockImplementation((_event, handler) => {
      const typedHandler = handler as (event: MemoEvent) => void;
      liveHandlers.add(typedHandler);
      maximumLiveHandlers = Math.max(maximumLiveHandlers, liveHandlers.size);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        liveHandlers.delete(typedHandler);
      };
    });
    const { acquireMemoEventBridge, memoDispatcher } = await import('@/lib/memo-dispatcher');
    const dispatched = vi.fn();
    const unsubscribe = memoDispatcher.subscribe(dispatched);

    function BridgeOwner() {
      useEffect(() => acquireMemoEventBridge(), []);
      return null;
    }

    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(BridgeOwner)));
    });

    expect(maximumLiveHandlers).toBe(1);
    expect(liveHandlers.size).toBe(1);
    liveHandlers.values().next().value?.({
      kind: 'tags_deleted',
      notebookId: 'test-notebook',
      deletedTags: ['test'],
      affectedRelativePaths: [],
    });
    expect(dispatched).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    expect(liveHandlers.size).toBe(0);
    unsubscribe();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  it('routes a backend external-created event through the bridge to the main window opener', async () => {
    const unlisten = vi.fn();
    let bridge: ((event: MemoEvent) => void) | undefined;
    subscribeMock.mockImplementation((_event, handler) => {
      bridge = handler as (event: MemoEvent) => void;
      return unlisten;
    });
    const { memoDispatcher, acquireMemoEventBridge } = await import('@/lib/memo-dispatcher');
    const releaseBridge = acquireMemoEventBridge();
    const openPathInBrowserColumn = vi.fn().mockResolvedValue(undefined);
    const unsubscribe = memoDispatcher.subscribe((event) => {
      handleMainWindowMemoEvent(event, {
        getSelectedNotebookId: () => 'notebook-a',
        invalidateMentionCaches: vi.fn(),
        openPathInBrowserColumn,
        reportOpenFailure: vi.fn(),
        handleMemoCreated: vi.fn(),
        handleMemoUpdated: vi.fn(),
        handleMemoDeleted: vi.fn(),
        removeBrowserColumnTabsByPath: vi.fn(),
        handleTagsRenamed: vi.fn(),
        handleTagsDeleted: vi.fn(),
        refreshSelectedNotebookMetadata: vi.fn(),
        refreshBackgroundTodoCount: vi.fn(),
      });
    });
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

    expect(openPathInBrowserColumn).toHaveBeenCalledWith('notebook-b', 'External.md');
    unsubscribe();
    releaseBridge();
  });
});
