import { beforeEach, describe, expect, it, vi } from 'vitest';

const chatStoreMock = vi.hoisted(() => ({
  setActiveAgentThread: vi.fn(),
  loadThreadList: vi.fn(async () => undefined),
}));

vi.mock('@features/agent/store/chat-store', () => ({
  useChatStore: {
    getState: () => chatStoreMock,
  },
}));

vi.mock('@features/agent/services/external-agent-runtime-service', () => ({
  beginExternalAgentThreadCardRun: vi.fn(() => 'codex-pending-1'),
}));

vi.mock('@platform/tauri/client', () => ({
  agent: {
    createThread: vi.fn(async (title: string) => ({
      threadId: 'flowix-thread-1',
      title,
      createdAt: 1,
      updatedAt: 1,
    })),
  },
}));

describe('agent thread card submit helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a pending runtime thread for external agents', async () => {
    const { beginExternalAgentThreadCardRun } = await import('@features/agent/services/external-agent-runtime-service');
    const { ensureAgentThreadCardThread } = await import('./agent-thread-card-submit');

    const result = await ensureAgentThreadCardThread({
      prompt: 'hello codex',
      fallbackTitle: 'AI',
      typeKey: 'codex',
      currentThreadId: null,
      runtimeHandleId: 'handle-1',
      buildTitle: (prompt) => `Title: ${prompt}`,
    });

    expect(result).toEqual({
      threadId: 'codex-pending-1',
      title: 'Title: hello codex',
      typeKey: 'codex',
    });
    expect(beginExternalAgentThreadCardRun).toHaveBeenCalledWith('handle-1', 'codex', null);
    expect(chatStoreMock.setActiveAgentThread).not.toHaveBeenCalled();
  });

  it('creates and activates a Flowix thread', async () => {
    const { agent } = await import('@platform/tauri/client');
    const { ensureAgentThreadCardThread } = await import('./agent-thread-card-submit');

    const result = await ensureAgentThreadCardThread({
      prompt: 'hello flowix',
      fallbackTitle: 'AI',
      typeKey: 'flowix',
      currentThreadId: null,
      runtimeHandleId: 'handle-1',
      buildTitle: (prompt) => `Title: ${prompt}`,
    });

    expect(agent.createThread).toHaveBeenCalledWith('Title: hello flowix');
    expect(chatStoreMock.setActiveAgentThread).toHaveBeenCalledWith('flowix', 'flowix-thread-1');
    expect(chatStoreMock.loadThreadList).toHaveBeenCalled();
    expect(result).toEqual({
      threadId: 'flowix-thread-1',
      title: 'Title: hello flowix',
      typeKey: 'flowix',
    });
  });
});
