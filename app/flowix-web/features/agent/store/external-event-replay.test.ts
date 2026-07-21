import { beforeEach, describe, expect, it, vi } from "vitest";

const externalEventsMock = vi.hoisted(() => vi.fn());

vi.mock("@platform/tauri/client", () => ({
  agent: {
    externalEvents: externalEventsMock,
    chatStream: vi.fn(),
    stopChatStream: vi.fn(async () => true),
    runningThreads: vi.fn(async () => ({})),
    listThreads: vi.fn(async () => []),
    listCodexThreads: vi.fn(async () => []),
    listClaudeThreads: vi.fn(async () => []),
    listHermesThreads: vi.fn(async () => []),
    listLocalAgentThreads: vi.fn(async () => []),
    createThread: vi.fn(),
    getThread: vi.fn(async () => ({ messages: [] })),
    getThreadPage: vi.fn(async () => ({
      messages: [],
      oldestSequence: null,
      hasMore: false,
    })),
    getCodexThread: vi.fn(async () => ({ messages: [] })),
    getCodexThreadPage: vi.fn(async () => ({
      messages: [],
      oldestSequence: null,
      hasMore: false,
    })),
    getClaudeThread: vi.fn(async () => ({ messages: [] })),
    getHermesThread: vi.fn(async () => ({ messages: [] })),
    getHermesThreadPage: vi.fn(async () => ({
      messages: [],
      oldestSequence: null,
      hasMore: false,
    })),
    deleteThread: vi.fn(),
    updateThreadTitle: vi.fn(),
    listConversationInstances: vi.fn(async () => []),
    getConversationInstance: vi.fn(async () => null),
    findConversationByThread: vi.fn(async () => null),
    upsertConversationInstance: vi.fn(async () => undefined),
    deleteConversationInstance: vi.fn(async () => undefined),
    deleteConversationInstancesForThread: vi.fn(async () => undefined),
  },
  listenToAgentStream: vi.fn(),
}));

vi.mock("@features/memo/store/memo-store", () => ({
  useMemoStore: {
    getState: () => ({
      selectedNotebook: null,
      selectedMemo: null,
      notebooks: [],
    }),
  },
}));

vi.mock("@features/document", () => ({
  getActiveDocumentDraft: () => null,
  useDocumentStore: {
    getState: () => ({
      currentDocumentPath: "",
    }),
  },
}));

vi.mock("@features/agent/store/agent-access-store", () => ({
  useAgentAccessStore: {
    getState: () => ({
      config: { entries: [] },
    }),
  },
}));

vi.mock("@features/preferences/store/user-settings-store", () => ({
  useUserSettingsStore: {
    getState: () => ({
      settings: { language: "zh-CN" },
    }),
  },
}));

function event(id: number, threadId: string, payload: unknown) {
  return {
    id,
    runtime: "codex",
    threadId,
    normalizedJson: JSON.stringify(payload),
    rawJson: null,
    createdAt: 1_000 + id,
  };
}

describe("external event replay", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
    );
    useChatStore.setState(useChatStore.getInitialState(), true);
    useAgentConversationStore.setState(
      useAgentConversationStore.getInitialState(),
      true,
    );
  });

  it("rebuilds messages and terminal run state from persisted payload events", async () => {
    const { replayExternalEventsForThread } = await import(
      "@features/agent/store/external-event-replay"
    );
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
    );
    const threadId = "codex-replay-thread";
    const runId = "codex-replay-run";

    externalEventsMock.mockResolvedValueOnce([
      event(1, threadId, {
        kind: "stream_start",
        thread_id: threadId,
        run_id: runId,
        agent_type: "codex",
        model: "gpt-5",
      }),
      event(2, threadId, {
        kind: "text",
        thread_id: threadId,
        run_id: runId,
        agent_type: "codex",
        text: "Persisted answer",
      }),
      event(3, threadId, {
        kind: "usage",
        thread_id: threadId,
        run_id: runId,
        agent_type: "codex",
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      }),
      event(4, threadId, {
        kind: "stream_end",
        thread_id: threadId,
        run_id: runId,
        agent_type: "codex",
        reason: null,
      }),
    ]);

    const replayedDisplay = await replayExternalEventsForThread(
      useChatStore.setState,
      useChatStore.getState,
      "codex",
      threadId,
    );

    expect(replayedDisplay).toBe(true);
    expect(externalEventsMock).toHaveBeenCalledWith(threadId, null, 1000);

    const threadState = useChatStore.getState().threadStates[threadId];
    expect(threadState.isLoading).toBe(false);
    expect(threadState.activeRunId).toBeNull();
    expect(threadState.runs[runId]).toBeUndefined();
    expect(threadState.lastRun).toMatchObject({
      runId,
      status: "completed",
      usage: { total_tokens: 7 },
      model: "gpt-5",
    });

    const messages =
      useAgentConversationStore.getState().messageStates[threadId].messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: "Persisted answer",
    });
  });
});
