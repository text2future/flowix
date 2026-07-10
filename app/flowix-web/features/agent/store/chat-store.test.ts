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
    deleteThread: vi.fn(),
    updateThreadTitle: vi.fn(),
    listConversationInstances: vi.fn(async () => []),
    getConversationInstance: vi.fn(async () => null),
    findConversationByThread: vi.fn(async () => null),
    findConversationByRun: vi.fn(async () => null),
    upsertConversationInstance: vi.fn(async () => undefined),
    upsertConversationRunState: vi.fn(async () => undefined),
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

  it("reconciles Agent conversation instances from backend running snapshot", async () => {
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const {
      useAgentConversationStore,
      selectRunningAgentConversationInstances,
    } = await import("@features/agent/store/agent-conversation-store");
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

    expect(
      selectRunningAgentConversationInstances(
        useAgentConversationStore.getState(),
      ),
    ).toMatchObject([
      {
        agentType: "flowix",
        title: "Snapshot restored title",
        threadId,
        source: { kind: "thread-card" },
        run: {
          runId: "run-snapshot-instance-running",
          status: "running",
          currentTool: "shell",
        },
      },
    ]);
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

  it("syncs usage totals into Agent conversation run after stream_end", async () => {
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
      input_tokens: 30,
      cached_input_tokens: 10,
      output_tokens: 12,
      reasoning_output_tokens: 0,
      total_tokens: 42,
    });

    const threadState = useChatStore.getState().threadStates[threadId];
    expect(threadState.lastRun?.tokenUsage?.total).toBe(42);
    expect(threadState.runs[runId]?.tokenUsage?.total).toBe(42);

    const runningInstance = useAgentConversationStore
      .getState()
      .getInstance(instance.instanceId);
    expect(runningInstance?.run?.totalTokens).toBeUndefined();

    useChatStore.getState().dispatchAgentChunk({
      kind: "stream_end",
      thread_id: threadId,
      run_id: runId,
      agent_type: "codex",
      reason: null,
    });

    const updatedInstance = useAgentConversationStore
      .getState()
      .getInstance(instance.instanceId);
    expect(updatedInstance?.run).toMatchObject({
      runId,
      totalTokens: 42,
      inputTokens: 30,
      cachedInputTokens: 10,
      outputTokens: 12,
      reasoningOutputTokens: 0,
    });
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
  });

  it("marks Agent conversation instances idle when backend snapshot no longer reports them", async () => {
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const {
      useAgentConversationStore,
      selectRunningAgentConversationInstances,
    } = await import("@features/agent/store/agent-conversation-store");
    const instanceStore = useAgentConversationStore.getState();
    const instance = instanceStore.createInstance({
      agentType: "flowix",
      title: "Snapshot cleanup",
      threadId: "thread-snapshot-instance",
      source: { kind: "thread-card" },
    });
    instanceStore.markRunStarted(instance.instanceId, {
      runId: "run-snapshot-instance",
      startedAt: 1234,
    });
    expect(
      selectRunningAgentConversationInstances(
        useAgentConversationStore.getState(),
      ),
    ).toHaveLength(1);

    useChatStore.getState().reconcileRunningRunsFromSnapshot({});

    const updated = useAgentConversationStore
      .getState()
      .getInstance(instance.instanceId);
    expect(updated?.run).toMatchObject({
      runId: "run-snapshot-instance",
      status: "completed",
      reason: "missing_from_snapshot",
    });
    expect(
      selectRunningAgentConversationInstances(
        useAgentConversationStore.getState(),
      ),
    ).toEqual([]);
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

  it("② deleteThread clears in-memory messages and runs", async () => {
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const store = useChatStore.getState();
    const threadId = "thread-delete-clears-state";

    // 创建一个有 content 的 thread, 然后 dispatch 一些 chunk 让 threadStates
    // 累积 messages / runs ── 这是 deleteThread 之前的状态。
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

    // rAF flush 让 text chunk 真正落到 messages / pendingAssistantId 上
    // (与 `routes streamed assistant text` 测试同形 ─ 离这块的话 text
    // 仍留在 textBuffer 里, before / after 断言会因时序不一致抖动)。
    await flushAnimationFrame();

    const before = useChatStore.getState().threadStates[threadId];
    expect(before.messages.length).toBeGreaterThan(0);
    expect(Object.keys(before.runs)).toContain("run-1");
    expect(before.isLoading).toBe(true);
    // pendingAssistantId 在 tool_call 之后被重置 ── 这是设计行为:
    // tool_call 之前到 tool_result 之间的 assistant 行不连续。
    // 我们关心的是"删除前 has accumulated state",用 messages 数 + runs
    // 长度已经能验证。 这里只验证 runs 有运行态 (activeRunId + status=running)。
    expect(before.activeRunId).toBe("run-1");
    expect(before.runs["run-1"]?.status).toBe("running");

    await store.deleteThread(threadId);

    // deleteThread 之后 (Week 1 #2 修复): entry 保留但 messages 清空,
    // 释放 24KB tool_data 累积。runs / pendingXxxId / isLoading 也要归零,
    // 防止 stopStream 后 flush 缓冲把文字写到已删 thread。
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
    // 修复 #7: deleteThread 之前没清 `state.threadTypes[threadId]`, 留下孤儿
    // 条目 ── 后续 `get().threadTypes[threadId] ?? "flowix"` 会拿到旧 type,
    // 误判 dispatch 路径。 同时反向映射 `externalSessionResolutions[pending] === threadId`
    // (即 pending 已经被 resolve 到这个被删的 thread) 也要清, 否则 findByThreadId
    // 会误命中已删 id。
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const store = useChatStore.getState();
    const threadId = "thread-delete-cleans-thread-types";
    const pendingThreadId = "codex-local-pending-orphan";

    store.bindThreadType(threadId, "codex");
    // 模拟一个 pending → session 已 resolve 过的状态, 且 session === threadId
    // (最常见的本地 thread 模式: pending id 是 `${type}-local-${Date.now()}`,
    // resolve 后变成真实 session_id, 此时 pending 仍然作为 mapping 留在
    // externalSessionResolutions 里)。
    useChatStore.setState((state) => ({
      ...state,
      externalSessionResolutions: {
        ...state.externalSessionResolutions,
        [pendingThreadId]: threadId, // 反向映射指向被删 thread
      },
    }));

    await store.deleteThread(threadId);

    const state = useChatStore.getState();
    // threadTypes 清理
    expect(state.threadTypes[threadId]).toBeUndefined();
    // 反向映射清理 ── `findByThreadId(threadId)` 不再命中已删 entry。
    expect(
      state.externalSessionResolutions[pendingThreadId],
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

  it("migrates a pending Codex thread to the resolved session id", async () => {
    const { useChatStore } = await import(
      "@features/agent/store/chat-store"
    );
    const {
      selectRunningAgentConversationThreadIds,
      useAgentConversationStore,
    } = await import("@features/agent/store/agent-conversation-store");
    const store = useChatStore.getState();
    const pendingThreadId = "codex-pending-store-session";
    const sessionId = "019f0000-0000-7000-8000-000000000000";
    const instance = useAgentConversationStore.getState().createInstance({
      agentType: "codex",
      title: "Pending Codex",
      threadId: pendingThreadId,
      source: {
        kind: "thread-card",
        memoId: "memo-running-session",
        documentPath: "/tmp/running-session.md",
      },
    });

    store.bindThreadType(pendingThreadId, "codex");
    store.dispatchAgentChunk({
      kind: "stream_start",
      thread_id: pendingThreadId,
      run_id: "run-pending-1",
      agent_type: "codex",
    });
    store.dispatchAgentChunk({
      kind: "text",
      thread_id: pendingThreadId,
      run_id: "run-pending-1",
      text: "Codex answer before session id",
      agent_type: "codex",
    });
    store.dispatchAgentChunk({
      kind: "session_resolved",
      thread_id: pendingThreadId,
      session_id: sessionId,
      run_id: "run-pending-1",
      agent_type: "codex",
    });

    const state = useChatStore.getState();
    expect(state.externalSessionResolutions[pendingThreadId]).toBe(sessionId);
    expect(state.activeThreadIds.codex).toBe(sessionId);
    expect(state.threadTypes[sessionId]).toBe("codex");
    expect(state.threadStates[sessionId].isLoading).toBe(true);
    expect(state.threadStates[sessionId].activeRunId).toBe("run-pending-1");
    expect(state.threadStates[sessionId].messages[0]?.content).toBe(
      "Codex answer before session id",
    );
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
      run: {
        runId: "run-pending-1",
        status: "running",
      },
    });
    expect(
      selectRunningAgentConversationThreadIds(
        useAgentConversationStore.getState(),
      ),
    ).toEqual([sessionId]);

    store.dispatchAgentChunk({
      kind: "stream_end",
      thread_id: pendingThreadId,
      run_id: "run-pending-1",
      reason: null,
      agent_type: "codex",
    });

    const endedState = useChatStore.getState();
    expect(endedState.threadStates[sessionId].isLoading).toBe(false);
    expect(endedState.threadStates[sessionId].activeRunId).toBeNull();
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
    const threadState = useChatStore.getState().threadStates[threadId];
    expect(threadState.messages[0]?.content).toBe("recent codex answer");
    expect(threadState.oldestSequence).toBe(42);
    expect(threadState.hasMoreHistory).toBe(true);
  });

  it("hydrates tool display when loading Codex history", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/chat-store");
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

    const message = useChatStore.getState().threadStates[threadId].messages[0];
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

  it("merges Claude history tool rows by toolCallId without appending duplicates", async () => {
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/chat-store");
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

    const messages = useChatStore.getState().threadStates[threadId].messages;
    expect(messages.map((message) => message.id)).toEqual([
      "tool-toolu_1",
      "history-user",
      "history-assistant",
    ]);
    expect(messages.filter((message) => message.toolCallId === "toolu_1"))
      .toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "tool",
      toolCallId: "toolu_1",
      content: "file contents",
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
    store.dispatchAgentChunk({ kind: "stream_start", thread_id: threadId });

    await useChatStore.getState().stopThreadRun(threadId);

    const threadState = useChatStore.getState().threadStates[threadId];
    expect(agent.stopChatStream).toHaveBeenCalledWith(
      threadId,
      "codex",
      threadState.activeRunId,
    );
    expect(threadState.isLoading).toBe(false);
    expect(threadState.runs[threadState.activeRunId ?? ""]?.status).toBe(
      "cancelled",
    );
  });

  it("setActiveThreadId / setActiveCodexThreadId do not change activeAgentTypeKey", async () => {
    // 修复 #12: 之前 `activeThreadUpdate` 把 `activeAgentTypeKey: type` 当
    // 副作用 ── 切到 codex thread 顺带把 activeAgentTypeKey 改成 codex。
    // 多 panel / 多 instance 并发场景下, 其中一个 panel 的 setActiveThreadId
    // 会污染另一个 panel 的 send 路径。
    //
    // 现在 `activeThreadUpdate` 只更新 activeThreadIds[type], activeAgentTypeKey
    // 由 setActiveAgentThread / setActiveAgentTypeKey 显式管理。
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const store = useChatStore.getState();

    // 初始 activeAgentTypeKey (DEFAULT_AGENT_TYPE_KEY 通常是 'flowix', 但不依赖具体值)
    const initialType = useChatStore.getState().activeAgentTypeKey;

    // 切到 codex thread ── 仅更新 activeThreadIds.codex, 不动 activeAgentTypeKey。
    store.setActiveCodexThreadId("codex-thread-1");
    expect(useChatStore.getState().activeThreadIds.codex).toBe("codex-thread-1");
    expect(useChatStore.getState().activeAgentTypeKey).toBe(initialType);

    // 切到 flowix thread ── 同样不动 activeAgentTypeKey。
    store.setActiveThreadId("flowix-thread-1");
    expect(useChatStore.getState().activeThreadIds.flowix).toBe("flowix-thread-1");
    expect(useChatStore.getState().activeAgentTypeKey).toBe(initialType);

    // setActiveAgentThread 仍然同步两者 ── 这是跨 runtime 切换的显式入口。
    store.setActiveAgentThread("codex", "codex-thread-2");
    expect(useChatStore.getState().activeThreadIds.codex).toBe("codex-thread-2");
    expect(useChatStore.getState().activeAgentTypeKey).toBe("codex");
  });

  it("stopThreadRun sends thread-wide IPC when no active run is recorded locally", async () => {
    // 修复 #9: 之前 `targetRunId` 早 return 后仍发 IPC, 后端走 thread-wide
    // stop 兜底, 是浪费。 现在 targetRunId 未解析时直接 return, 不发 IPC。
    // 验证两种情形:
    //   1. thread 完全没 dispatch 过 stream_start, 内部无 active run。
    //   2. thread 已 stream_end, activeRunId 被清, 也没东西可停。
    const { agent } = await import("@platform/tauri/client");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const store = useChatStore.getState();

    // ── 情形 1: 全新 thread, 从未跑过。
    vi.clearAllMocks();
    await store.stopThreadRun("thread-stop-empty");
    expect(agent.stopChatStream).toHaveBeenCalledWith(
      "thread-stop-empty",
      "flowix",
      undefined,
    );

    // ── 情形 2: thread 跑过但已自然结束。
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

});
