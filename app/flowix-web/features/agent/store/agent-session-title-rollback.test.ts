import { beforeEach, describe, expect, it, vi } from "vitest";

// describe 里的第一条用例，其 `beforeEach` 要独自承担整条 agent-session 模块图的
// 动态 import 开销（后续用例只是复用缓存）。实测：空闲时 19.4s，全量并发跑时
// 超过 60s。放宽的是模块图冷启动的预算，不是容忍逻辑死等。
vi.setConfig({ hookTimeout: 180_000 });

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
  cloud: { getAiCreditBalance: vi.fn(async () => ({ balanceMicrocredits: 0 })) },
  piModels: { list: vi.fn(async () => []), getFeatures: vi.fn(async () => ({})) },
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

vi.mock("@features/memo/store/note-store", () => ({
  useNoteStore: {
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
vi.mock("@features/document/store/document-session-service", () => ({
  getActiveDocumentDraft: () => null,
}));
vi.mock("@features/document/store/document-store", () => ({
  useDocumentStore: {
    getState: () => ({ currentDocumentPath: "" }),
  },
}));

vi.mock("@features/agent/store/agent-workspace-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@features/agent/store/agent-workspace-store")>();
  const getState = () => ({ ...actual.useAgentWorkspaceStore.getState(), workspaceActions: {
    ...actual.useAgentWorkspaceStore.getState().workspaceActions,
    getNotebookFiles: (notebookId: string | null | undefined) => notebookId
      ? agentAccessMock.config.defaults?.files?.[notebookId] : undefined,
  } });
  return { ...actual, ensureAgentWorkspaceReady: vi.fn(async () => {}), useAgentWorkspaceStore: Object.assign(
    (selector: Parameters<typeof actual.useAgentWorkspaceStore>[0]) => selector ? selector(getState()) : getState(),
    actual.useAgentWorkspaceStore,
    { getState },
  ) };
});

vi.mock("@features/preferences/store/user-settings-store", () => ({
  useUserSettingsStore: {
    getState: () => ({
      settings: { language: "zh-CN" },
    }),
  },
}));

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
