import { beforeEach, describe, expect, it, vi } from 'vitest';

const chatStoreMock = vi.hoisted(() => ({
  state: {
    externalSessionResolutions: {} as Record<string, string>,
    threadStates: {} as Record<string, { activeRunId: string | null }>,
    setActiveAgentThread: vi.fn(),
  },
}));

const sessionStoreMock = vi.hoisted(() => ({
  state: {
    sessionMeta: {
      activeThreadIds: {} as Record<string, string | undefined>,
      activeAgentTypeKey: "deepseek-harness" as const,
      threadTypes: {},
      externalSessionResolutions: {} as Record<string, string>,
      lastRunningRunsReconciledAt: null,
      threadLists: {},
      currentThreadTitles: {},
      settings: {
        agentPermissionMode: "danger-full-access" as const,
        agentCodexModel: "inherit" as const,
        agentCodexReasoningEffort: "medium" as const,
      },
    },
    threadProjections: {} as Record<string, { runs: { activeRunId: string | null } }>,
    setSessionMeta: vi.fn(),
    dispatch: vi.fn(),
    bindProviderSessionId: vi.fn(),
    stopThreadRun: vi.fn(async () => undefined),
  },
}));

vi.mock('@features/agent/store/agent-session-test-facade', () => ({
  useChatStore: {
    getState: () => chatStoreMock.state,
  },
}));

vi.mock('@features/agent/store/agent-session-store', () => ({
  useAgentSessionStore: {
    getState: () => sessionStoreMock.state,
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
    sessionStoreMock.state.sessionMeta.activeThreadIds = {};
    sessionStoreMock.state.threadProjections = {};
  });

  it('creates a stable local thread id per runtime handle', async () => {
    const {
      beginExternalAgentThreadCardRun,
      createExternalAgentRuntimeHandle,
      getExternalAgentRuntimeThreadId,
    } = await import('./external-agent-runtime-service');
    const handleId = createExternalAgentRuntimeHandle();

    const firstThreadId = beginExternalAgentThreadCardRun(handleId, 'codex', null, 'inst-1');
    const secondThreadId = beginExternalAgentThreadCardRun(handleId, 'codex', null, 'inst-1');

    expect(firstThreadId).toBe('codex-local-inst-1');
    expect(secondThreadId).toBe(firstThreadId);
    expect(getExternalAgentRuntimeThreadId(handleId, null)).toBe(firstThreadId);
    // Phase 4 (2026-08-02): 真源切到 session-store.sessionMeta.activeThreadIds.
    expect(sessionStoreMock.state.setSessionMeta).toHaveBeenCalled();
  });

  it('binds the provider session to the product thread', async () => {
    const {
      applyResolvedExternalSession,
      beginExternalAgentThreadCardRun,
      createExternalAgentRuntimeHandle,
      getExternalAgentRuntimeThreadId,
    } = await import('./external-agent-runtime-service');
    const handleId = createExternalAgentRuntimeHandle();
    const localThreadId = beginExternalAgentThreadCardRun(handleId, 'codex', null, 'inst-1');

    const didApply = applyResolvedExternalSession(
      handleId,
      localThreadId,
      'codex-real-session',
      'codex'
    );

    expect(didApply).toBe(true);
    expect(sessionStoreMock.state.bindProviderSessionId).toHaveBeenCalledWith(
      localThreadId,
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

    await expect(resolveExternalSessionId('codex-local-inst-1', 'codex'))
      .resolves.toBe('codex-real-session');
    await expect(resolveExternalSessionId('claude-local-inst-1', 'claude'))
      .resolves.toBe('claude-real-session');

    expect(agent.getCodexSessionId).toHaveBeenCalledWith('codex-local-inst-1');
    expect(agent.getClaudeSessionId).toHaveBeenCalledWith('claude-local-inst-1');
  });

  it('stops the active run for the current runtime thread id', async () => {
    const {
      beginExternalAgentThreadCardRun,
      createExternalAgentRuntimeHandle,
      stopExternalAgentThreadCardRun,
    } = await import('./external-agent-runtime-service');
    const handleId = createExternalAgentRuntimeHandle();
    const localThreadId = beginExternalAgentThreadCardRun(handleId, 'codex', null, 'inst-1');
    // Phase 4 (2026-08-02): activeRunId 真源是 session-store.threadProjections.
    sessionStoreMock.state.threadProjections[localThreadId] = {
      runs: { activeRunId: "run-1" },
    };

    await stopExternalAgentThreadCardRun(handleId, null);

    expect(sessionStoreMock.state.stopThreadRun).toHaveBeenCalledWith(localThreadId, "run-1");
  });
});
