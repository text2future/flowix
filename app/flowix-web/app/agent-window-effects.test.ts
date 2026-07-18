import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useAgentEvents: vi.fn(),
  refreshRuntime: vi.fn(async () => undefined),
  hydrateConversations: vi.fn(async () => undefined),
  loadAccess: vi.fn(async () => undefined),
  listenAccess: vi.fn(),
  unlistenAccess: vi.fn(),
  invalidateNotebookCache: vi.fn(),
  prewarmNotebookCache: vi.fn(async () => undefined),
  invalidateMentionNotes: vi.fn(),
  invalidateMentionTags: vi.fn(),
}));

vi.mock('@features/agent/hooks/use-agent-events', () => ({
  useAgentEvents: mocks.useAgentEvents,
}));
vi.mock('@features/agent/store/agent-runtime-store', () => ({
  useAgentRuntimeStore: (selector: (state: { refresh: typeof mocks.refreshRuntime }) => unknown) => (
    selector({ refresh: mocks.refreshRuntime })
  ),
}));
vi.mock('@features/agent/store/agent-conversation-store', () => ({
  useAgentConversationStore: (
    selector: (state: { hydrateFromBackend: typeof mocks.hydrateConversations }) => unknown,
  ) => selector({ hydrateFromBackend: mocks.hydrateConversations }),
}));
vi.mock('@features/agent/store/agent-access-store', () => ({
  useAgentAccessStore: (selector: (state: { loadInitial: typeof mocks.loadAccess }) => unknown) => (
    selector({ loadInitial: mocks.loadAccess })
  ),
}));
vi.mock('@features/editor/extensions/note-link', () => ({
  invalidateNotebookCache: mocks.invalidateNotebookCache,
  prewarmNotebookCache: mocks.prewarmNotebookCache,
}));
vi.mock('@features/editor/extensions/note-mention', () => ({
  invalidateMentionNotes: mocks.invalidateMentionNotes,
}));
vi.mock('@features/editor/extensions/tag-mention', () => ({
  invalidateMentionTags: mocks.invalidateMentionTags,
}));
vi.mock('@platform/tauri/client', () => ({
  listenToAgentAccessChanges: mocks.listenAccess,
}));

import { AgentWindowEffects } from './agent-window-effects';

describe('AgentWindowEffects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listenAccess.mockReturnValue(mocks.unlistenAccess);
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('owns the shared Agent lifecycle for a content-capable Webview', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(AgentWindowEffects));
    });

    expect(mocks.useAgentEvents).toHaveBeenCalledOnce();
    expect(mocks.refreshRuntime).toHaveBeenCalledWith({ force: true });
    expect(mocks.hydrateConversations).toHaveBeenCalledOnce();
    expect(mocks.loadAccess).toHaveBeenCalledOnce();
    expect(mocks.listenAccess).toHaveBeenCalledOnce();
    expect(mocks.prewarmNotebookCache).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    expect(mocks.unlistenAccess).toHaveBeenCalledOnce();
  });
});
