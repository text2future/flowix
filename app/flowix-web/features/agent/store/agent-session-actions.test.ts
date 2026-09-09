import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChunk } from "@/types/agent";
import { CONTEXT_PROMPT_MARKER } from "@features/agent/message";
import { DEFAULT_AGENT_TYPE_KEY } from "@/lib/agent-types";

const memoStateMock = vi.hoisted(() => ({
  selectedNotebook: null as null | {
    id: string;
    path: string;
    name?: string;
  },
  selectedMemo: null,
  notebooks: [] as Array<unknown>,
}));

const agentAccessMock = vi.hoisted(() => ({
  config: {
    entries: [] as Array<{
      id: string;
      kind: "notebook" | "folder";
      path: string;
      name: string;
      enabled: boolean;
      workspace?: boolean;
      missing: boolean;
    }>,
  } as {
    entries: Array<{
      id: string;
      kind: "notebook" | "folder";
      path: string;
      name: string;
      enabled: boolean;
      workspace?: boolean;
      missing: boolean;
    }>;
    defaults?: {
      files?: Record<
        string,
        { workspace?: string; folders: string[]; notebooks: string[] }
      >;
    };
  },
}));

vi.mock("@platform/tauri/client", () => ({
  agent: {
    chatStream: vi.fn(),
    stopChatStream: vi.fn(async () => true),
    runningThreads: vi.fn(async () => ({})),
    listThreads: vi.fn(async () => []),
    listCodexThreads: vi.fn(async () => []),
    listClaudeThreads: vi.fn(async () => []),
    listHermesThreads: vi.fn(async () => []),
    listLocalAgentThreads: vi.fn(async () => []),
    createThread: vi.fn(async (title: string) => ({
      threadId: "thread-created",
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })),
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
    getClaudeThreadPage: vi.fn(async () => ({
      messages: [],
      oldestSequence: null,
      hasMore: false,
    })),
    listDeepSeekHarnessThreads: vi.fn(async () => []),
    getDeepSeekHarnessThread: vi.fn(async () => ({ messages: [] })),
    getDeepSeekHarnessThreadPage: vi.fn(async () => ({
      messages: [],
      oldestSequence: null,
      hasMore: false,
    })),
    getHermesThread: vi.fn(async () => ({ messages: [] })),
    getHermesThreadPage: vi.fn(async () => ({
      messages: [],
      oldestSequence: null,
      hasMore: false,
    })),
    externalEvents: vi.fn(async () => []),
    deleteThread: vi.fn(),
    archiveAgentThread: vi.fn(async () => undefined),
    deleteAgentThread: vi.fn(async () => undefined),
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
    getState: () => memoStateMock,
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
      config: agentAccessMock.config,
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

async function flushAnimationFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

describe("chat-store Agent Thread Card streaming flow", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    if (typeof requestAnimationFrame !== "function") {
      vi.stubGlobal(
        "requestAnimationFrame",
        (callback: FrameRequestCallback) => {
          return window.setTimeout(() => callback(performance.now()), 0);
        },
      );
      vi.stubGlobal("cancelAnimationFrame", (id: number) =>
        window.clearTimeout(id),
      );
    }

    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    agentAccessMock.config = { entries: [] };
    memoStateMock.selectedNotebook = null;
    useChatStore.setState(useChatStore.getInitialState(), true);
    useAgentConversationStore.setState(
      useAgentConversationStore.getInitialState(),
      true,
    );
    // Phase 2 (2026-08-02): session-store 是新真源, 每个测试必须 reset,
    // 否则跨测试的 threadProjections 通过 mirror 污染 chat-store.
    useAgentSessionStore.setState(useAgentSessionStore.getInitialState(), true);
  });

  it("serializes persistence writes for the same conversation instance", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const persistedTitles: string[] = [];
    vi.mocked(agent.upsertConversationInstance).mockImplementation(
      async (instance) => {
        persistedTitles.push(instance.initialTitle);
        if (persistedTitles.length === 1) await firstPending;
        return { ...instance, threadTitle: instance.initialTitle };
      },
    );

    const instance = useAgentSessionStore.getState().createInstance({
      agentType: "deepseek-harness",
      title: "First title",
      threadId: null,
      source: { kind: "thread-card" },
    });
    useAgentSessionStore.getState().renameInstance(instance.instanceId, "Latest title");

    expect(agent.upsertConversationInstance).toHaveBeenCalledTimes(1);
    releaseFirst();
    await vi.waitFor(() => {
      expect(agent.upsertConversationInstance).toHaveBeenCalledTimes(2);
    });
    expect(persistedTitles).toEqual(["First title", "Latest title"]);
  });

  it("projects live chunks in a tab-host bridge and releases it after the last owner", async () => {
    const { listenToAgentStream } = await import("@platform/tauri/client");
    const { acquireAgentChunkBridge, useChatStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const unlisten = vi.fn();
    let emitChunk!: (chunk: AgentChunk) => void;
    vi.mocked(listenToAgentStream).mockImplementationOnce((handler, options) => {
      emitChunk = handler;
      options?.onListenerReady?.();
      return unlisten;
    });

    const readyA = vi.fn();
    const releaseA = acquireAgentChunkBridge(readyA);
    const releaseB = acquireAgentChunkBridge();
    expect(readyA).toHaveBeenCalledTimes(1);
    expect(listenToAgentStream).toHaveBeenCalledTimes(1);

    const threadId = "tab-host-thread";
    useChatStore.getState().setActiveThreadId(threadId);
    emitChunk({
      kind: "user_message",
      thread_id: threadId,
      id: "user-run-tab-host",
      text: "Question from sibling window",
      timestamp: 100,
      run_id: "run-tab-host",
    });
    emitChunk({ kind: "stream_start", thread_id: threadId, run_id: "run-tab-host" });
    emitChunk({
      kind: "text",
      thread_id: threadId,
      text: "Live child-window reply",
      run_id: "run-tab-host",
    });
    await flushAnimationFrame();

    const running = useChatStore.getState().threadStates[threadId];
    expect(running.isLoading).toBe(true);
    expect(running.messages.map((message) => message.content)).toEqual([
      "Question from sibling window",
      "Live child-window reply",
    ]);

    const { agent } = await import("@platform/tauri/client");
    emitChunk({
      kind: "stream_end",
      thread_id: threadId,
      reason: null,
      run_id: "run-tab-host",
    });
    expect(useChatStore.getState().threadStates[threadId].isLoading).toBe(false);
    await vi.waitFor(() => expect(agent.getDeepSeekHarnessThreadPage).toHaveBeenCalled());

    const codexThreadId = "tab-host-codex-completed";
    useChatStore.getState().bindThreadType(codexThreadId, "codex");
    useChatStore.getState().setActiveAgentThread("codex", codexThreadId);
    emitChunk({
      kind: "stream_start",
      thread_id: codexThreadId,
      run_id: "run-codex-completed",
    });
    // Simulate switching from A to B before A finishes. A's detail releases
    // thread interest and is no longer the active runtime thread, but its
    // resident projection must still trigger completion reconciliation.
    useChatStore.getState().setActiveAgentThread("codex", undefined);
    emitChunk({
      kind: "stream_end",
      thread_id: codexThreadId,
      reason: null,
      run_id: "run-codex-completed",
    });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 350));
    await vi.waitFor(() => expect(agent.getCodexThreadPage).toHaveBeenCalled());

    releaseA();
    expect(unlisten).not.toHaveBeenCalled();
    releaseB();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("refreshes final history when listener recovery finds a locally running thread ended", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    const { reconcileAgentRunsAndRefreshEndedHistory } = await import(
      "@features/agent/hooks/use-agent-events"
    );
    const threadId = "tab-host-ended-during-listener-recovery";
    useChatStore.getState().reconcileRunningRunsFromSnapshot({
      [threadId]: {
        runId: "run-ended-offline",
        agentType: "deepseek-harness",
        startedAt: Date.now() - 10_000,
        currentTool: null,
      },
    });
    vi.mocked(agent.runningThreads).mockResolvedValueOnce({});
    const reconcileCompletedRun = vi
      .spyOn(useAgentSessionStore.getState(), "reconcileCompletedRun")
      .mockResolvedValueOnce();

    await reconcileAgentRunsAndRefreshEndedHistory();

    expect(useChatStore.getState().threadStates[threadId].isLoading).toBe(false);
    expect(reconcileCompletedRun).toHaveBeenCalledWith(
      "deepseek-harness",
      threadId,
      "run-ended-offline",
    );
  });

  it("still refreshes active history when the running-thread snapshot is unavailable", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    const { reconcileAgentRunsAndRefreshEndedHistory } = await import(
      "@features/agent/hooks/use-agent-events"
    );
    const threadId = "active-history-after-ipc-failure";
    useChatStore.setState({
      activeThreadIds: { "deepseek-harness": threadId },
      threadTypes: { [threadId]: "deepseek-harness" },
    });
    vi.mocked(agent.runningThreads).mockRejectedValueOnce(
      new Error("ipc://localhost/agent_running_threads was blocked"),
    );
    const loadMessages = vi
      .spyOn(useAgentSessionStore.getState(), "loadMessages")
      .mockResolvedValueOnce();

    await reconcileAgentRunsAndRefreshEndedHistory();

    expect(loadMessages).toHaveBeenCalledWith("deepseek-harness", threadId);
  });

  it("routes streamed assistant text into the same thread state consumed by Thread Card", async () => {
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const store = useChatStore.getState();
    const threadId = "thread-card-flowix";

    store.bindThreadType(threadId, "deepseek-harness");
    store.dispatchAgentChunk({ kind: "stream_start", thread_id: threadId });
    store.dispatchAgentChunk({
      kind: "text",
      thread_id: threadId,
      text: "Hel",
    });
    store.dispatchAgentChunk({ kind: "text", thread_id: threadId, text: "lo" });

    await flushAnimationFrame();

    const threadState = useChatStore.getState().threadStates[threadId];
    expect(threadState.isLoading).toBe(true);
    expect(threadState.messages).toHaveLength(1);
    expect(threadState.messages[0]).toMatchObject({
      role: "assistant",
      content: "Hello",
    });
    expect(
      useAgentConversationStore.getState().messageStates[threadId]?.messages[0],
    ).toMatchObject({
      role: "assistant",
      content: "Hello",
    });
    expect(
      useAgentConversationStore.getState().messageStates[threadId]
        ?.pendingAssistantId,
    ).toBe(threadState.pendingAssistantId);

    store.dispatchAgentChunk({
      kind: "stream_end",
      thread_id: threadId,
      reason: null,
    });

    const idleState = useChatStore.getState().threadStates[threadId];
    expect(idleState.isLoading).toBe(false);
    expect(idleState.activeRunId).toBeNull();
    expect(Object.values(idleState.runs)).toHaveLength(0);
    // Phase 2 (2026-08-02): projection 是单一真源, stream_end 不再清 messages.
    // 旧 releaseThreadRuntimeMessages 在 dual-write 时代释放大 tool_data 以省内存,
    // 在 single-source 架构下不再需要; message 由 session-store 持久投影 + mirror 同步.
    expect(idleState.messages).toMatchObject([{ role: "assistant", content: "Hello" }]);
    expect(
      useAgentConversationStore.getState().messageStates[threadId]?.messages[0],
    ).toMatchObject({
      role: "assistant",
      content: "Hello",
    });
    expect(
      useAgentConversationStore.getState().messageStates[threadId]
        ?.pendingAssistantId,
    ).toBeNull();
  });

  it("syncs optimistic user messages into the render message state before chunks arrive", async () => {
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const { selectRenderableThreadMessages } = await import(
      "@features/agent/store/thread-render-messages"
    );
    const store = useChatStore.getState();
    const threadId = "thread-card-optimistic-user";

    await store.sendMessageToThread(threadId, "Hello from user", "deepseek-harness");

    const renderMessages =
      useAgentConversationStore.getState().messageStates[threadId]?.messages ??
      [];
    expect(renderMessages).toHaveLength(1);
    expect(renderMessages[0]).toMatchObject({
      role: "user",
    });
    expect(renderMessages[0].content).toContain("Hello from user");
    expect(
      selectRenderableThreadMessages({ typeKey: "deepseek-harness", threadId }),
    ).toBe(renderMessages);
  });

  it("does not let a non-active thread-card send overwrite the active title", async () => {
    const { useChatStore, useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const activeThreadId = "thread-card-active-title";
    const cardThreadId = "thread-card-secondary-title";
    const cardInstance = useAgentConversationStore.getState().createInstance({
      agentType: "deepseek-harness",
      title: "B title",
      threadId: cardThreadId,
      source: { kind: "thread-card" },
    });

    useChatStore.setState({
      activeThreadIds: { "deepseek-harness": activeThreadId },
      currentThreadTitles: { [activeThreadId]: "A title" },
    });

    await useChatStore.getState().sendMessageToThread(
      cardThreadId,
      "message from B",
      "deepseek-harness",
      {
        instanceId: cardInstance.instanceId,
        conversationTitle: "B title",
        isFirstMessage: true,
      },
    );

    expect(useChatStore.getState().currentThreadTitles[activeThreadId]).toBe("A title");
    expect(useChatStore.getState().threadLists["deepseek-harness"]).toEqual([]);
    expect(
      useAgentConversationStore
        .getState()
        .getInstance(cardInstance.instanceId)?.title,
    ).toBe("B title");
  });

  it("uses canonical render messages to detect non-first follow-up sends", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const threadId = "thread-follow-up-after-runtime-release";

    useAgentConversationStore.getState().syncRenderableMessages("deepseek-harness", threadId, [
      {
        id: "history-user",
        role: "user",
        content: "previous",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ]);

    await useChatStore.getState().sendMessageToThread(
      threadId,
      "follow up from canonical",
      "deepseek-harness",
      {
        currentNoteContent: "note context should not be appended",
      },
    );

    const calls = vi.mocked(agent.chatStream).mock.calls;
    const [, payload] = calls[calls.length - 1]!;
    expect(payload.llmContent).toBe("follow up from canonical");
    expect(payload.llmContent).not.toContain(CONTEXT_PROMPT_MARKER);
  });

  it("applies low-frequency chunks against conversation live messages", async () => {
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const threadId = "thread-low-frequency-conversation-live";
    const toolCallId = "tool-live-state";

    useChatStore.getState().bindThreadType(threadId, "deepseek-harness");
    useAgentConversationStore.getState().syncLiveMessageState("deepseek-harness", threadId, {
      messages: [
        {
          id: `tool-${toolCallId}`,
          role: "tool",
          content: "",
          timestamp: "2026-01-01T00:00:00.000Z",
          toolCallId,
          toolName: "Read",
          isLoading: true,
        },
      ],
      pendingAssistantId: null,
      pendingReasoningId: null,
    });

    useChatStore.getState().dispatchAgentChunk({
      kind: "tool_result",
      thread_id: threadId,
      run_id: "run-low-frequency-live",
      id: toolCallId,
      name: "Read",
      result: { content: "file contents from conversation state" },
      agent_type: "deepseek-harness",
    });

    const message =
      useAgentConversationStore.getState().messageStates[threadId].messages[0];
    expect(message).toMatchObject({
      role: "tool",
      toolCallId,
      content: "file contents from conversation state",
      isLoading: false,
    });
    expect(
      useChatStore.getState().threadStates[threadId].messages[0],
    ).toMatchObject({
      content: "file contents from conversation state",
      isLoading: false,
    });
  });

  it("keeps Claude reasoning in one run-scoped row across a tool cycle", async () => {
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const threadId = "claude-live-reasoning-tool-cycle";
    const runId = "claude-live-reasoning-run";
    const store = useChatStore.getState();

    store.bindThreadType(threadId, "claude");
    const chunks: AgentChunk[] = [
      {
        kind: "stream_start",
        thread_id: threadId,
        run_id: runId,
        agent_type: "claude",
      },
      {
        kind: "reasoning",
        thread_id: threadId,
        run_id: runId,
        agent_type: "claude",
        text: "first thought\n\n",
        message_id: "reasoning-provider-message-1-block-0",
        message_phase: "updated",
        content_mode: "delta",
        source_timestamp: 1_000,
        source_sequence: 1,
        source_subsequence: 0,
      },
      {
        kind: "tool_call",
        thread_id: threadId,
        run_id: runId,
        agent_type: "claude",
        id: "tool-cycle-1",
        name: "Bash",
        input: { command: "pwd" },
        message_id: "tool-tool-cycle-1",
        message_phase: "started",
        source_timestamp: 1_100,
        source_sequence: 2,
        source_subsequence: 0,
      },
      {
        kind: "tool_result",
        thread_id: threadId,
        run_id: runId,
        agent_type: "claude",
        id: "tool-cycle-1",
        name: "Bash",
        result: { content: "/workspace" },
        message_id: "tool-tool-cycle-1",
        message_phase: "completed",
        source_timestamp: 1_200,
        source_sequence: 3,
        source_subsequence: 0,
      },
      {
        kind: "reasoning",
        thread_id: threadId,
        run_id: runId,
        agent_type: "claude",
        text: "second thought",
        message_id: "reasoning-provider-message-2-block-0",
        message_phase: "updated",
        content_mode: "delta",
        source_timestamp: 1_300,
        source_sequence: 4,
        source_subsequence: 0,
      },
      {
        kind: "text",
        thread_id: threadId,
        run_id: runId,
        agent_type: "claude",
        text: "final answer",
        message_id: "assistant-provider-message-2-block-1",
        message_phase: "updated",
        content_mode: "delta",
        source_timestamp: 1_400,
        source_sequence: 5,
        source_subsequence: 0,
      },
      {
        kind: "stream_end",
        thread_id: threadId,
        run_id: runId,
        agent_type: "claude",
        reason: null,
      },
    ];

    chunks.forEach((chunk) => store.dispatchAgentChunk(chunk));
    store.flushAgentEventBuffer();

    const messages =
      useAgentConversationStore.getState().messageStates[threadId].messages;
    const reasoning = messages.filter((message) => message.role === "reasoning");
    const tools = messages.filter((message) => message.role === "tool");

    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]).toMatchObject({
      id: `msg:claude:${runId}:reasoning:reasoning-${runId}`,
      content: "first thought\n\nsecond thought",
      isCompleted: true,
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      toolCallId: `msg:claude:${runId}:tool-call:tool-cycle-1`,
      isLoading: false,
    });
    expect(messages.map((message) => message.role)).toEqual([
      "reasoning",
      "tool",
      "assistant",
    ]);
    expect(messages[2]).toMatchObject({ content: "final answer" });
    expect(useChatStore.getState().threadStates[threadId]).toMatchObject({
      isLoading: false,
      activeRunId: null,
      lastRun: { runId, status: "completed" },
    });
  });

  it("completes a Claude reasoning-only row when the stream ends", async () => {
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const threadId = "claude-reasoning-only-end";
    const runId = "claude-reasoning-only-run";
    const store = useChatStore.getState();

    store.bindThreadType(threadId, "claude");
    store.dispatchAgentChunk({
      kind: "stream_start",
      thread_id: threadId,
      run_id: runId,
      agent_type: "claude",
    });
    store.dispatchAgentChunk({
      kind: "reasoning",
      thread_id: threadId,
      run_id: runId,
      agent_type: "claude",
      text: "reasoning without final text",
      message_id: "reasoning-provider-message-only-block-0",
      message_phase: "updated",
      content_mode: "delta",
    });
    store.dispatchAgentChunk({
      kind: "stream_end",
      thread_id: threadId,
      run_id: runId,
      agent_type: "claude",
      reason: null,
    });

    const messageState =
      useAgentConversationStore.getState().messageStates[threadId];
    expect(messageState.messages).toMatchObject([
      {
        id: `msg:claude:${runId}:reasoning:reasoning-${runId}`,
        role: "reasoning",
        content: "reasoning without final text",
        isCompleted: true,
      },
    ]);
    expect(messageState.pendingReasoningId).toBeNull();
  });

  it("folds legacy Claude envelope text ids without crossing a tool boundary", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const threadId = "claude-live-envelope-text";
    const runId = "claude-live-envelope-run";
    const store = useChatStore.getState();

    store.bindThreadType(threadId, "claude");
    const chunks: AgentChunk[] = [
      {
        kind: "stream_start",
        thread_id: threadId,
        run_id: runId,
        agent_type: "claude",
      },
      ...[
        ["d9193ae4-86b5-47a6-9e85-1bb4ef0acc1c", "first "],
        ["63038373-bb9a-446d-a640-6ea503e68857", "answer"],
      ].map(
        ([envelopeId, text], index): AgentChunk => ({
          kind: "text",
          thread_id: threadId,
          run_id: runId,
          agent_type: "claude",
          text,
          message_id: `assistant-${envelopeId}-block-1`,
          message_phase: "updated",
          content_mode: "delta",
          source_timestamp: 1_000 + index,
          source_sequence: 10 + index,
          source_subsequence: 0,
        }),
      ),
      {
        kind: "tool_call",
        thread_id: threadId,
        run_id: runId,
        agent_type: "claude",
        id: "legacy-text-tool",
        name: "Bash",
        input: { command: "pwd" },
        message_id: "tool-legacy-text-tool",
        message_phase: "started",
        source_timestamp: 1_500,
        source_sequence: 15,
        source_subsequence: 0,
      },
      {
        kind: "tool_result",
        thread_id: threadId,
        run_id: runId,
        agent_type: "claude",
        id: "legacy-text-tool",
        name: "Bash",
        result: { content: "/workspace" },
        message_id: "tool-legacy-text-tool",
        message_phase: "completed",
        source_timestamp: 1_600,
        source_sequence: 16,
        source_subsequence: 0,
      },
      ...[
        ["b144b154-8e2a-4362-9dfc-c40c3ccfcda0", "second "],
        ["3392bebc-236e-40e0-81b1-6b2da4e64653", "answer"],
      ].map(
        ([envelopeId, text], index): AgentChunk => ({
          kind: "text",
          thread_id: threadId,
          run_id: runId,
          agent_type: "claude",
          text,
          message_id: `assistant-${envelopeId}-block-1`,
          message_phase: "updated",
          content_mode: "delta",
          source_timestamp: 2_000 + index,
          source_sequence: 20 + index,
          source_subsequence: 0,
        }),
      ),
      {
        kind: "stream_end",
        thread_id: threadId,
        run_id: runId,
        agent_type: "claude",
        reason: null,
      },
    ];

    chunks.forEach((chunk) => store.dispatchAgentChunk(chunk));
    store.flushAgentEventBuffer();
    now.mockRestore();

    const messages =
      useAgentConversationStore.getState().messageStates[threadId].messages;
    expect(messages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(messages[0].content).toBe("first answer");
    expect(messages[2].content).toBe("second answer");
    expect(messages[0].id).not.toBe(messages[2].id);
    expect(messages[0].sourceSequence).toBe(10);
    expect(messages[1].sourceSequence).toBe(15);
    expect(messages[2].sourceSequence).toBe(20);
  });

  it("applies buffered text chunks against conversation live messages", async () => {
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    const threadId = "thread-buffered-conversation-live";

    useChatStore.getState().bindThreadType(threadId, "deepseek-harness");
    // Phase 2 (2026-08-02): session-store 是真源, 直接 seed 它. mirror 会自动
    // 把同步状态写到 conv-store 与 chat-store, 断言仍走两个老 store.
    useAgentSessionStore.getState().setThreadProjection(threadId, (p) => ({
      ...p,
      messages: [
        {
          id: "assistant-live",
          role: "assistant",
          content: "Hello ",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
      pending: { assistantId: "assistant-live", reasoningId: null },
    }));

    useChatStore.getState().dispatchAgentChunk({
      kind: "text",
      thread_id: threadId,
      run_id: "run-buffered-live",
      text: "world",
      agent_type: "deepseek-harness",
    });

    await flushAnimationFrame();

    const conversationState =
      useAgentConversationStore.getState().messageStates[threadId];
    expect(conversationState.messages).toHaveLength(1);
    expect(conversationState.messages[0]).toMatchObject({
      id: "assistant-live",
      content: "Hello world",
    });
    expect(conversationState.pendingAssistantId).toBe("assistant-live");
    expect(useChatStore.getState().threadStates[threadId].messages).toEqual(
      conversationState.messages,
    );
  });

  it("restores running state from non-terminal chunks when stream_start was missed", async () => {
    const { useChatStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const store = useChatStore.getState();
    const threadId = "thread-card-missed-start";

    store.bindThreadType(threadId, "deepseek-harness");
    store.dispatchAgentChunk({
      kind: "text",
      thread_id: threadId,
      run_id: "run-restored",
      agent_type: "deepseek-harness",
      text: "still running",
    });

    await flushAnimationFrame();

    const state = useChatStore.getState();
    const threadState = state.threadStates[threadId];
    expect(threadState.isLoading).toBe(true);
    expect(threadState.activeRunId).toBe("run-restored");
    expect(threadState.runs["run-restored"]?.status).toBe("running");
    expect(threadState.messages[0]?.content).toBe("still running");
  });

  it("reconciles running thread state from backend snapshot", async () => {
    const { useChatStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const store = useChatStore.getState();
    const threadId = "thread-card-snapshot-running";

    store.bindThreadType(threadId, "codex");
    store.reconcileRunningRunsFromSnapshot({
      [threadId]: {
        runId: "run-snapshot",
        agentType: "codex",
        startedAt: 1234,
        currentTool: "shell",
      },
    });

    const state = useChatStore.getState();
    const threadState = state.threadStates[threadId];
    expect(threadState.isLoading).toBe(true);
    expect(threadState.activeRunId).toBe("run-snapshot");
    expect(threadState.runs["run-snapshot"]?.currentTool).toBe("shell");
    expect(state.lastRunningRunsReconciledAt).toEqual(expect.any(Number));
  });

  it("migrates conversation messages when backend snapshot resolves a pending thread", async () => {
    const { useChatStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const localThreadId = "codex-local-snapshot-pending";
    const sessionId = "codex-session-snapshot-pending";

    useAgentConversationStore.getState().syncLiveMessageState(
      "codex",
      localThreadId,
      {
        messages: [
          {
            id: "assistant-snapshot-pending",
            role: "assistant",
            content: "snapshot restored pending message",
            timestamp: "2026-01-01T00:00:00.000Z",
          },
        ],
        pendingAssistantId: "assistant-snapshot-pending",
        pendingReasoningId: null,
      },
    );
    useChatStore.getState().bindThreadType(localThreadId, "codex");

    useChatStore.getState().reconcileRunningRunsFromSnapshot({
      [sessionId]: {
        runId: "run-snapshot-pending",
        agentType: "codex",
        pendingThreadId: localThreadId,
        sessionId,
        startedAt: 1234,
        currentTool: "shell",
      },
    });

    const chatState = useChatStore.getState();
    expect(chatState.externalSessionResolutions[localThreadId]).toBe(sessionId);
    expect(chatState.threadStates[localThreadId]).toMatchObject({
      isLoading: true,
      activeRunId: "run-snapshot-pending",
    });
    expect(chatState.threadStates[localThreadId].messages[0]).toMatchObject({
      id: "assistant-snapshot-pending",
      content: "snapshot restored pending message",
    });

    const messageState =
      useAgentConversationStore.getState().messageStates[localThreadId];
    expect(messageState.messages[0]).toMatchObject({
      id: "assistant-snapshot-pending",
      content: "snapshot restored pending message",
    });
    expect(messageState.pendingAssistantId).toBe("assistant-snapshot-pending");
  });

  it("reconciles Agent conversation instances from backend running snapshot", async () => {
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const threadId = "thread-snapshot-instance-running";

    useChatStore.getState().setThreadList([
      {
        threadId,
        title: "Snapshot restored title",
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    useChatStore.getState().reconcileRunningRunsFromSnapshot({
      [threadId]: {
        runId: "run-snapshot-instance-running",
        agentType: "deepseek-harness",
        startedAt: 1234,
        currentTool: "shell",
      },
    });

    expect(useAgentConversationStore.getState().findByThreadId(threadId)).toMatchObject({
      agentType: "deepseek-harness",
      title: "Snapshot restored title",
      threadId,
      source: { kind: "thread-card" },
    });
    expect(useChatStore.getState().threadStates[threadId].runs[
      "run-snapshot-instance-running"
    ]).toMatchObject({
      runId: "run-snapshot-instance-running",
      status: "running",
      currentTool: "shell",
    });
  });

  it("does not replace an existing external conversation title with the default snapshot title", async () => {
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const threadId = "codex-session-title-preserved";
    const instance = useAgentConversationStore.getState().createInstance({
      agentType: "codex",
      title: "Analyze agent thread card title",
      threadId,
      source: { kind: "thread-card" },
    });

    useChatStore.getState().bindThreadType(threadId, "codex");
    useChatStore.getState().reconcileRunningRunsFromSnapshot({
      [threadId]: {
        runId: "run-title-preserved",
        agentType: "codex",
        startedAt: 1234,
        currentTool: null,
      },
    });

    expect(
      useAgentConversationStore.getState().getInstance(instance.instanceId)
        ?.title,
    ).toBe("Analyze agent thread card title");
  });

  it("syncs usage totals into Agent conversation run when usage arrives", async () => {
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const threadId = "thread-usage-instance-sync";
    const runId = "run-usage-instance-sync";

    const instance = useAgentConversationStore.getState().createInstance({
      agentType: "codex",
      title: "Usage sync",
      threadId,
      source: { kind: "thread-card" },
    });

    useChatStore.getState().bindThreadType(threadId, "codex");
    useChatStore.getState().dispatchAgentChunk({
      kind: "stream_start",
      thread_id: threadId,
      run_id: runId,
      agent_type: "codex",
      model: "gpt-5.5",
    });
    useChatStore.getState().dispatchAgentChunk({
      kind: "usage",
      thread_id: threadId,
      run_id: runId,
      agent_type: "codex",
      usage: {
        input_tokens: 30,
        cached_input_tokens: 10,
        output_tokens: 12,
        reasoning_output_tokens: 0,
        total_tokens: 42,
      },
    });

    const threadState = useChatStore.getState().threadStates[threadId];
    expect(threadState.runs[runId]?.usage?.total_tokens).toBe(42);

    useChatStore.getState().dispatchAgentChunk({
      kind: "stream_end",
      thread_id: threadId,
      run_id: runId,
      agent_type: "codex",
      reason: null,
    });
    expect(
      useChatStore.getState().threadStates[threadId].lastRun?.usage?.total_tokens,
    ).toBe(42);

    expect(
      useAgentConversationStore.getState().getInstance(instance.instanceId),
    ).toMatchObject({ threadId, agentType: "codex" });
  });

  it("removes stale local running state when backend snapshot is empty", async () => {
    const { useChatStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const store = useChatStore.getState();
    const threadId = "thread-card-stale-running";

    store.bindThreadType(threadId, "deepseek-harness");
    store.dispatchAgentChunk({
      kind: "stream_start",
      thread_id: threadId,
      run_id: "run-stale",
    });
    expect(useChatStore.getState().threadStates[threadId].isLoading).toBe(true);
    useChatStore.setState((state) => ({
      threadStates: {
        ...state.threadStates,
        [threadId]: {
          ...state.threadStates[threadId],
          runs: {
            ...state.threadStates[threadId].runs,
            "run-stale": {
              ...state.threadStates[threadId].runs["run-stale"],
              startedAt: Date.now() - 10_000,
            },
          },
        },
      },
    }));

    store.reconcileRunningRunsFromSnapshot({});

    const state = useChatStore.getState();
    const threadState = state.threadStates[threadId];
    expect(threadState.isLoading).toBe(false);
    expect(threadState.activeRunId).toBeNull();
    expect(Object.values(threadState.runs)).toHaveLength(0);
    expect(threadState.lastRun).toMatchObject({
      runId: "run-stale",
      status: "failed",
      reason: "missing_from_snapshot",
    });
  });

  it("keeps optimistic local run during backend snapshot grace window", async () => {
    const { useChatStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const store = useChatStore.getState();
    const threadId = "thread-card-optimistic-run";

    store.bindThreadType(threadId, "deepseek-harness");
    await store.sendMessageToThread(threadId, "hello optimistic", "deepseek-harness");
    expect(useChatStore.getState().threadStates[threadId].isLoading).toBe(true);

    store.reconcileRunningRunsFromSnapshot({});

    const state = useChatStore.getState();
    const threadState = state.threadStates[threadId];
    expect(threadState.isLoading).toBe(true);
    expect(threadState.activeRunId).toEqual(expect.any(String));
  });

  it("honors caller-provided non-first-message state when preparing llmContent", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const threadId = "codex-session-with-history-only";

    await useChatStore.getState().sendMessageToThread(
      threadId,
      "follow up",
      "codex",
      {
        currentNoteContent: "note context should not be appended",
        isFirstMessage: false,
      },
    );

    const calls = vi.mocked(agent.chatStream).mock.calls;
    const [, payload] = calls[calls.length - 1]!;
    expect(payload.llmContent).toBe("follow up");
    expect(payload.llmContent).not.toContain(CONTEXT_PROMPT_MARKER);
  });

  it("鈶?deleteThread clears in-memory messages and runs", async () => {
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const store = useChatStore.getState();
    const threadId = "thread-delete-clears-state";

    // 鍒涘缓涓€涓湁 content 鐨?thread, 鐒跺悗 dispatch 涓€浜?chunk 璁?threadStates
    // 绱Н messages / runs 鈹€鈹€ 杩欐槸 deleteThread 涔嬪墠鐨勭姸鎬併€?  
    store.bindThreadType(threadId, "deepseek-harness");
    store.dispatchAgentChunk({
      kind: "stream_start",
      thread_id: threadId,
      run_id: "run-1",
    });
    store.dispatchAgentChunk({
      kind: "text",
      thread_id: threadId,
      run_id: "run-1",
      text: "answer body that should be wiped on delete",
      agent_type: "deepseek-harness",
    });
    store.dispatchAgentChunk({
      kind: "tool_call",
      thread_id: threadId,
      run_id: "run-1",
      id: "call-x",
      name: "read",
      input: {},
      agent_type: "deepseek-harness",
    });

    // rAF flush 璁?text chunk 鐪熸钀藉埌 messages / pendingAssistantId 涓?    // (涓?`routes streamed assistant text` 娴嬭瘯鍚屽舰 鈹€ 绂昏繖鍧楃殑璇?text
    // 浠嶇暀鍦?textBuffer 閲? before / after 鏂█浼氬洜鏃跺簭涓嶄竴鑷存姈鍔?銆?  
    await flushAnimationFrame();

    const before = useChatStore.getState().threadStates[threadId];
    expect(before.messages.length).toBeGreaterThan(0);
    expect(Object.keys(before.runs)).toContain("run-1");
    expect(before.isLoading).toBe(true);
    // pendingAssistantId 鍦?tool_call 涔嬪悗琚噸缃?鈹€鈹€ 杩欐槸璁捐琛屼负:
    // tool_call 涔嬪墠鍒?tool_result 涔嬮棿鐨?assistant 琛屼笉杩炵画銆?    // 鎴戜滑鍏冲績鐨勬槸"鍒犻櫎鍓?has accumulated state",鐢?messages 鏁?+ runs
    // 闀垮害宸茬粡鑳介獙璇併€?杩欓噷鍙獙璇?runs 鏈夎繍琛屾€?(activeRunId + status=running)銆?  
    expect(before.activeRunId).toBe("run-1");
    expect(before.runs["run-1"]?.status).toBe("running");

    await store.deleteThread(threadId);

    // Canonical projection is removed completely after backend deletion.
    const after = useChatStore.getState().threadStates[threadId];
    expect(after).toBeUndefined();
  });

  it("deleteThread clears threadTypes and reverse-mapped externalSessionResolutions", async () => {
    // 淇 #7: deleteThread 涔嬪墠娌℃竻 `state.threadTypes[threadId]`, 鐣欎笅瀛ゅ効
    // 鏉＄洰 鈹€鈹€ 鍚庣画 `get().threadTypes[threadId] ?? "deepseek-harness"` 浼氭嬁鍒版棫 type,
    // 璇垽 dispatch 璺緞銆?鍚屾椂鍙嶅悜鏄犲皠 `externalSessionResolutions[local] === threadId`
    // (鍗?local id 宸茬粡琚?resolve 鍒拌繖涓鍒犵殑 thread) 涔熻娓? 鍚﹀垯 findByThreadId
    // 浼氳鍛戒腑宸插垹 id銆?  
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const store = useChatStore.getState();
    const threadId = "thread-delete-cleans-thread-types";
    const localThreadId = "codex-local-agent-inst-orphan";

    store.bindThreadType(threadId, "codex");
    // 妯℃嫙涓€涓?local 鈫?session 宸?resolve 杩囩殑鐘舵€? 涓?session === threadId
    // (鏈湴 thread id 鏄?`${type}-local-${instanceId}`,
    // resolve 鍚庡彉鎴愮湡瀹?session_id, 姝ゆ椂 local id 浠嶇劧浣滀负 mapping 鐣欏湪
    // externalSessionResolutions 閲?銆?  
    useChatStore.setState((state) => ({
      ...state,
      externalSessionResolutions: {
        ...state.externalSessionResolutions,
        [localThreadId]: threadId, // 鍙嶅悜鏄犲皠鎸囧悜琚垹 thread
      },
    }));

    await store.deleteThread(threadId);

    const state = useChatStore.getState();
    // threadTypes 娓呯悊
    expect(state.threadTypes[threadId]).toBeUndefined();
    // 鍙嶅悜鏄犲皠娓呯悊 鈹€鈹€ `findByThreadId(threadId)` 涓嶅啀鍛戒腑宸插垹 entry銆?  
    expect(
      state.externalSessionResolutions[localThreadId],
    ).toBeUndefined();
  });

  it("does not revive a deleted projection when an initial history request resolves late", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    const threadId = "deleted-while-history-loading";
    let resolvePage!: (page: {
      messages: [];
      oldestSequence: null;
      hasMore: boolean;
    }) => void;
    vi.mocked(agent.getCodexThreadPage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePage = resolve;
        }),
    );

    const loading = useAgentSessionStore
      .getState()
      .loadMessages("codex", threadId);
    await vi.waitFor(() => {
      expect(
        useAgentSessionStore.getState().threadProjections[threadId]?.pagination
          .loadingInitial,
      ).toBe(true);
    });

    await useAgentSessionStore.getState().deleteThread(threadId);
    resolvePage({ messages: [], oldestSequence: null, hasMore: false });
    await loading;

    expect(
      useAgentSessionStore.getState().threadProjections[threadId],
    ).toBeUndefined();
    expect(useAgentSessionStore.getState().threadTombstones[threadId]).toBe(true);
  });

  it("drops stream chunks that arrive after a thread was deleted", async () => {
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    const threadId = "deleted-before-late-stream";
    await useAgentSessionStore.getState().deleteThread(threadId);

    useAgentSessionStore.getState().dispatchAgentChunk({
      kind: "stream_start",
      thread_id: threadId,
      run_id: "late-run",
      agent_type: "codex",
    });
    useAgentSessionStore.getState().dispatchAgentChunk({
      kind: "text",
      thread_id: threadId,
      run_id: "late-run",
      agent_type: "codex",
      text: "must be ignored",
    });
    await flushAnimationFrame();

    expect(
      useAgentSessionStore.getState().threadProjections[threadId],
    ).toBeUndefined();
  });

  it("clears running state when stream_end matches the active run id", async () => {
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const store = useChatStore.getState();
    const threadId = "thread-card-codex-run-id-match";

    store.bindThreadType(threadId, "codex");
    store.dispatchAgentChunk({
      kind: "stream_start",
      thread_id: threadId,
      run_id: "run-1",
    });
    store.dispatchAgentChunk({
      kind: "stream_end",
      thread_id: threadId,
      run_id: "run-1",
      reason: null,
    });

    const idleState = useChatStore.getState().threadStates[threadId];
    expect(idleState.isLoading).toBe(false);
    expect(idleState.activeRunId).toBeNull();
    expect(Object.values(idleState.runs)).toHaveLength(0);
  });

  it("ignores late tool chunks after stream_end", async () => {
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const store = useChatStore.getState();
    const threadId = "thread-card-codex-late-tool";
    const runId = "run-late-tool";

    store.bindThreadType(threadId, "codex");
    store.dispatchAgentChunk({
      kind: "stream_start",
      thread_id: threadId,
      run_id: runId,
      agent_type: "codex",
    });
    store.dispatchAgentChunk({
      kind: "stream_end",
      thread_id: threadId,
      run_id: runId,
      agent_type: "codex",
      reason: null,
    });
    store.dispatchAgentChunk({
      kind: "tool_call",
      thread_id: threadId,
      run_id: runId,
      id: "late-tool-1",
      name: "exec_command",
      input: { command: "pwd" },
      agent_type: "codex",
    });
    store.dispatchAgentChunk({
      kind: "tool_result",
      thread_id: threadId,
      run_id: runId,
      id: "late-tool-1",
      name: "exec_command",
      result: { output_preview: "/tmp/project\n", exit_code: 0 },
      agent_type: "codex",
    });

    const messageState =
      useAgentConversationStore.getState().messageStates[threadId];
    expect(messageState?.messages ?? []).toHaveLength(0);

    const idleState = useChatStore.getState().threadStates[threadId];
    expect(idleState.isLoading).toBe(false);
    expect(idleState.activeRunId).toBeNull();
    expect(idleState.messages).toEqual([]);
    expect(idleState.runs[runId]).toBeUndefined();
    expect(idleState.lastRun).toMatchObject({
      runId,
      status: "completed",
    });
  });

  it("ignores stale stream_end after a newer run has started", async () => {
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const store = useChatStore.getState();
    const threadId = "thread-card-codex-stale-end";

    store.bindThreadType(threadId, "codex");
    store.dispatchAgentChunk({
      kind: "stream_start",
      thread_id: threadId,
      run_id: "run-2",
    });
    await store.stopThreadRun(threadId, "run-2");
    store.dispatchAgentChunk({
      kind: "stream_start",
      thread_id: threadId,
      run_id: "run-3",
    });
    store.dispatchAgentChunk({
      kind: "stream_end",
      thread_id: threadId,
      run_id: "run-2",
      reason: null,
    });

    const state = useChatStore.getState().threadStates[threadId];
    expect(state.isLoading).toBe(true);
    expect(state.activeRunId).toBe("run-3");
    expect(state.runs["run-3"]?.status).toBe("running");
  });

  it("migrates a local Codex thread to the resolved session id", async () => {
    const { useChatStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const {
      selectRunningAgentConversationThreadIds,
      useAgentConversationStore,
    } = await import("@features/agent/store/agent-session-test-facade");
    const store = useChatStore.getState();
    const localThreadId = "codex-local-agent-inst-store-session";
    const sessionId = "019f0000-0000-7000-8000-000000000000";
    const instance = useAgentConversationStore.getState().createInstance({
      agentType: "codex",
      title: "Local Codex",
      threadId: localThreadId,
      source: {
        kind: "thread-card",
        memoId: "memo-running-session",
        documentPath: "/tmp/running-session.md",
      },
      runtimeConfig: {
        files: {
          workspace: "/tmp/project",
          folders: ["/tmp/project"],
          notebooks: [],
        },
      },
    });

    store.bindThreadType(localThreadId, "codex");
    store.dispatchAgentChunk({
      kind: "stream_start",
      thread_id: localThreadId,
      run_id: "run-local-1",
      agent_type: "codex",
    });
    store.dispatchAgentChunk({
      kind: "text",
      thread_id: localThreadId,
      run_id: "run-local-1",
      text: "Codex answer before session id",
      agent_type: "codex",
    });
    store.dispatchAgentChunk({
      kind: "session_resolved",
      thread_id: localThreadId,
      session_id: sessionId,
      run_id: "run-local-1",
      agent_type: "codex",
    });

    const state = useChatStore.getState();
    expect(state.externalSessionResolutions[localThreadId]).toBe(sessionId);
    expect(state.activeThreadIds.codex).toBe(localThreadId);
    expect(state.threadTypes[sessionId]).toBe("codex");
    expect(state.threadStates[localThreadId].isLoading).toBe(true);
    expect(state.threadStates[localThreadId].activeRunId).toBe("run-local-1");
    // Phase 2 (2026-08-02): projection 持久 messages, session_resolved 迁移后保留.
    // 旧 release 语义断言已废弃 ── 见 store/index.ts 注释.
    expect(state.threadStates[localThreadId].messages).toMatchObject([
      { content: "Codex answer before session id" },
    ]);
    expect(
      useAgentConversationStore.getState().messageStates[localThreadId].messages[0]
        ?.content,
    ).toBe("Codex answer before session id");
    const resolvedInstance = useAgentConversationStore
      .getState()
      .getInstance(instance.instanceId);
    expect(resolvedInstance).toMatchObject({
      threadId: localThreadId,
      source: {
        kind: "thread-card",
        memoId: "memo-running-session",
        documentPath: "/tmp/running-session.md",
      },
    });
    expect(
      selectRunningAgentConversationThreadIds(
        useAgentConversationStore.getState(),
        useChatStore.getState().threadStates,
      ),
    ).toEqual([localThreadId]);
    store.dispatchAgentChunk({
      kind: "stream_end",
      thread_id: localThreadId,
      run_id: "run-local-1",
      reason: null,
      agent_type: "codex",
    });

    const endedState = useChatStore.getState();
    expect(endedState.threadStates[localThreadId].isLoading).toBe(false);
    expect(endedState.threadStates[localThreadId].activeRunId).toBeNull();
  });

  it("migrates conversation messages on session resolution without requiring an instance", async () => {
    const { useChatStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const localThreadId = "codex-local-without-instance";
    const sessionId = "codex-session-without-instance";

    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    useAgentSessionStore.getState().setThreadProjection(localThreadId, (p) => ({
      ...p,
      messages: [
        {
          id: "assistant-local",
          role: "assistant",
          content: "message before instance exists",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
      pending: { assistantId: "assistant-local", reasoningId: null },
    }));

    useChatStore.getState().bindThreadType(localThreadId, "codex");
    useChatStore.getState().dispatchAgentChunk({
      kind: "session_resolved",
      thread_id: localThreadId,
      session_id: sessionId,
      run_id: "run-without-instance",
      agent_type: "codex",
    });

    const messageState =
      useAgentConversationStore.getState().messageStates[localThreadId];
    expect(messageState.messages[0]).toMatchObject({
      id: "assistant-local",
      content: "message before instance exists",
    });
    expect(messageState.pendingAssistantId).toBe("assistant-local");
    expect(
      useChatStore.getState().externalSessionResolutions[localThreadId],
    ).toBe(sessionId);
  });

  it("commits projection, metadata, and conversation migration in one store update", async () => {
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    const localThreadId = "atomic-local-thread";
    const sessionId = "atomic-session-thread";
    const instance = useAgentSessionStore.getState().createInstance({
      agentType: "codex",
      title: "Atomic migration",
      threadId: localThreadId,
      source: { kind: "thread-card" },
    });
    useAgentSessionStore.getState().dispatch({
      kind: "stream_start",
      agentType: "codex",
      threadId: localThreadId,
      runId: "atomic-run",
      timestamp: 1,
    });
    let notifications = 0;
    const unsubscribe = useAgentSessionStore.subscribe(() => {
      notifications += 1;
    });

    useAgentSessionStore.getState().dispatchAgentEvent({
      kind: "session_resolved",
      agentType: "codex",
      threadId: localThreadId,
      sessionId,
      runId: "atomic-run",
      timestamp: 2,
    });
    unsubscribe();

    const state = useAgentSessionStore.getState();
    expect(notifications).toBe(1);
    expect(state.threadProjections[localThreadId]).toBeDefined();
    expect(state.threadProjections[sessionId]).toBeUndefined();
    expect(state.sessionMeta.externalSessionResolutions[localThreadId]).toBe(
      sessionId,
    );
    expect(state.conversationRegistry.instances[instance.instanceId].threadId).toBe(
      localThreadId,
    );
  });

  it("migrates external session cache resolution through conversation messages", async () => {
    const { useChatStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const { applyResolvedExternalSession, getResolvedExternalSessionId } =
      await import(
        "@features/agent/services/external-agent-runtime-service"
      );
    const localThreadId = "codex-local-cache-resolved";
    const sessionId = "codex-session-cache-resolved";

    // Phase 2 (2026-08-02): seed session-store (真源), mirror 同步到 conv-store.
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    useAgentSessionStore.getState().setThreadProjection(localThreadId, (p) => ({
      ...p,
      messages: [
        {
          id: "assistant-cache-resolved",
          role: "assistant",
          content: "cache resolved message",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
      pending: { assistantId: "assistant-cache-resolved", reasoningId: null },
    }));
    useChatStore.getState().bindThreadType(localThreadId, "codex");
    useChatStore.getState().dispatchAgentChunk({
      kind: "stream_start",
      thread_id: localThreadId,
      run_id: "run-cache-resolved",
      agent_type: "codex",
    });

    expect(
      applyResolvedExternalSession(
        "external-agent-card-cache-resolved",
        localThreadId,
        sessionId,
        "codex",
      ),
    ).toBe(true);

    const chatState = useChatStore.getState();
    expect(chatState.externalSessionResolutions[localThreadId]).toBe(sessionId);
    expect(getResolvedExternalSessionId(localThreadId)).toBe(sessionId);
    expect(chatState.threadStates[localThreadId]).toMatchObject({
      isLoading: true,
      activeRunId: "run-cache-resolved",
    });
    // Phase 2 (2026-08-02): projection 持久 messages, 见同文件 1283 注释.
    expect(chatState.threadStates[localThreadId].messages).toMatchObject([
      { content: "cache resolved message" },
    ]);

    const messageState =
      useAgentConversationStore.getState().messageStates[localThreadId];
    expect(messageState.messages[0]).toMatchObject({
      id: "assistant-cache-resolved",
      content: "cache resolved message",
    });
    expect(messageState.pendingAssistantId).toBe("assistant-cache-resolved");
  });

  it("keeps parallel Thread Card streams isolated by thread id", async () => {
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const store = useChatStore.getState();
    const firstThreadId = "thread-card-codex";
    const secondThreadId = "thread-card-flowix";

    store.bindThreadType(firstThreadId, "codex");
    store.bindThreadType(secondThreadId, "deepseek-harness");

    const chunks: AgentChunk[] = [
      { kind: "stream_start", thread_id: firstThreadId },
      { kind: "stream_start", thread_id: secondThreadId },
      { kind: "text", thread_id: firstThreadId, text: "Cod" },
      { kind: "text", thread_id: secondThreadId, text: "Flo" },
      { kind: "text", thread_id: firstThreadId, text: "ex" },
      { kind: "text", thread_id: secondThreadId, text: "wix" },
    ];

    chunks.forEach((chunk) => store.dispatchAgentChunk(chunk));
    await flushAnimationFrame();

    const state = useChatStore.getState();
    expect(state.threadStates[firstThreadId].messages[0]?.content).toBe(
      "Codex",
    );
    expect(state.threadStates[secondThreadId].messages[0]?.content).toBe(
      "Flowix",
    );
    expect(
      state.threadStates[firstThreadId].runs[
        state.threadStates[firstThreadId].activeRunId ?? ""
      ]?.agentType,
    ).toBe("codex");
    expect(
      state.threadStates[secondThreadId].runs[
        state.threadStates[secondThreadId].activeRunId ?? ""
      ]?.agentType,
    ).toBe("deepseek-harness");
  });

  it("loads Codex history through paged IPC", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const threadId = "codex-history-page";

    (
      agent.listCodexThreads as unknown as {
        mockResolvedValueOnce: (value: unknown) => void;
      }
    ).mockResolvedValueOnce([
      { threadId, title: "Paged Codex", createdAt: 1, updatedAt: 2 },
    ]);
    (
      agent.getCodexThreadPage as unknown as {
        mockResolvedValueOnce: (value: unknown) => void;
      }
    ).mockResolvedValueOnce({
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "recent codex answer",
          timestamp: new Date().toISOString(),
        },
      ],
      oldestSequence: 42,
      hasMore: true,
    });

    await useChatStore.getState().loadCodexThread(threadId);

    expect(agent.getCodexThreadPage).toHaveBeenCalledWith(
      threadId,
      null,
      expect.any(Number),
    );
    expect(agent.getCodexThread).not.toHaveBeenCalled();
    const messageState =
      useAgentConversationStore.getState().messageStates[threadId];
    expect(messageState.messages[0]?.content).toBe("recent codex answer");
    expect(messageState.oldestSequence).toBe(42);
    expect(messageState.hasMoreHistory).toBe(true);
    // Phase 3 (2026-08-02): loadMessages 写 session-store, mirror 同步到
    // chat-store ── threadStates[tid].messages 不再为空. 旧 dual-write 时代
    // chat-store.threadStates 不含 messages 的 invariant 已废弃.
    expect(
      useChatStore.getState().threadStates[threadId].messages,
    ).toMatchObject([{ content: "recent codex answer" }]);
  });

  it("loads Codex database history through the backend materialized page", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const threadId = "codex-database-only-history";
    vi.mocked(agent.listCodexThreads).mockResolvedValueOnce([
      { threadId, title: "Database replay", createdAt: 1, updatedAt: 2 },
    ]);
    vi.mocked(agent.getCodexThreadPage).mockResolvedValueOnce({
      messages: [
        {
          id: "user-database-only",
          role: "user",
          content: "Database question",
          timestamp: new Date().toISOString(),
        },
      ],
      oldestSequence: 1,
      hasMore: false,
    });

    await useChatStore.getState().loadCodexThread(threadId);

    expect(agent.externalEvents).not.toHaveBeenCalled();
    expect(agent.getCodexThreadPage).toHaveBeenCalledWith(
      threadId,
      null,
      expect.any(Number),
    );
    expect(agent.getCodexThread).not.toHaveBeenCalled();
    expect(
      useAgentConversationStore.getState().messageStates[threadId].messages,
    ).toMatchObject([
      {
        id: "user-database-only",
        role: "user",
        content: "Database question",
      },
    ]);
  });

  it("appends DSH compact history without clearing the existing timeline", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    const threadId = "dsh-history-after-compact";
    const timestamp = new Date().toISOString();

    useAgentSessionStore.getState().setThreadProjection(threadId, (projection) => ({
      ...projection,
      messages: [
        {
          id: "old-user",
          role: "user",
          content: "history that DSH later shadowed",
          timestamp,
        },
      ],
    }));
    vi.mocked(agent.getDeepSeekHarnessThread).mockResolvedValueOnce({
      messages: [
        {
          id: "checkpoint-1",
          role: "system",
          messageType: "context-compaction",
          content: "## Current Work\n- continue",
          timestamp,
        },
      ],
    });

    const messages = await useAgentSessionStore
      .getState()
      .reloadMessagesFromHistory("deepseek-harness", threadId, {
        preserveExistingMessages: true,
      });

    expect(agent.getDeepSeekHarnessThread).toHaveBeenCalledWith(threadId);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "old-user" }),
        expect.objectContaining({
          id: "checkpoint-1",
          role: "system",
          messageType: "context-compaction",
        }),
      ]),
    );
    expect(
      useAgentSessionStore.getState().threadProjections[threadId]?.messages,
    ).toEqual(messages);
    expect(messages.some((message) => message.id === "old-user")).toBe(true);
  });

  it("hydrates tool display when loading Codex history", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const threadId = "codex-history-web-search";

    (
      agent.listCodexThreads as unknown as {
        mockResolvedValueOnce: (value: unknown) => void;
      }
    ).mockResolvedValueOnce([
      { threadId, title: "Web Search", createdAt: 1, updatedAt: 2 },
    ]);
    (
      agent.getCodexThreadPage as unknown as {
        mockResolvedValueOnce: (value: unknown) => void;
      }
    ).mockResolvedValueOnce({
      messages: [
        {
          id: "tool-web-search",
          role: "tool",
          content: "",
          timestamp: new Date().toISOString(),
          toolCallId: "call-web-search",
          toolName: "web_search",
          toolInput: {
            action: {
              query: "Flowix Codex search persistence",
            },
          },
          isLoading: false,
        },
      ],
      oldestSequence: 1,
      hasMore: false,
    });

    await useChatStore.getState().loadCodexThread(threadId);

    const message =
      useAgentConversationStore.getState().messageStates[threadId].messages[0];
    expect(message).toMatchObject({
      role: "tool",
      toolName: "web_search",
      toolDisplay: {
        summary: "Flowix Codex search persistence",
        title: "Flowix Codex search persistence",
        kind: "search",
      },
    });
  });

  it("loads Claude history tool rows after external replay has no display events", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const store = useChatStore.getState();
    const threadId = "claude-history-tool-merge";

    store.bindThreadType(threadId, "claude");
    store.dispatchAgentChunk({
      kind: "tool_call",
      thread_id: threadId,
      id: "toolu_1",
      name: "Read",
      input: { file_path: "README.md" },
      agent_type: "claude",
    });
    store.dispatchAgentChunk({
      kind: "tool_result",
      thread_id: threadId,
      id: "toolu_1",
      name: "",
      result: { content: "file contents" },
      agent_type: "claude",
    });

    vi.mocked(agent.listClaudeThreads).mockResolvedValueOnce([
      { threadId, title: "Claude Tool Merge", createdAt: 1, updatedAt: 2 },
    ]);
    vi.mocked(agent.getClaudeThreadPage).mockResolvedValueOnce({
      messages: [
        {
          id: "history-user",
          role: "user",
          content: "read the file",
          timestamp: new Date().toISOString(),
        },
        {
          id: "history-tool-call",
          role: "tool",
          content: '{\n  "content": "file contents"\n}',
          timestamp: new Date().toISOString(),
          toolCallId: "toolu_1",
          toolName: "Read",
          toolInput: { file_path: "README.md" },
          isLoading: false,
        },
        {
          id: "history-assistant",
          role: "assistant",
          content: "done",
          timestamp: new Date().toISOString(),
        },
      ],
      oldestSequence: 1,
      hasMore: false,
    });

    await store.loadClaudeThread(threadId);

    const messages =
      useAgentConversationStore.getState().messageStates[threadId].messages;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "tool",
      "assistant",
    ]);
    expect(messages[0]?.id).toBe("history-user");
    expect(messages[2]?.id).toBe("history-assistant");
    expect(
      messages.filter((message) => message.toolCallId?.endsWith("toolu_1")),
    )
      .toHaveLength(1);
    expect(messages.find((message) => message.toolCallId?.endsWith("toolu_1")))
      .toMatchObject({
      role: "tool",
      content: '{\n  "content": "file contents"\n}',
      isLoading: false,
    });
  });

  it("treats Codex text chunks as a final message instead of streaming deltas", async () => {
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const store = useChatStore.getState();
    const threadId = "thread-card-codex-final";

    store.bindThreadType(threadId, "codex");
    store.dispatchAgentChunk({ kind: "stream_start", thread_id: threadId });
    store.dispatchAgentChunk({
      kind: "text",
      thread_id: threadId,
      text: "Final Codex answer",
    });

    const threadState = useChatStore.getState().threadStates[threadId];
    expect(threadState.messages).toHaveLength(1);
    expect(threadState.messages[0]).toMatchObject({
      role: "assistant",
      content: "Final Codex answer",
    });
  });

  it("renders tool-call lifecycle in the target thread without rebuilding other threads", async () => {
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const store = useChatStore.getState();
    const threadId = "thread-card-tool";

    store.bindThreadType(threadId, "deepseek-harness");
    store.dispatchAgentChunk({ kind: "stream_start", thread_id: threadId });
    store.dispatchAgentChunk({
      kind: "tool_call",
      thread_id: threadId,
      id: "tool-1",
      name: "shell",
      input: { command: "pwd" },
    });
    store.dispatchAgentChunk({
      kind: "tool_result",
      thread_id: threadId,
      id: "tool-1",
      name: "shell",
      result: { ok: true },
    });

    const threadState = useChatStore.getState().threadStates[threadId];
    expect(threadState.messages).toHaveLength(1);
    expect(threadState.messages[0]).toMatchObject({
      role: "tool",
      toolCallId: expect.stringContaining(":tool-call:tool-1"),
      toolName: "shell",
      isLoading: false,
    });
    expect(
      threadState.runs[threadState.activeRunId ?? ""]?.currentTool,
    ).toBeNull();
  });

  it("normalizes Codex command tool input when arguments arrive as JSON text", async () => {
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const store = useChatStore.getState();
    const threadId = "thread-card-codex-command-json";

    store.bindThreadType(threadId, "codex");
    store.dispatchAgentChunk({ kind: "stream_start", thread_id: threadId });
    store.dispatchAgentChunk({
      kind: "tool_call",
      thread_id: threadId,
      id: "tool-json",
      name: "shell_command",
      input:
        '{"command":"npm run build","timeout_ms":10000}' as unknown as Record<
          string,
          unknown
        >,
      agent_type: "codex",
    });

    const message = useChatStore.getState().threadStates[threadId].messages[0];
    expect(message).toMatchObject({
      role: "tool",
      toolName: "shell_command",
      toolInput: { command: "npm run build", timeout_ms: 10000 },
      toolDisplay: {
        summary: "npm run build",
        title: "npm run build",
        kind: "command",
      },
    });
  });

  it("summarizes Codex command execution results without full output", async () => {
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const store = useChatStore.getState();
    const threadId = "thread-card-codex-command-result";

    store.bindThreadType(threadId, "codex");
    store.dispatchAgentChunk({
      kind: "stream_start",
      thread_id: threadId,
      run_id: "run-codex-1",
    });
    store.dispatchAgentChunk({
      kind: "tool_call",
      thread_id: threadId,
      run_id: "run-codex-1",
      id: "cmd-1",
      name: "command_execution",
      input: { command: "npm run build", status: "in_progress" },
      agent_type: "codex",
    });
    store.dispatchAgentChunk({
      kind: "tool_result",
      thread_id: threadId,
      run_id: "run-codex-1",
      id: "cmd-1",
      name: "command_execution",
      result: {
        command: "npm run build",
        exit_code: 0,
        status: "completed",
        output_chars: 5000,
        output_truncated: true,
        output_preview: "build ok",
      },
      agent_type: "codex",
    });

    const threadState = useChatStore.getState().threadStates[threadId];
    const message = threadState.messages[0];
    expect(threadState.activeRunId).toBe("run-codex-1");
    expect(message).toMatchObject({
      role: "tool",
      toolCallId: "cmd-1",
      toolName: "command_execution",
      isLoading: false,
    });
    expect(message.toolData).toContain('"output_preview": "build ok"');
    expect(message.toolData).toContain('"output_truncated": true');
  });

  it("keeps tool result rendering safe for non-serializable command output", async () => {
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const store = useChatStore.getState();
    const threadId = "thread-card-codex-command-circular-result";
    const result: Record<string, unknown> = {};
    result.self = result;

    store.bindThreadType(threadId, "codex");
    store.dispatchAgentChunk({ kind: "stream_start", thread_id: threadId });
    store.dispatchAgentChunk({
      kind: "tool_call",
      thread_id: threadId,
      id: "tool-circular",
      name: "shell_command",
      input: { command: "pwd" },
      agent_type: "codex",
    });
    expect(() =>
      store.dispatchAgentChunk({
        kind: "tool_result",
        thread_id: threadId,
        id: "tool-circular",
        name: "shell_command",
        result,
        agent_type: "codex",
      }),
    ).not.toThrow();

    const message = useChatStore.getState().threadStates[threadId].messages[0];
    expect(message.isLoading).toBe(false);
    expect(message.toolData).toContain("[object Object]");
  });

  it("passes the thread agent type when stopping a run", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const store = useChatStore.getState();
    const threadId = "thread-card-stop-codex";

    store.bindThreadType(threadId, "codex");
    store.dispatchAgentChunk({
      kind: "stream_start",
      thread_id: threadId,
      run_id: "run-stop-codex",
      agent_type: "codex",
    });

    await useChatStore.getState().stopThreadRun(threadId);

    const threadState = useChatStore.getState().threadStates[threadId];
    expect(agent.stopChatStream).toHaveBeenCalledWith(
      threadId,
      "codex",
      "run-stop-codex",
    );
    expect(threadState.isLoading).toBe(false);
    expect(threadState.activeRunId).toBeNull();
    expect(threadState.runs["run-stop-codex"]).toBeUndefined();
    expect(threadState.lastRun).toMatchObject({
      runId: "run-stop-codex",
      status: "cancelled",
    });
    store.dispatchAgentChunk({
      kind: "stream_end",
      thread_id: threadId,
      run_id: "run-stop-codex",
      agent_type: "codex",
      reason: null,
    });

    expect(useChatStore.getState().threadStates[threadId].lastRun).toMatchObject({
      runId: "run-stop-codex",
      status: "cancelled",
    });
  });

  it("setActiveThreadId / setActiveCodexThreadId do not change activeAgentTypeKey", async () => {
    // 淇 #12: 涔嬪墠 `activeThreadUpdate` 鎶?`activeAgentTypeKey: type` 褰?    // 鍓綔鐢?鈹€鈹€ 鍒囧埌 codex thread 椤哄甫鎶?activeAgentTypeKey 鏀规垚 codex銆?    // 澶?panel / 澶?instance 骞跺彂鍦烘櫙涓? 鍏朵腑涓€涓?panel 鐨?setActiveThreadId
    // 浼氭薄鏌撳彟涓€涓?panel 鐨?send 璺緞銆?    //
    // 鐜板湪 `activeThreadUpdate` 鍙洿鏂?activeThreadIds[type], activeAgentTypeKey
    // 鐢?setActiveAgentThread / setActiveAgentTypeKey 鏄惧紡绠＄悊銆?  
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const store = useChatStore.getState();

    // 鍒濆 activeAgentTypeKey (DEFAULT_AGENT_TYPE_KEY 閫氬父鏄?'deepseek-harness', 浣嗕笉渚濊禆鍏蜂綋鍊?
    const initialType = useChatStore.getState().activeAgentTypeKey;

    // 鍒囧埌 codex thread 鈹€鈹€ 浠呮洿鏂?activeThreadIds.codex, 涓嶅姩 activeAgentTypeKey銆?  
    store.setActiveCodexThreadId("codex-thread-1");
    expect(useChatStore.getState().activeThreadIds.codex).toBe("codex-thread-1");
    expect(useChatStore.getState().activeAgentTypeKey).toBe(initialType);

    // 鍒囧埌 flowix thread 鈹€鈹€ 鍚屾牱涓嶅姩 activeAgentTypeKey銆?  
    store.setActiveThreadId("flowix-thread-1");
    expect(useChatStore.getState().activeThreadIds["deepseek-harness"]).toBe("flowix-thread-1");
    expect(useChatStore.getState().activeAgentTypeKey).toBe(initialType);

    // setActiveAgentThread 浠嶇劧鍚屾涓よ€?鈹€鈹€ 杩欐槸璺?runtime 鍒囨崲鐨勬樉寮忓叆鍙ｃ€?  
    store.setActiveAgentThread("codex", "codex-thread-2");
    expect(useChatStore.getState().activeThreadIds.codex).toBe("codex-thread-2");
    expect(useChatStore.getState().activeAgentTypeKey).toBe("codex");
  });

  it("stopThreadRun sends thread-wide IPC when no active run is recorded locally", async () => {
    // 淇 #9: 涔嬪墠 `targetRunId` 鏃?return 鍚庝粛鍙?IPC, 鍚庣璧?thread-wide
    // stop 鍏滃簳, 鏄氮璐广€?鐜板湪 targetRunId 鏈В鏋愭椂鐩存帴 return, 涓嶅彂 IPC銆?    // 楠岃瘉涓ょ鎯呭舰:
    //   1. thread 瀹屽叏娌?dispatch 杩?stream_start, 鍐呴儴鏃?active run銆?    //   2. thread 宸?stream_end, activeRunId 琚竻, 涔熸病涓滆タ鍙仠銆?  
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const store = useChatStore.getState();

    // Scenario 1: a brand-new thread that has never run.
    vi.clearAllMocks();
    await store.stopThreadRun("thread-stop-empty");
    expect(agent.stopChatStream).toHaveBeenCalledWith(
      "thread-stop-empty",
      DEFAULT_AGENT_TYPE_KEY,
      undefined,
    );

    // 鈹€鈹€ 鎯呭舰 2: thread 璺戣繃浣嗗凡鑷劧缁撴潫銆?  
    const finishedThreadId = "thread-stop-already-ended";
    store.bindThreadType(finishedThreadId, "deepseek-harness");
    store.dispatchAgentChunk({
      kind: "stream_start",
      thread_id: finishedThreadId,
      run_id: "run-finished",
    });
    store.dispatchAgentChunk({
      kind: "stream_end",
      thread_id: finishedThreadId,
      run_id: "run-finished",
      reason: null,
    });
    expect(
      useChatStore.getState().threadStates[finishedThreadId].activeRunId,
    ).toBeNull();

    vi.clearAllMocks();
    await store.stopThreadRun(finishedThreadId);
    expect(agent.stopChatStream).toHaveBeenCalledWith(
      finishedThreadId,
      "deepseek-harness",
      undefined,
    );
  });

  it("sends Codex model and permission through runtime config", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const threadId = "thread-card-runtime-config-codex";

    useChatStore.setState({
      agentPermissionMode: "workspace-write",
      agentCodexModel: "gpt-5.5",
      threadTypes: { [threadId]: "codex" },
    });

    await useChatStore
      .getState()
      .sendMessageToThread(threadId, "hello runtime config", "codex");

    const calls = vi.mocked(agent.chatStream).mock.calls;
    const payload = calls[calls.length - 1]?.[1];
    expect(payload).toMatchObject({
      agentType: "codex",
      runId: expect.stringMatching(/^run-thread-card-runtime-config-codex-/),
      runtimeConfig: {
        codex: {
          permissionMode: "workspace-write",
          model: "gpt-5.5",
        },
      },
    });
    expect(payload).not.toHaveProperty("permissionMode");
    expect(payload).not.toHaveProperty("codexModel");
  });

  it("derives Codex cwd and workspacePaths from notebook folder defaults + current notebook", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const threadId = "thread-card-runtime-config-codex-workspaces";
    memoStateMock.selectedNotebook = {
      id: "nb-current",
      path: "D:\\projects\\flowix",
    };
    agentAccessMock.config = {
      // defaults.folders 里的每个 folder 必须在 entries 里有对应的
      // enabled && !missing 授权条目, 否则 resolveAuthorizedDefaultFiles
      // 会把它收窄掉 (防越权)。
      entries: [
        { id: "e-notes-main", kind: "folder", path: "D:\\notes\\main", name: "main", enabled: true, missing: false },
        { id: "e-flowix", kind: "folder", path: "D:\\projects\\flowix", name: "deepseek-harness", enabled: true, missing: false },
      ],
      defaults: {
        files: {
          "nb-current": {
            workspace: "D:\\projects\\flowix",
            folders: ["D:\\notes\\main", "D:\\projects\\flowix"],
            notebooks: [],
          },
        },
      },
    };

    useChatStore.setState({
      threadTypes: { [threadId]: "codex" },
    });

    await useChatStore.getState().sendMessageToThread(
      threadId,
      "hello workspaces",
      "codex",
      { runtimeConfig: { notebookId: "nb-current" } },
    );

    const calls = vi.mocked(agent.chatStream).mock.calls;
    const payload = calls[calls.length - 1]?.[1];
    expect(payload).toMatchObject({
      agentType: "codex",
      runtimeConfig: {
        codex: {
          cwd: "D:\\projects\\flowix",
          workspacePaths: ["D:\\notes\\main"],
        },
      },
    });
  });

  it("uses first folder as cwd when no workspace is set, includes current notebook", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const threadId = "thread-card-runtime-config-first-folder";
    memoStateMock.selectedNotebook = {
      id: "nb-current",
      path: "D:\\projects\\flowix",
    };
    agentAccessMock.config = {
      entries: [],
      defaults: {
        files: {
          "nb-current": {
            workspace: undefined,
            folders: ["D:\\projects\\flowix"],
            notebooks: [],
          },
        },
      },
    };

    useChatStore.setState({
      threadTypes: { [threadId]: "codex" },
    });

    await useChatStore.getState().sendMessageToThread(
      threadId,
      "hello first folder",
      "codex",
      { runtimeConfig: { notebookId: "nb-current" } },
    );

    const calls = vi.mocked(agent.chatStream).mock.calls;
    const payload = calls[calls.length - 1]?.[1];
    expect(payload).toMatchObject({
      agentType: "codex",
      runtimeConfig: {
        codex: {
          cwd: "D:\\projects\\flowix",
        workspacePaths: [],
        },
      },
    });
  });

  it("uses the notebook workspace snapshot as cwd before backend freezing", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const threadId = "thread-card-frozen-workspace";
    memoStateMock.selectedNotebook = {
      id: "nb-changed",
      path: "D:\\notes\\changed",
    };
    agentAccessMock.config = {
      entries: [
        {
          id: "e-changed",
          kind: "folder",
          path: "D:\\projects\\changed",
          name: "changed",
          enabled: true,
          missing: false,
        },
      ],
      defaults: {
        files: {
          "nb-original": {
            workspace: "D:\\projects\\changed",
            folders: ["D:\\projects\\changed"],
            notebooks: [],
          },
        },
      },
    };
    useChatStore.setState({ threadTypes: { [threadId]: "codex" } });

    await useChatStore.getState().sendMessageToThread(
      threadId,
      "keep the original workspace",
      "codex",
      {
        runtimeConfig: {
          notebookId: "nb-original",
          workspaceSnapshot: {
            version: 1,
            cwd: "D:\\projects\\original",
            workspacePaths: [
              "D:\\projects\\original",
              "D:\\notes\\original",
            ],
            notebookId: "nb-original",
            notebookPath: "D:\\notes\\original",
            capturedAt: 1,
          },
        },
      },
    );

    const calls = vi.mocked(agent.chatStream).mock.calls;
    const payload = calls[calls.length - 1]?.[1];
    expect(payload).toMatchObject({
      systemReminderDirectory: "D:\\notes\\original",
      runtimeConfig: {
        codex: {
          cwd: "D:\\projects\\original",
          workspacePaths: ["D:\\notes\\original"],
        },
      },
    });
  });

  it("renames local agent threads through the standard action", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const threadId = "thread-card-rename-gemini";
    vi.mocked(agent.listLocalAgentThreads).mockResolvedValueOnce([
      { threadId, title: "New title", createdAt: 1, updatedAt: 2 },
    ]);

    useChatStore.setState((state) => ({
      threadTypes: { ...state.threadTypes, [threadId]: "gemini" },
      threadLists: {
        ...state.threadLists,
        gemini: [{ threadId, title: "Old title", createdAt: 1, updatedAt: 1 }],
      },
    }));

    await useChatStore
      .getState()
      .renameThread(threadId, "  New   title  ", "gemini");

    const state = useChatStore.getState();
    expect(state.currentThreadTitles[threadId]).toBe("New title");
    expect(state.threadLists.gemini?.[0]?.title).toBe("New title");
    expect(agent.updateThreadTitle).toHaveBeenCalledWith(
      threadId,
      "New title",
      "gemini",
    );
  });

  it("renames Agent conversations through the instance-backed action", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const threadId = "thread-card-rename-conversation";
    vi.mocked(agent.listLocalAgentThreads).mockResolvedValueOnce([
      {
        threadId,
        title: "New conversation title",
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    const instance = useAgentConversationStore.getState().createInstance({
      agentType: "gemini",
      title: "Old conversation title",
      threadId,
      source: { kind: "thread-card" },
    });

    useChatStore.setState((state) => ({
      threadTypes: { ...state.threadTypes, [threadId]: "gemini" },
      threadLists: {
        ...state.threadLists,
        gemini: [
          {
            threadId,
            title: "Old conversation title",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    }));

    await useChatStore.getState().renameAgentConversation({
      instanceId: instance.instanceId,
      title: "  New   conversation title  ",
    });

    expect(
      useAgentConversationStore.getState().getInstance(instance.instanceId)
        ?.title,
    ).toBe("New conversation title");
    expect(useChatStore.getState().threadLists.gemini?.[0]?.title).toBe(
      "New conversation title",
    );
    expect(agent.updateThreadTitle).toHaveBeenCalledWith(
      threadId,
      "New conversation title",
      "gemini",
    );
  });

  it("persists Codex titles and synchronizes every card bound to the thread", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const threadId = "019f-product-title-canonical";
    vi.mocked(agent.listCodexThreads).mockResolvedValueOnce([
      { threadId, title: "Database title", createdAt: 1, updatedAt: 2 },
    ]);
    const first = useAgentConversationStore.getState().createInstance({
      agentType: "codex",
      title: "First card title",
      threadId,
      source: { kind: "thread-card" },
    });
    const second = useAgentConversationStore.getState().createInstance({
      agentType: "codex",
      title: "Second card title",
      threadId,
      source: { kind: "thread-card" },
    });

    await useChatStore.getState().renameAgentConversation({
      instanceId: first.instanceId,
      threadId,
      title: "Database title",
      typeKey: "codex",
    });

    expect(agent.updateThreadTitle).toHaveBeenCalledWith(
      threadId,
      "Database title",
      "codex",
    );
    expect(
      useAgentConversationStore.getState().getInstance(first.instanceId)?.title,
    ).toBe("Database title");
    expect(
      useAgentConversationStore.getState().getInstance(second.instanceId)?.title,
    ).toBe("Database title");
  });

  it("renames only the selected Codex fork, not its source or sibling fork", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const sourceThreadId = "019f-product-source";
    const firstForkThreadId = "019f-product-fork-1";
    const secondForkThreadId = "019f-product-fork-2";
    const instances = [
      useAgentConversationStore.getState().createInstance({
        agentType: "codex",
        title: "Original",
        threadId: sourceThreadId,
        source: { kind: "thread-card" },
      }),
      useAgentConversationStore.getState().createInstance({
        agentType: "codex",
        title: "Original (fork 1)",
        threadId: firstForkThreadId,
        source: { kind: "thread-card" },
      }),
      useAgentConversationStore.getState().createInstance({
        agentType: "codex",
        title: "Original (fork 2)",
        threadId: secondForkThreadId,
        source: { kind: "thread-card" },
      }),
    ];
    useChatStore.setState({
      threadTypes: {
        [sourceThreadId]: "codex",
        [firstForkThreadId]: "codex",
        [secondForkThreadId]: "codex",
      },
      currentThreadTitles: {
        [sourceThreadId]: "Original",
        [firstForkThreadId]: "Original (fork 1)",
        [secondForkThreadId]: "Original (fork 2)",
      },
      threadLists: {
        codex: [
          { threadId: sourceThreadId, title: "Original", createdAt: 1, updatedAt: 1 },
          { threadId: firstForkThreadId, title: "Original (fork 1)", createdAt: 2, updatedAt: 2 },
          { threadId: secondForkThreadId, title: "Original (fork 2)", createdAt: 3, updatedAt: 3 },
        ],
      },
    });

    await useChatStore.getState().renameAgentConversation({
      instanceId: instances[1].instanceId,
      threadId: firstForkThreadId,
      title: "Renamed fork",
      typeKey: "codex",
    });

    const state = useChatStore.getState();
    expect(state.currentThreadTitles[sourceThreadId]).toBe("Original");
    expect(state.currentThreadTitles[firstForkThreadId]).toBe("Renamed fork");
    expect(state.currentThreadTitles[secondForkThreadId]).toBe("Original (fork 2)");
    expect(state.threadLists.codex).toEqual([
      { threadId: sourceThreadId, title: "Original", createdAt: 1, updatedAt: 1 },
      { threadId: firstForkThreadId, title: "Renamed fork", createdAt: 2, updatedAt: 2 },
      { threadId: secondForkThreadId, title: "Original (fork 2)", createdAt: 3, updatedAt: 3 },
    ]);
    expect(
      instances.map((instance) =>
        useAgentConversationStore.getState().getInstance(instance.instanceId)?.title,
      ),
    ).toEqual(["Original", "Renamed fork", "Original (fork 2)"]);
    expect(agent.updateThreadTitle).toHaveBeenCalledTimes(1);
    expect(agent.updateThreadTitle).toHaveBeenCalledWith(
      firstForkThreadId,
      "Renamed fork",
      "codex",
    );
  });

  it("rolls every title snapshot back when product persistence fails", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const threadId = "019f-title-rollback";
    vi.mocked(agent.updateThreadTitle).mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const instance = useAgentConversationStore.getState().createInstance({
      agentType: "codex",
      title: "Original title",
      threadId,
      source: { kind: "thread-card" },
    });
    useChatStore.setState((state) => ({
      activeThreadIds: { ...state.activeThreadIds, codex: threadId },
      currentThreadTitles: {
        ...state.currentThreadTitles,
        [threadId]: "Original title",
      },
      threadTypes: { ...state.threadTypes, [threadId]: "codex" },
      threadLists: {
        ...state.threadLists,
        codex: [
          { threadId, title: "Original title", createdAt: 1, updatedAt: 1 },
        ],
      },
    }));

    await expect(
      useChatStore.getState().renameAgentConversation({
        instanceId: instance.instanceId,
        threadId,
        title: "Unpersisted title",
        typeKey: "codex",
      }),
    ).rejects.toThrow("database unavailable");

    expect(useChatStore.getState().threadLists.codex?.[0]?.title).toBe(
      "Original title",
    );
    expect(useChatStore.getState().currentThreadTitles[threadId]).toBe(
      "Original title",
    );
    expect(
      useAgentConversationStore.getState().getInstance(instance.instanceId)
        ?.title,
    ).toBe("Original title");
  });

});
