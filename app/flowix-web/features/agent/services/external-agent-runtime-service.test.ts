import { beforeEach, describe, expect, it, vi } from 'vitest';

const chatStoreMock = vi.hoisted(() => ({
  state: {
    externalSessionResolutions: {} as Record<string, string>,
    threadStates: {} as Record<string, { activeRunId: string | null }>,
    setActiveAgentThread: vi.fn(),
    migrateThreadState: vi.fn(),
    stopThreadRun: vi.fn(async () => undefined),
  },
}));

vi.mock('@features/agent/store/chat-store', () => ({
  useChatStore: {
    getState: () => chatStoreMock.state,
  },
}));

vi.mock('@platform/tauri/client', () => ({
  agent: {
    getCodexSessionId: vi.fn(async () => null),
    getClaudeSessionId: vi.fn(async () => null),
  },
}));

describe('external agent runtime service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatStoreMock.state.externalSessionResolutions = {};
    chatStoreMock.state.threadStates = {};
  });

  it('creates a stable pending thread id per runtime handle', async () => {
    const {
      beginExternalAgentThreadCardRun,
      createExternalAgentRuntimeHandle,
      getExternalAgentRuntimeThreadId,
    } = await import('./external-agent-runtime-service');
    const handleId = createExternalAgentRuntimeHandle();

    const firstThreadId = beginExternalAgentThreadCardRun(handleId, 'codex', null);
    const secondThreadId = beginExternalAgentThreadCardRun(handleId, 'codex', null);

    expect(firstThreadId).toMatch(/^codex-pending-/);
    expect(secondThreadId).toBe(firstThreadId);
    expect(getExternalAgentRuntimeThreadId(handleId, null)).toBe(firstThreadId);
    expect(chatStoreMock.state.setActiveAgentThread).toHaveBeenCalledWith('codex', firstThreadId);
  });

  it('migrates pending thread state when the external session is resolved', async () => {
    const {
      applyResolvedExternalSession,
      beginExternalAgentThreadCardRun,
      createExternalAgentRuntimeHandle,
      getExternalAgentRuntimeThreadId,
    } = await import('./external-agent-runtime-service');
    const handleId = createExternalAgentRuntimeHandle();
    const pendingThreadId = beginExternalAgentThreadCardRun(handleId, 'codex', null);

    const didApply = applyResolvedExternalSession(
      handleId,
      pendingThreadId,
      'codex-real-session',
      'codex'
    );

    expect(didApply).toBe(true);
    expect(chatStoreMock.state.migrateThreadState).toHaveBeenCalledWith(
      pendingThreadId,
      'codex-real-session',
      'codex'
    );
    expect(getExternalAgentRuntimeThreadId(handleId, null)).toBeNull();
  });

  it('resolves local Codex and Claude ids through their runtime adapters', async () => {
    const { agent } = await import('@platform/tauri/client');
    const { resolveExternalSessionId } = await import('./external-agent-runtime-service');
    vi.mocked(agent.getCodexSessionId).mockResolvedValueOnce('codex-real-session');
    vi.mocked(agent.getClaudeSessionId).mockResolvedValueOnce('claude-real-session');

    await expect(resolveExternalSessionId('codex-pending-1', 'codex'))
      .resolves.toBe('codex-real-session');
    await expect(resolveExternalSessionId('claude-pending-1', 'claude'))
      .resolves.toBe('claude-real-session');

    expect(agent.getCodexSessionId).toHaveBeenCalledWith('codex-pending-1');
    expect(agent.getClaudeSessionId).toHaveBeenCalledWith('claude-pending-1');
  });

  it('stops the active run for the current runtime thread id', async () => {
    const {
      beginExternalAgentThreadCardRun,
      createExternalAgentRuntimeHandle,
      stopExternalAgentThreadCardRun,
    } = await import('./external-agent-runtime-service');
    const handleId = createExternalAgentRuntimeHandle();
    const pendingThreadId = beginExternalAgentThreadCardRun(handleId, 'codex', null);
    chatStoreMock.state.threadStates[pendingThreadId] = { activeRunId: 'run-1' };

    await stopExternalAgentThreadCardRun(handleId, null);

    expect(chatStoreMock.state.stopThreadRun).toHaveBeenCalledWith(pendingThreadId, 'run-1');
  });
});
