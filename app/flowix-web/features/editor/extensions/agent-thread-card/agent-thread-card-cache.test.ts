import { beforeEach, describe, expect, it, vi } from 'vitest';

const agentConversationStoreMock = vi.hoisted(() => ({
  loadMessages: vi.fn(async () => undefined),
}));

vi.mock('@features/agent/store/agent-conversation-store', () => ({
  useAgentConversationStore: {
    getState: () => agentConversationStoreMock,
  },
}));

vi.mock('@features/agent/services/external-agent-runtime-service', () => ({
  isLocalExternalThreadId: vi.fn((threadId: string, typeKey: string) =>
    threadId.startsWith(`${typeKey}-pending-`) ||
    threadId.startsWith(`${typeKey}-local-`)
  ),
  resolveExternalSessionId: vi.fn(async () => null),
}));

describe('agent thread card cache helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads standard thread cache for non external agents', async () => {
    const { loadAgentThreadCardCache } = await import('./agent-thread-card-cache');

    const result = await loadAgentThreadCardCache({
      threadId: 'flowix-thread',
      typeKey: 'flowix',
    });

    expect(agentConversationStoreMock.loadMessages).toHaveBeenCalledWith(
      'flowix',
      'flowix-thread'
    );
    expect(result).toEqual({
      resolvedSessionId: null,
      loadedThreadId: 'flowix-thread',
    });
  });

  it('returns a resolved Codex session without loading when local id is resolved', async () => {
    const { resolveExternalSessionId } = await import('@features/agent/services/external-agent-runtime-service');
    vi.mocked(resolveExternalSessionId).mockResolvedValueOnce('codex-real-session');
    const { loadAgentThreadCardCache } = await import('./agent-thread-card-cache');

    const result = await loadAgentThreadCardCache({
      threadId: 'codex-local-inst-1',
      typeKey: 'codex',
    });

    expect(result).toEqual({
      resolvedSessionId: 'codex-real-session',
      loadedThreadId: null,
    });
    expect(agentConversationStoreMock.loadMessages).not.toHaveBeenCalled();
  });

  it('loads Codex history for a resolved session id', async () => {
    const { loadAgentThreadCardCache } = await import('./agent-thread-card-cache');

    const result = await loadAgentThreadCardCache({
      threadId: 'codex-real-session',
      typeKey: 'codex',
    });

    expect(agentConversationStoreMock.loadMessages).toHaveBeenCalledWith(
      'codex',
      'codex-real-session'
    );
    expect(result.loadedThreadId).toBe('codex-real-session');
  });

  it('loads Claude history for a resolved session id', async () => {
    const { loadAgentThreadCardCache } = await import('./agent-thread-card-cache');

    const result = await loadAgentThreadCardCache({
      threadId: 'claude-real-session',
      typeKey: 'claude',
    });

    expect(agentConversationStoreMock.loadMessages).toHaveBeenCalledWith(
      'claude',
      'claude-real-session'
    );
    expect(result.loadedThreadId).toBe('claude-real-session');
  });
});
