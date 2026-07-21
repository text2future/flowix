import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChunk } from "@/types/agent";
import { CONTEXT_PROMPT_MARKER } from "@features/agent/message";

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
    getHermesThread: vi.fn(async () => ({ messages: [] })),
    getHermesThreadPage: vi.fn(async () => ({
      messages: [],
      oldestSequence: null,
      hasMore: false,
    })),
    externalEvents: vi.fn(async () => []),
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

    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
    );
    agentAccessMock.config = { entries: [] };
    useChatStore.setState(useChatStore.getInitialState(), true);
    useAgentConversationStore.setState(
      useAgentConversationStore.getInitialState(),
      true,
    );
  });

  it("projects live chunks in a tab-host bridge and releases it after the last owner", async () => {
    const { listenToAgentStream } = await import("@platform/tauri/client");
    const { acquireAgentChunkBridge, useChatStore } = await import(
      "@features/agent/store/chat-store"
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
    emitChunk({ kind: "stream_start", thread_id: threadId });
    emitChunk({ kind: "text", thread_id: threadId, text: "Live child-window reply" });
    await flushAnimationFrame();

    const running = useChatStore.getState().threadStates[threadId];
    expect(running.isLoading).toBe(true);
    expect(running.messages[0]?.content).toBe("Live child-window reply");

    emitChunk({ kind: "stream_end", thread_id: threadId, reason: null });
    expect(useChatStore.getState().threadStates[threadId].isLoading).toBe(false);

    releaseA();
    expect(unlisten).not.toHaveBeenCalled();
    releaseB();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("refreshes final history when listener recovery finds a locally running thread ended", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
    );
    const { reconcileAgentRunsAndRefreshEndedHistory } = await import(
      "@features/agent/hooks/use-agent-events"
    );
    const threadId = "tab-host-ended-during-listener-recovery";
    useChatStore.getState().reconcileRunningRunsFromSnapshot({
      [threadId]: {
        runId: "run-ended-offline",
        agentType: "flowix",
        startedAt: Date.now() - 10_000,
        currentTool: null,
      },
    });
    vi.mocked(agent.runningThreads).mockResolvedValueOnce({});
    const loadMessages = vi
      .spyOn(useAgentConversationStore.getState(), "loadMessages")
      .mockResolvedValueOnce();

    await reconcileAgentRunsAndRefreshEndedHistory();

    expect(useChatStore.getState().threadStates[threadId].isLoading).toBe(false);
    expect(loadMessages).toHaveBeenCalledWith("flowix", threadId);
  });

  it("routes streamed assistant text into the same thread state consumed by Thread Card", async () => {
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
    );
    const store = useChatStore.getState();
    const threadId = "thread-card-flowix";

    store.bindThreadType(threadId, "flowix");
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
    expect(idleState.messages).toEqual([]);
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
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
    );
    const { selectRenderableThreadMessages } = await import(
      "@features/agent/store/thread-render-messages"
    );
    const store = useChatStore.getState();
    const threadId = "thread-card-optimistic-user";

    await store.sendMessageToThread(threadId, "Hello from user", "flowix");

    const renderMessages =
      useAgentConversationStore.getState().messageStates[threadId]?.messages ??
      [];
    expect(renderMessages).toHaveLength(1);
    expect(renderMessages[0]).toMatchObject({
      role: "user",
    });
    expect(renderMessages[0].content).toContain("Hello from user");
    expect(
      selectRenderableThreadMessages({ typeKey: "flowix", threadId }),
    ).toBe(renderMessages);
  });

  it("uses canonical render messages to detect non-first follow-up sends", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
    );
    const threadId = "thread-follow-up-after-runtime-release";

    useAgentConversationStore.getState().syncRenderableMessages("flowix", threadId, [
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
      "flowix",
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
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
    );
    const threadId = "thread-low-frequency-conversation-live";
    const toolCallId = "tool-live-state";

    useChatStore.getState().bindThreadType(threadId, "flowix");
    useAgentConversationStore.getState().syncLiveMessageState("flowix", threadId, {
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
      agent_type: "flowix",
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

  it("applies buffered text chunks against conversation live messages", async () => {
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
    );
    const threadId = "thread-buffered-conversation-live";

    useChatStore.getState().bindThreadType(threadId, "flowix");
    useAgentConversationStore.getState().syncLiveMessageState("flowix", threadId, {
      messages: [
        {
          id: "assistant-live",
          role: "assistant",
          content: "Hello ",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
      pendingAssistantId: "assistant-live",
      pendingReasoningId: null,
    });

    useChatStore.getState().dispatchAgentChunk({
      kind: "text",
      thread_id: threadId,
      run_id: "run-buffered-live",
      text: "world",
      agent_type: "flowix",
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
      "@features/agent/store/chat-store"
    );
    const store = useChatStore.getState();
    const threadId = "thread-card-missed-start";

    store.bindThreadType(threadId, "flowix");
    store.dispatchAgentChunk({
      kind: "text",
      thread_id: threadId,
      run_id: "run-restored",
      agent_type: "flowix",
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
      "@features/agent/store/chat-store"
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
      "@features/agent/store/chat-store"
    );
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
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
    expect(chatState.threadStates[sessionId]).toMatchObject({
      isLoading: true,
      activeRunId: "run-snapshot-pending",
    });
    expect(chatState.threadStates[sessionId].messages).toEqual([]);

    const messageState =
      useAgentConversationStore.getState().messageStates[sessionId];
    expect(messageState.messages[0]).toMatchObject({
      id: "assistant-snapshot-pending",
      content: "snapshot restored pending message",
    });
    expect(messageState.pendingAssistantId).toBe("assistant-snapshot-pending");
    expect(
      useAgentConversationStore.getState().messageStates[localThreadId],
    ).toBeUndefined();
  });

  it("reconciles Agent conversation instances from backend running snapshot", async () => {
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
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
        agentType: "flowix",
        startedAt: 1234,
        currentTool: "shell",
      },
    });

    expect(useAgentConversationStore.getState().findByThreadId(threadId)).toMatchObject({
      agentType: "flowix",
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
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
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
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
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
      "@features/agent/store/chat-store"
    );
    const store = useChatStore.getState();
    const threadId = "thread-card-stale-running";

    store.bindThreadType(threadId, "flowix");
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
      "@features/agent/store/chat-store"
    );
    const store = useChatStore.getState();
    const threadId = "thread-card-optimistic-run";

    store.bindThreadType(threadId, "flowix");
    await store.sendMessageToThread(threadId, "hello optimistic", "flowix");
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
      "@features/agent/store/chat-store"
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
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const store = useChatStore.getState();
    const threadId = "thread-delete-clears-state";

    // 鍒涘缓涓€涓湁 content 鐨?thread, 鐒跺悗 dispatch 涓€浜?chunk 璁?threadStates
    // 绱Н messages / runs 鈹€鈹€ 杩欐槸 deleteThread 涔嬪墠鐨勭姸鎬併€?  
    store.bindThreadType(threadId, "flowix");
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
      agent_type: "flowix",
    });
    store.dispatchAgentChunk({
      kind: "tool_call",
      thread_id: threadId,
      run_id: "run-1",
      id: "call-x",
      name: "read",
      input: {},
      agent_type: "flowix",
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

    // deleteThread 涔嬪悗 (Week 1 #2 淇): entry 淇濈暀浣?messages 娓呯┖,
    // 閲婃斁 24KB tool_data 绱Н銆俽uns / pendingXxxId / isLoading 涔熻褰掗浂,
    // 闃叉 stopStream 鍚?flush 缂撳啿鎶婃枃瀛楀啓鍒板凡鍒?thread銆?  
    const after = useChatStore.getState().threadStates[threadId];
    expect(after).toBeDefined();
    expect(after.messages).toEqual([]);
    expect(after.runs).toEqual({});
    expect(after.isLoading).toBe(false);
    expect(after.pendingAssistantId).toBeNull();
    expect(after.pendingReasoningId).toBeNull();
    expect(after.activeRunId).toBeNull();
    expect(after.oldestSequence).toBeNull();
    expect(after.hasMoreHistory).toBe(false);
    expect(after.loadingMore).toBe(false);
    expect(after.lastRun).toBeUndefined();
  });

  it("deleteThread clears threadTypes and reverse-mapped externalSessionResolutions", async () => {
    // 淇 #7: deleteThread 涔嬪墠娌℃竻 `state.threadTypes[threadId]`, 鐣欎笅瀛ゅ効
    // 鏉＄洰 鈹€鈹€ 鍚庣画 `get().threadTypes[threadId] ?? "flowix"` 浼氭嬁鍒版棫 type,
    // 璇垽 dispatch 璺緞銆?鍚屾椂鍙嶅悜鏄犲皠 `externalSessionResolutions[local] === threadId`
    // (鍗?local id 宸茬粡琚?resolve 鍒拌繖涓鍒犵殑 thread) 涔熻娓? 鍚﹀垯 findByThreadId
    // 浼氳鍛戒腑宸插垹 id銆?  
    const { useChatStore } = await import("@features/agent/store/chat-store");
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

  it("clears running state when stream_end matches the active run id", async () => {
    const { useChatStore } = await import("@features/agent/store/chat-store");
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

  it("ignores stale stream_end after a newer run has started", async () => {
    const { useChatStore } = await import("@features/agent/store/chat-store");
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
      "@features/agent/store/chat-store"
    );
    const {
      selectRunningAgentConversationThreadIds,
      useAgentConversationStore,
    } = await import("@features/agent/store/agent-conversation-store");
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
    expect(state.activeThreadIds.codex).toBe(sessionId);
    expect(state.threadTypes[sessionId]).toBe("codex");
    expect(state.threadStates[sessionId].isLoading).toBe(true);
    expect(state.threadStates[sessionId].activeRunId).toBe("run-local-1");
    expect(state.threadStates[sessionId].messages).toEqual([]);
    expect(
      useAgentConversationStore.getState().messageStates[sessionId].messages[0]
        ?.content,
    ).toBe("Codex answer before session id");
    expect(
      useAgentConversationStore.getState().messageStates[localThreadId],
    ).toBeUndefined();
    const resolvedInstance = useAgentConversationStore
      .getState()
      .getInstance(instance.instanceId);
    expect(resolvedInstance).toMatchObject({
      threadId: sessionId,
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
    ).toEqual([sessionId]);
    store.dispatchAgentChunk({
      kind: "stream_end",
      thread_id: localThreadId,
      run_id: "run-local-1",
      reason: null,
      agent_type: "codex",
    });

    const endedState = useChatStore.getState();
    expect(endedState.threadStates[sessionId].isLoading).toBe(false);
    expect(endedState.threadStates[sessionId].activeRunId).toBeNull();
  });

  it("migrates conversation messages on session resolution without requiring an instance", async () => {
    const { useChatStore } = await import(
      "@features/agent/store/chat-store"
    );
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
    );
    const localThreadId = "codex-local-without-instance";
    const sessionId = "codex-session-without-instance";

    useAgentConversationStore.getState().syncLiveMessageState(
      "codex",
      localThreadId,
      {
        messages: [
          {
            id: "assistant-local",
            role: "assistant",
            content: "message before instance exists",
            timestamp: "2026-01-01T00:00:00.000Z",
          },
        ],
        pendingAssistantId: "assistant-local",
        pendingReasoningId: null,
      },
    );

    useChatStore.getState().bindThreadType(localThreadId, "codex");
    useChatStore.getState().dispatchAgentChunk({
      kind: "session_resolved",
      thread_id: localThreadId,
      session_id: sessionId,
      run_id: "run-without-instance",
      agent_type: "codex",
    });

    const messageState =
      useAgentConversationStore.getState().messageStates[sessionId];
    expect(messageState.messages[0]).toMatchObject({
      id: "assistant-local",
      content: "message before instance exists",
    });
    expect(messageState.pendingAssistantId).toBe("assistant-local");
    expect(
      useAgentConversationStore.getState().messageStates[localThreadId],
    ).toBeUndefined();
    expect(
      useChatStore.getState().externalSessionResolutions[localThreadId],
    ).toBe(sessionId);
  });

  it("migrates external session cache resolution through conversation messages", async () => {
    const { useChatStore } = await import(
      "@features/agent/store/chat-store"
    );
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
    );
    const { applyResolvedExternalSession, getResolvedExternalSessionId } =
      await import(
        "@features/agent/services/external-agent-runtime-service"
      );
    const localThreadId = "codex-local-cache-resolved";
    const sessionId = "codex-session-cache-resolved";

    useAgentConversationStore.getState().syncLiveMessageState(
      "codex",
      localThreadId,
      {
        messages: [
          {
            id: "assistant-cache-resolved",
            role: "assistant",
            content: "cache resolved message",
            timestamp: "2026-01-01T00:00:00.000Z",
          },
        ],
        pendingAssistantId: "assistant-cache-resolved",
        pendingReasoningId: null,
      },
    );
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
    expect(chatState.threadStates[sessionId]).toMatchObject({
      isLoading: true,
      activeRunId: "run-cache-resolved",
    });
    expect(chatState.threadStates[sessionId].messages).toEqual([]);

    const messageState =
      useAgentConversationStore.getState().messageStates[sessionId];
    expect(messageState.messages[0]).toMatchObject({
      id: "assistant-cache-resolved",
      content: "cache resolved message",
    });
    expect(messageState.pendingAssistantId).toBe("assistant-cache-resolved");
    expect(
      useAgentConversationStore.getState().messageStates[localThreadId],
    ).toBeUndefined();
  });

  it("keeps parallel Thread Card streams isolated by thread id", async () => {
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const store = useChatStore.getState();
    const firstThreadId = "thread-card-codex";
    const secondThreadId = "thread-card-flowix";

    store.bindThreadType(firstThreadId, "codex");
    store.bindThreadType(secondThreadId, "flowix");

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
    ).toBe("flowix");
  });

  it("loads Codex history through paged IPC", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
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
    expect(useChatStore.getState().threadStates[threadId].messages).toEqual(
      [],
    );
  });

  it("hydrates tool display when loading Codex history", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
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
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
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
    vi.mocked(agent.getClaudeThread).mockResolvedValueOnce({
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
    });

    await store.loadClaudeThread(threadId);

    const messages =
      useAgentConversationStore.getState().messageStates[threadId].messages;
    expect(messages.map((message) => message.id)).toEqual([
      "history-user",
      "history-tool-call",
      "history-assistant",
    ]);
    expect(messages.filter((message) => message.toolCallId === "toolu_1"))
      .toHaveLength(1);
    expect(messages.find((message) => message.toolCallId === "toolu_1"))
      .toMatchObject({
      role: "tool",
      toolCallId: "toolu_1",
      content: '{\n  "content": "file contents"\n}',
      isLoading: false,
    });
  });

  it("treats Codex text chunks as a final message instead of streaming deltas", async () => {
    const { useChatStore } = await import("@features/agent/store/chat-store");
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
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const store = useChatStore.getState();
    const threadId = "thread-card-tool";

    store.bindThreadType(threadId, "flowix");
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
      toolCallId: "tool-1",
      toolName: "shell",
      isLoading: false,
    });
    expect(
      threadState.runs[threadState.activeRunId ?? ""]?.currentTool,
    ).toBeNull();
  });

  it("normalizes Codex command tool input when arguments arrive as JSON text", async () => {
    const { useChatStore } = await import("@features/agent/store/chat-store");
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
    const { useChatStore } = await import("@features/agent/store/chat-store");
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
    const { useChatStore } = await import("@features/agent/store/chat-store");
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
    const { useChatStore } = await import("@features/agent/store/chat-store");
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
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const store = useChatStore.getState();

    // 鍒濆 activeAgentTypeKey (DEFAULT_AGENT_TYPE_KEY 閫氬父鏄?'flowix', 浣嗕笉渚濊禆鍏蜂綋鍊?
    const initialType = useChatStore.getState().activeAgentTypeKey;

    // 鍒囧埌 codex thread 鈹€鈹€ 浠呮洿鏂?activeThreadIds.codex, 涓嶅姩 activeAgentTypeKey銆?  
    store.setActiveCodexThreadId("codex-thread-1");
    expect(useChatStore.getState().activeThreadIds.codex).toBe("codex-thread-1");
    expect(useChatStore.getState().activeAgentTypeKey).toBe(initialType);

    // 鍒囧埌 flowix thread 鈹€鈹€ 鍚屾牱涓嶅姩 activeAgentTypeKey銆?  
    store.setActiveThreadId("flowix-thread-1");
    expect(useChatStore.getState().activeThreadIds.flowix).toBe("flowix-thread-1");
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
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const store = useChatStore.getState();

    // 鈹€鈹€ 鎯呭舰 1: 鍏ㄦ柊 thread, 浠庢湭璺戣繃銆?    vi.clearAllMocks();
    await store.stopThreadRun("thread-stop-empty");
    expect(agent.stopChatStream).toHaveBeenCalledWith(
      "thread-stop-empty",
      "flowix",
      undefined,
    );

    // 鈹€鈹€ 鎯呭舰 2: thread 璺戣繃浣嗗凡鑷劧缁撴潫銆?  
    const finishedThreadId = "thread-stop-already-ended";
    store.bindThreadType(finishedThreadId, "flowix");
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
      "flowix",
      undefined,
    );
  });

  it("sends Codex model and permission through runtime config", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/chat-store");
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

  it("passes enabled Files entries as Codex runtime workspaces", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const threadId = "thread-card-runtime-config-codex-workspaces";
    agentAccessMock.config = {
      entries: [
        {
          id: "nb-1",
          kind: "notebook",
          path: "D:\\notes\\main\\",
          name: "Main",
          enabled: true,
          missing: false,
        },
        {
          id: "folder-1",
          kind: "folder",
          path: "D:\\projects\\flowix",
          name: "Flowix",
          enabled: true,
          workspace: true,
          missing: false,
        },
        {
          id: "folder-disabled",
          kind: "folder",
          path: "D:\\disabled",
          name: "Disabled",
          enabled: false,
          missing: false,
        },
        {
          id: "folder-missing",
          kind: "folder",
          path: "D:\\missing",
          name: "Missing",
          enabled: true,
          missing: true,
        },
      ],
    };

    useChatStore.setState({
      threadTypes: { [threadId]: "codex" },
    });

    await useChatStore
      .getState()
      .sendMessageToThread(threadId, "hello workspaces", "codex");

    const calls = vi.mocked(agent.chatStream).mock.calls;
    const payload = calls[calls.length - 1]?.[1];
    expect(payload).toMatchObject({
      agentType: "codex",
      runtimeConfig: {
        codex: {
          cwd: "D:\\projects\\flowix",
          workspacePaths: ["D:\\notes\\main", "D:\\projects\\flowix"],
        },
      },
    });
  });

  it("uses the first enabled folder as cwd when no workspace is marked", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const threadId = "thread-card-runtime-config-first-folder";
    agentAccessMock.config = {
      entries: [
        {
          id: "nb-1",
          kind: "notebook",
          path: "D:\\notes\\main\\",
          name: "Main",
          enabled: true,
          missing: false,
        },
        {
          id: "folder-1",
          kind: "folder",
          path: "D:\\projects\\flowix\\",
          name: "Flowix",
          enabled: true,
          missing: false,
        },
      ],
    };

    useChatStore.setState({
      threadTypes: { [threadId]: "codex" },
    });

    await useChatStore
      .getState()
      .sendMessageToThread(threadId, "hello first folder", "codex");

    const calls = vi.mocked(agent.chatStream).mock.calls;
    const payload = calls[calls.length - 1]?.[1];
    expect(payload).toMatchObject({
      agentType: "codex",
      runtimeConfig: {
        codex: {
          cwd: "D:\\projects\\flowix",
          workspacePaths: ["D:\\notes\\main", "D:\\projects\\flowix"],
        },
      },
    });
  });

  it("renames local agent threads through the standard action", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/chat-store");
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
    expect(state.currentThreadTitles.gemini).toBe("New title");
    expect(state.threadLists.gemini?.[0]?.title).toBe("New title");
    expect(agent.updateThreadTitle).toHaveBeenCalledWith(
      threadId,
      "New title",
      "gemini",
    );
  });

  it("renames Agent conversations through the instance-backed action", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
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
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
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
    expect(useChatStore.getState().threadLists.codex?.[0]?.title).toBe(
      "Database title",
    );
  });

  it("rolls every title snapshot back when product persistence fails", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
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
        codex: "Original title",
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
    expect(useChatStore.getState().currentThreadTitles.codex).toBe(
      "Original title",
    );
    expect(
      useAgentConversationStore.getState().getInstance(instance.instanceId)
        ?.title,
    ).toBe("Original title");
  });

});

