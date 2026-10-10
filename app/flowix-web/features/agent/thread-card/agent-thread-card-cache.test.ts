import { beforeEach, describe, expect, it, vi } from "vitest";

const agentConversationStoreMock = vi.hoisted(() => ({
  // 测试内部消息 fixture 数据载体 (历史命名); 生产代码已不读 conv-store.
  messageStates: {},
}));
// Phase 5 (2026-08-03): cache helper now reads 唯一真源 threadProjections.
// Mock 这里让 loadMessages 同步更新 threadProjections 的对应 entry, 模拟
// 真实环境会话 store 的历史投影更新行为.
const sessionStoreMock = vi.hoisted(() => ({
  loadMessages: vi.fn(
    async (_typeKey: string, _threadId: string) => undefined,
  ),
  threadProjections: {} as Record<
    string,
    { messages: unknown[]; pagination: object; runs: object }
  >,
  sessionMeta: {
    externalSessionResolutions: {},
    activeAgentTypeKey: "deepseek-harness",
    threadTypes: {},
    threadLists: {},
    currentThreadTitles: {},
    activeThreadIds: {},
    lastRunningRunsReconciledAt: null,
    settings: {
      agentPermissionMode: "danger-full-access",
      agentCodexModel: "inherit",
      agentCodexReasoningEffort: "medium",
    },
  },
}));

vi.mock("@features/agent/store/agent-session-test-facade", () => ({
  useAgentConversationStore: {
    getState: () => agentConversationStoreMock,
  },
}));

vi.mock("@features/agent/store/agent-session-test-facade", () => ({
  useChatStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({})),
  },
}));

vi.mock("@features/agent/store/agent-session-store", () => ({
  useAgentSessionStore: {
    getState: () => sessionStoreMock,
  },
}));

vi.mock("@features/agent/services/external-agent-runtime-service", () => ({
  isLocalExternalThreadId: vi.fn(
    (threadId: string, typeKey: string) =>
      threadId.startsWith(`${typeKey}-pending-`) ||
      threadId.startsWith(`${typeKey}-local-`),
  ),
  resolveExternalSessionId: vi.fn(async () => null),
}));

describe("agent thread card cache helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentConversationStoreMock.messageStates = {};
    sessionStoreMock.threadProjections = {};
    // 模拟 loadMessages 路径: sessionStoreMock.loadMessages 被
    // mock 时, 同步把 messageStates 投影到 sessionStoreMock.threadProjections,
    // 模拟真实环境会话 store 的历史投影更新.
    sessionStoreMock.loadMessages.mockImplementation(
      async (_typeKey, threadId) => {
        const ms = (agentConversationStoreMock.messageStates as Record<
          string,
          { messages: unknown[] }
        >)[threadId];
        if (ms) {
          sessionStoreMock.threadProjections[threadId] = {
            messages: ms.messages,
            pagination: {
              oldestSequence: null,
              hasMoreHistory: false,
              loadingInitial: false,
              loadingMore: false,
            },
            runs: {
              isLoading: false,
              activeRunId: null,
              runs: {},
            },
          };
        }
      },
    );
  });

  it("loads standard thread cache for non external agents", async () => {
    const { loadAgentThreadCardCache } =
      await import("./agent-thread-card-cache");

    const result = await loadAgentThreadCardCache({
      threadId: "flowix-thread",
      typeKey: "deepseek-harness",
    });

    expect(sessionStoreMock.loadMessages).toHaveBeenCalledWith(
      "deepseek-harness",
      "flowix-thread",
    );
    expect(result).toEqual({
      resolvedSessionId: null,
      loadedThreadId: "flowix-thread",
      messages: [],
    });
  });

  it("loads a resolved Codex session before replacing its local id", async () => {
    const { resolveExternalSessionId } =
      await import("@features/agent/services/external-agent-runtime-service");
    vi.mocked(resolveExternalSessionId).mockResolvedValueOnce(
      "codex-real-session",
    );
    const { loadAgentThreadCardCache } =
      await import("./agent-thread-card-cache");

    const result = await loadAgentThreadCardCache({
      threadId: "codex-local-inst-1",
      typeKey: "codex",
    });

    expect(result).toEqual({
      resolvedSessionId: "codex-real-session",
      loadedThreadId: "codex-real-session",
      messages: [],
    });
    expect(sessionStoreMock.loadMessages).toHaveBeenCalledWith(
      "codex",
      "codex-real-session",
    );
  });

  it("loads Codex history for a resolved session id", async () => {
    const { loadAgentThreadCardCache } =
      await import("./agent-thread-card-cache");

    const result = await loadAgentThreadCardCache({
      threadId: "codex-real-session",
      typeKey: "codex",
    });

    expect(sessionStoreMock.loadMessages).toHaveBeenCalledWith(
      "codex",
      "codex-real-session",
    );
    expect(result.loadedThreadId).toBe("codex-real-session");
  });

  it("loads Claude history for a resolved session id", async () => {
    const { loadAgentThreadCardCache } =
      await import("./agent-thread-card-cache");

    const result = await loadAgentThreadCardCache({
      threadId: "claude-real-session",
      typeKey: "claude",
    });

    expect(sessionStoreMock.loadMessages).toHaveBeenCalledWith(
      "claude",
      "claude-real-session",
    );
    expect(result.loadedThreadId).toBe("claude-real-session");
  });

  it("loads OpenCode history from the paginated thread message store", async () => {
    const messages = [
      { id: "user-1", role: "user", content: "hello", timestamp: "1" },
      { id: "assistant-1", role: "assistant", content: "hi", timestamp: "2" },
    ];
    sessionStoreMock.loadMessages.mockImplementationOnce(
      async (typeKey, threadId) => {
        expect(typeKey).toBe("opencode");
        expect(threadId).toBe("opencode-session-1");
        agentConversationStoreMock.messageStates = {
          "opencode-session-1": { messages },
        };
        // Phase 5 (2026-08-03): 同步投到 session-store 真源, 模拟
        // 会话 store 的历史投影更新行为，cache helper 读真源.
        sessionStoreMock.threadProjections["opencode-session-1"] = {
          messages,
          pagination: {
            oldestSequence: null,
            hasMoreHistory: false,
            loadingInitial: false,
            loadingMore: false,
          },
          runs: { isLoading: false, activeRunId: null, runs: {} },
        };
      },
    );
    const { loadAgentThreadCardCache } =
      await import("./agent-thread-card-cache");

    const result = await loadAgentThreadCardCache({
      threadId: "opencode-session-1",
      typeKey: "opencode",
    });

    expect(sessionStoreMock.loadMessages).toHaveBeenCalledWith(
      "opencode",
      "opencode-session-1",
    );
    expect(result.messages).toEqual(messages);
  });
});
