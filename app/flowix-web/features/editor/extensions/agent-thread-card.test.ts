import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentAccessState = vi.hoisted(() => ({
  config: { entries: [] as Array<Record<string, unknown>> },
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

vi.mock("@platform/tauri/client", () => ({
  agent: {
    chatStream: vi.fn(),
    stopChatStream: vi.fn(async () => true),
    runningThreads: vi.fn(async () => ({})),
    listThreads: vi.fn(async () => []),
    listCodexThreads: vi.fn(async () => []),
    listClaudeThreads: vi.fn(async () => []),
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
    getCodexSessionId: vi.fn(async () => null),
    getClaudeSessionId: vi.fn(async () => null),
    getCodexDefaultModel: vi.fn(async () => "gpt-5.5"),
    deleteThread: vi.fn(),
    updateThreadTitle: vi.fn(),
  },
  memos: {
    listAgentRoleMemos: vi.fn(async () => []),
  },
  listenToAgentStream: vi.fn(),
}));

vi.mock("@features/agent/store/agent-access-store", () => ({
  useAgentAccessStore: {
    getState: () => ({
      config: agentAccessState.config,
      isLoading: false,
      toggle: vi.fn(),
      setWorkspace: vi.fn(),
      addFolderFromPicker: vi.fn(async () => ({ ok: true })),
      removeFolder: vi.fn(),
      loadInitial: vi.fn(),
    }),
    subscribe: vi.fn(() => () => undefined),
  },
}));

vi.mock("@features/agent/store/agent-runtime-store", () => ({
  useAgentRuntimeStore: {
    getState: () => ({
      statusByType: {},
      refresh: vi.fn(),
      refreshIfStale: vi.fn(),
    }),
    subscribe: vi.fn(() => () => undefined),
  },
}));

vi.mock("@features/memo", () => ({
  useMemoStore: {
    getState: () => ({
      memos: [],
      selectedMemo: null,
      selectedNotebook: null,
      notebooks: [],
      loadNotebooks: vi.fn(async () => undefined),
    }),
    subscribe: vi.fn(() => () => undefined),
  },
}));

vi.mock("@features/memo/components/notebook-icon", () => ({
  getNotebookIconLetter: () => "N",
  getNotebookIconMarkup: () => null,
}));

vi.mock("@features/document/properties/property-icons", () => ({
  getPropertyIconOption: () => null,
}));

vi.mock("@features/document", () => ({
  getActiveDocumentDraft: () => null,
  useDocumentStore: {
    getState: () => ({
      currentDocumentPath: "",
    }),
  },
}));

vi.mock("@platform/open-target", () => ({
  openNoteByDeepLink: vi.fn(),
}));

vi.mock("@features/shortcuts", () => ({
  isWindowsPlatform: () => false,
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

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function seedRenderableMessages(
  typeKey: "flowix" | "codex" | "claude" | "gemini" | "hermes" | "openclaw",
  threadId: string,
  messages: any[],
): Promise<void> {
  const { useAgentConversationStore } = await import(
    "@features/agent/store/agent-conversation-store"
  );
  useAgentConversationStore
    .getState()
    .syncRenderableMessages(typeKey, threadId, messages);
}

describe("AgentThreadCard NodeView streaming", () => {
  let editor: Editor | null = null;

  it("persists the card title in markdown for reload", async () => {
    const {
      parseAgentThreadCardMarkdown,
      renderAgentThreadCardMarkdown,
    } = await import(
      "@features/editor/extensions/agent-thread-card/agent-thread-card-markdown"
    );

    const markdown = renderAgentThreadCardMarkdown({
      attrs: {
        instanceId: "instance-title-reload",
        threadId: "thread-title-reload",
        title: "Investigate refresh regression",
        typeKey: "codex",
        collapsed: false,
      },
    });

    expect(markdown).toContain('title="Investigate refresh regression"');
    expect(parseAgentThreadCardMarkdown({ attrs: markdown }).attrs.title).toBe(
      "Investigate refresh regression",
    );
  });

  beforeEach(async () => {
    document.body.innerHTML = "";
    localStorage.clear();

    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(performance.now()), 0);
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) =>
      window.clearTimeout(id),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );

    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
    );
    useChatStore.setState(useChatStore.getInitialState(), true);
    useAgentConversationStore.setState(
      useAgentConversationStore.getInitialState(),
      true,
    );
    agentAccessState.config = { entries: [] };
  });

  afterEach(() => {
    editor?.destroy();
    editor = null;
    vi.unstubAllGlobals();
    // Fake timer 兜底 ── 任何测试调用 vi.useFakeTimers() 但中途失败 /
    // 漏调 vi.useRealTimers() 时, 下一测试不会被 rAF setTimeout 卡住。
    vi.useRealTimers();
  });

  it("renders streamed assistant deltas in the Thread Card DOM", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const threadId = "thread-card-dom-flow";
    const host = document.createElement("div");
    document.body.append(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "DOM Flow",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });

    const card = host.querySelector<HTMLElement>(".agent-thread-card");
    expect(card).not.toBeNull();

    const store = useChatStore.getState();
    store.bindThreadType(threadId, "flowix");
    store.dispatchAgentChunk({ kind: "stream_start", thread_id: threadId });
    store.dispatchAgentChunk({
      kind: "text",
      thread_id: threadId,
      text: "Hel",
    });
    store.dispatchAgentChunk({
      kind: "text",
      thread_id: threadId,
      text: "lo from card",
    });

    await flushAnimationFrame();

    expect(
      card?.querySelector(".agent-thread-card__run-status--running"),
    ).not.toBeNull();
    expect(card?.classList.contains("agent-thread-card--running")).toBe(true);
    expect(
      card?.querySelector(".agent-thread-card__message--assistant")
        ?.textContent,
    ).toContain("Hello from card");

    store.dispatchAgentChunk({
      kind: "stream_end",
      thread_id: threadId,
      reason: null,
    });

    const idleStatus = card?.querySelector<HTMLElement>(
      ".agent-thread-card__run-status--idle",
    );
    expect(idleStatus).not.toBeNull();
    expect(idleStatus?.hidden).toBe(true);
    expect(idleStatus?.textContent).toBe("");
    expect(card?.classList.contains("agent-thread-card--running")).toBe(false);
  });

  it("patches the last rendered message without rebuilding previous message DOM", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const threadId = "thread-card-incremental-last-message";
    const host = document.createElement("div");
    document.body.append(host);

    const firstMessage = {
      id: "assistant-history",
      role: "assistant" as const,
      content: "stable history",
      timestamp: new Date().toISOString(),
    };
    const streamingMessage = {
      id: "assistant-streaming",
      role: "assistant" as const,
      content: "Hel",
      timestamp: new Date().toISOString(),
    };

    useChatStore.setState((state) => ({
      threadTypes: { ...state.threadTypes, [threadId]: "flowix" },
      threadStates: {
        ...state.threadStates,
        [threadId]: {
          messages: [],
          isLoading: true,
          activeRunId: "run-incremental",
          runs: {},
          pendingAssistantId: streamingMessage.id,
          pendingReasoningId: null,
          oldestSequence: null,
          hasMoreHistory: false,
          loadingMore: false,
        },
      },
    }));
    await seedRenderableMessages("flowix", threadId, [
      firstMessage,
      streamingMessage,
    ]);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Incremental",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });

    await flushAnimationFrame();

    const messagesBefore = host.querySelectorAll(".agent-thread-card__message");
    const firstMessageNode = messagesBefore[0];
    expect(firstMessageNode?.textContent).toContain("stable history");

    const patchedMessages = [
      firstMessage,
      { ...streamingMessage, content: "Hello incremental patch" },
    ];
    useChatStore.setState((state) => {
      const current = state.threadStates[threadId]!;
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...current,
            messages: [],
          },
        },
      };
    });
    await seedRenderableMessages("flowix", threadId, patchedMessages);

    await flushAnimationFrame();

    const messagesAfter = host.querySelectorAll(".agent-thread-card__message");
    expect(messagesAfter[0]).toBe(firstMessageNode);
    expect(messagesAfter[1]?.textContent).toContain("Hello incremental patch");
  });

  it("does not select the Thread Card when clicking messages while editing the title", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const threadId = "thread-card-title-edit-click-message";
    const host = document.createElement("div");
    document.body.append(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Editable title",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });

    const card = host.querySelector<HTMLElement>(".agent-thread-card");
    const title = card?.querySelector<HTMLElement>(".agent-thread-card__title");
    expect(card).not.toBeNull();
    expect(title).not.toBeNull();

    const store = useChatStore.getState();
    store.bindThreadType(threadId, "flowix");
    store.dispatchAgentChunk({ kind: "stream_start", thread_id: threadId });
    store.dispatchAgentChunk({
      kind: "text",
      thread_id: threadId,
      text: "clickable response",
    });
    store.dispatchAgentChunk({
      kind: "stream_end",
      thread_id: threadId,
      reason: null,
    });
    await flushAnimationFrame();

    title!.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
    );
    const titleInput = card!.querySelector<HTMLInputElement>(
      ".agent-thread-card__title-input",
    );
    const messageContent = card!.querySelector<HTMLElement>(
      ".agent-thread-card__message-content",
    );
    expect(titleInput).not.toBeNull();
    expect(messageContent).not.toBeNull();

    titleInput!.value = "Renamed title";
    messageContent!.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
    await flushPromises();

    expect(card!.classList.contains("ProseMirror-selectednode")).toBe(false);
    expect(card!.querySelector(".agent-thread-card__title-input")).toBeNull();
    expect(title!.textContent).toBe("Renamed title");
    expect(editor.getJSON().content?.[0]?.attrs?.title).toBe("Renamed title");
  });

  it("keeps the instance title when an existing conversation is rebound", async () => {
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
    );
    const { upsertAgentThreadCardConversationInstance } = await import(
      "@features/editor/extensions/agent-thread-card/runtime/thread-card-conversation"
    );
    const instance = useAgentConversationStore.getState().createInstance({
      agentType: "flowix",
      title: "User renamed title",
      threadId: "thread-existing-title",
      source: { kind: "thread-card" },
      role: { memoId: "role-old", name: "Old role" },
    });

    const result = upsertAgentThreadCardConversationInstance({
      instanceId: instance.instanceId,
      agentType: "flowix",
      title: "Prompt generated title",
      threadId: "thread-existing-title",
      source: { kind: "thread-card" },
      role: { memoId: "role-new", name: "New role" },
    });

    const updated = useAgentConversationStore
      .getState()
      .getInstance(result.instanceId);
    expect(result.created).toBe(false);
    expect(updated?.title).toBe("User renamed title");
    expect(updated?.role).toEqual({ memoId: "role-new", name: "New role" });
  });

  it("submits from the Thread Card and renders the response stream on the same card", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { agent } = await import("@platform/tauri/client");
    const threadId = "thread-card-submit-flow";
    const host = document.createElement("div");
    document.body.append(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Submit Flow",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });

    const card = host.querySelector<HTMLElement>(".agent-thread-card");
    const input = card?.querySelector<HTMLTextAreaElement>("textarea");
    const sendButton = card?.querySelector<HTMLButtonElement>(
      "button.agent-thread-card__send",
    );
    expect(card).not.toBeNull();
    expect(input).not.toBeNull();
    expect(sendButton).not.toBeNull();

    input!.value = "write a short answer";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    sendButton!.click();
    await flushPromises();

    expect(agent.chatStream).toHaveBeenCalledWith(
      threadId,
      expect.objectContaining({
        content: "write a short answer",
        agentType: "flowix",
        runtimeConfig: expect.objectContaining({
          flowix: expect.any(Object),
        }),
      }),
    );
    expect(
      card?.querySelector(".agent-thread-card__message--user")?.textContent,
    ).toContain("write a short answer");

    const store = useChatStore.getState();
    store.dispatchAgentChunk({ kind: "stream_start", thread_id: threadId });
    store.dispatchAgentChunk({
      kind: "text",
      thread_id: threadId,
      text: "Streamed answer",
    });
    await flushAnimationFrame();

    expect(
      card?.querySelector(".agent-thread-card__message--assistant")
        ?.textContent,
    ).toContain("Streamed answer");
  });

  it("persists short Thread Card composer drafts in node attrs", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const host = document.createElement("div");
    document.body.append(host);

    // inputDraft 落盘走 1s debounce ── 用 fake timer 推进时间。
    vi.useFakeTimers();

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId: "thread-card-draft",
              title: "Draft",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });

    const input = host.querySelector<HTMLTextAreaElement>(
      ".agent-thread-card textarea",
    );
    expect(input).not.toBeNull();

    input!.value = "unfinished message";
    input!.dispatchEvent(new Event("input", { bubbles: true }));

    // 立刻读还没落盘 ── debounce 期间 ProseMirror attr 保持旧值。
    expect(editor.getJSON().content?.[0]?.attrs?.inputDraft ?? null).toBeNull();

    vi.advanceTimersByTime(1100);

    expect(editor.getJSON().content?.[0]?.attrs?.inputDraft).toBe(
      "unfinished message",
    );

    vi.useRealTimers();
  });

  it("does not persist Thread Card composer drafts longer than 500 characters", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const host = document.createElement("div");
    document.body.append(host);

    vi.useFakeTimers();

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId: "thread-card-long-draft",
              title: "Long Draft",
              typeKey: "flowix",
              collapsed: false,
              inputDraft: "short",
            },
          },
        ],
      },
    });

    const input = host.querySelector<HTMLTextAreaElement>(
      ".agent-thread-card textarea",
    );
    expect(input).not.toBeNull();

    input!.value = "x".repeat(501);
    input!.dispatchEvent(new Event("input", { bubbles: true }));

    // debounce 期间 attr 仍是 "short", 推进 1s 后才被空字符串覆盖。
    expect(editor.getJSON().content?.[0]?.attrs?.inputDraft).toBe("short");
    vi.advanceTimersByTime(1100);
    expect(editor.getJSON().content?.[0]?.attrs?.inputDraft).toBeNull();
    expect(input!.value).toHaveLength(501);

    vi.useRealTimers();
  });

  it("clears persisted Thread Card composer draft after send", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const threadId = "thread-card-clear-draft";
    const host = document.createElement("div");
    document.body.append(host);

    vi.useFakeTimers();

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Clear Draft",
              typeKey: "flowix",
              collapsed: false,
              inputDraft: "send me",
            },
          },
        ],
      },
    });

    const input = host.querySelector<HTMLTextAreaElement>(
      ".agent-thread-card textarea",
    );
    const sendButton = host.querySelector<HTMLButtonElement>(
      "button.agent-thread-card__send",
    );
    expect(input?.value).toBe("send me");
    expect(sendButton).not.toBeNull();

    sendButton!.click();
    // submit() 内部会 flushPendingDraft ── 立刻清空 attr, 不等 1s。
    vi.advanceTimersByTime(0);

    expect(editor.getJSON().content?.[0]?.attrs?.inputDraft).toBeNull();
    expect(input!.value).toBe("");

    vi.useRealTimers();
  });

  it("submits Codex Thread Card messages with Files workspace runtime config", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { agent } = await import("@platform/tauri/client");
    const threadId = "thread-card-submit-codex-workspace";
    agentAccessState.config = {
      entries: [
        {
          id: "folder-main",
          kind: "folder",
          path: "D:\\workspace\\main\\",
          name: "Main",
          enabled: true,
          workspace: true,
          missing: false,
        },
        {
          id: "folder-extra",
          kind: "folder",
          path: "D:\\workspace\\extra",
          name: "Extra",
          enabled: true,
          workspace: false,
          missing: false,
        },
      ],
    };
    const host = document.createElement("div");
    document.body.append(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Codex Workspace",
              typeKey: "codex",
              collapsed: false,
            },
          },
        ],
      },
    });

    const card = host.querySelector<HTMLElement>(".agent-thread-card");
    const input = card?.querySelector<HTMLTextAreaElement>("textarea");
    const sendButton = card?.querySelector<HTMLButtonElement>(
      "button.agent-thread-card__send",
    );
    expect(input).not.toBeNull();
    expect(sendButton).not.toBeNull();

    input!.value = "check workspace";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    sendButton!.click();
    await flushPromises();

    expect(agent.chatStream).toHaveBeenCalledWith(
      threadId,
      expect.objectContaining({
        content: "check workspace",
        agentType: "codex",
        runtimeConfig: {
          codex: expect.objectContaining({
            cwd: "D:\\workspace\\main",
            workspacePaths: ["D:\\workspace\\main", "D:\\workspace\\extra"],
          }),
        },
      }),
    );
  });

  it("renders Codex command tool calls with JSON-string arguments in Thread Card DOM", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const threadId = "thread-card-dom-codex-command-json";
    const host = document.createElement("div");
    document.body.append(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Codex Command",
              typeKey: "codex",
              collapsed: false,
            },
          },
        ],
      },
    });

    const card = host.querySelector<HTMLElement>(".agent-thread-card");
    const store = useChatStore.getState();
    store.bindThreadType(threadId, "codex");
    store.dispatchAgentChunk({
      kind: "stream_start",
      thread_id: threadId,
      agent_type: "codex",
    });
    store.dispatchAgentChunk({
      kind: "tool_call",
      thread_id: threadId,
      id: "codex-command",
      name: "shell_command",
      input: '{"command":"npm run build"}' as unknown as Record<
        string,
        unknown
      >,
      agent_type: "codex",
    });

    await flushAnimationFrame();

    const toolMessage = card?.querySelector(".agent-thread-card__message--tool");
    expect(
      toolMessage?.querySelector(".agent-thread-card__command-name")
        ?.textContent,
    ).toBe("npm");
    expect(
      toolMessage?.querySelector(".agent-thread-card__command-args-inline")
        ?.textContent,
    ).toBe("run build");
  });

  it("canonicalizes a Codex local Thread Card id to the external session id before loading history", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { agent } = await import("@platform/tauri/client");
    const localThreadId = "codex-local-card-session";
    const sessionId = "codex-session-card-session";
    const host = document.createElement("div");
    document.body.append(host);

    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 50 });
      return 1;
    });
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    (
      agent.getCodexSessionId as unknown as {
        mockResolvedValueOnce: (value: unknown) => void;
      }
    ).mockResolvedValueOnce(sessionId);
    (
      agent.getCodexThreadPage as unknown as {
        mockResolvedValueOnce: (value: unknown) => void;
      }
    ).mockResolvedValueOnce({
      messages: [
        {
          id: "assistant-history",
          role: "assistant",
          content: "restored codex history",
          timestamp: new Date().toISOString(),
        },
      ],
      oldestSequence: null,
      hasMore: false,
    });

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId: localThreadId,
              title: "Codex Session",
              typeKey: "codex",
              collapsed: false,
            },
          },
        ],
      },
    });

    await flushPromises();
    await flushAnimationFrame();

    const card = host.querySelector<HTMLElement>(".agent-thread-card");
    expect(editor.getJSON().content?.[0]?.attrs?.threadId).toBe(sessionId);
    expect(card?.dataset.threadId).toBe(sessionId);
    expect(agent.getCodexThreadPage).toHaveBeenCalledWith(
      sessionId,
      null,
      expect.any(Number),
    );
    expect(agent.getCodexThreadPage).not.toHaveBeenCalledWith(
      localThreadId,
      null,
      expect.any(Number),
    );
    expect(card?.textContent).toContain("restored codex history");
  });

  it("defers loading Thread Card history while the card starts collapsed until expanded", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { agent } = await import("@platform/tauri/client");
    const threadId = "thread-card-collapsed-history";
    const host = document.createElement("div");
    document.body.append(host);

    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 50 });
      return 1;
    });
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    const getThreadMock = agent.getThread as unknown as {
      mockClear: () => void;
    };
    const getThreadPageMock = agent.getThreadPage as unknown as {
      mockClear: () => void;
    };
    getThreadMock.mockClear();
    getThreadPageMock.mockClear();

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Collapsed History",
              typeKey: "flowix",
              collapsed: true,
            },
          },
        ],
      },
    });

    await flushPromises();
    await flushAnimationFrame();

    expect(agent.getThreadPage).not.toHaveBeenCalled();

    host
      .querySelector<HTMLButtonElement>(".agent-thread-card__collapse")
      ?.click();

    await flushPromises();
    await flushAnimationFrame();

    expect(agent.getThreadPage).toHaveBeenCalledWith(threadId, null, 10);
  });

  it("rerenders cached messages when expanding a previously loaded collapsed Thread Card", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { agent } = await import("@platform/tauri/client");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
    );
    const threadId = "thread-card-expand-rerender-cache";
    const host = document.createElement("div");
    document.body.append(host);

    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 50 });
      return 1;
    });
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    const getThreadPageMock = agent.getThreadPage as unknown as {
      mockClear: () => void;
    };
    getThreadPageMock.mockClear();

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Cached",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });

    await flushPromises();
    await flushAnimationFrame();

    useAgentConversationStore.getState().syncRenderableMessages("flowix", threadId, [
      {
        id: "assistant-cached",
        role: "assistant",
        content: "cached answer after finish",
        timestamp: new Date().toISOString(),
      },
    ]);

    await flushPromises();
    await flushAnimationFrame();

    const card = host.querySelector<HTMLElement>(".agent-thread-card");
    expect(card?.textContent).toContain("cached answer after finish");

    host
      .querySelector<HTMLButtonElement>(".agent-thread-card__collapse")
      ?.click();

    await flushPromises();
    await flushAnimationFrame();

    expect(
      card?.querySelector(".agent-thread-card__message-content"),
    ).toBeNull();

    getThreadPageMock.mockClear();

    host
      .querySelector<HTMLButtonElement>(".agent-thread-card__collapse")
      ?.click();

    await flushPromises();
    await flushAnimationFrame();

    expect(agent.getThreadPage).not.toHaveBeenCalled();
    expect(card?.textContent).toContain("cached answer after finish");
  });

  it("shows a static skeleton while an expanded Thread Card loads history", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { agent } = await import("@platform/tauri/client");
    const threadId = "thread-card-skeleton-history";
    const host = document.createElement("div");
    document.body.append(host);

    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 50 });
      return 1;
    });
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    let resolveThread: (value: { messages: [] }) => void = () => undefined;
    const getThreadMock = agent.getThread as unknown as {
      mockClear: () => void;
      mockImplementationOnce: (
        implementation: () => Promise<{ messages: [] }>,
      ) => void;
    };
    getThreadMock.mockClear();
    getThreadMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveThread = resolve;
        }),
    );

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Skeleton History",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });

    const card = host.querySelector<HTMLElement>(".agent-thread-card");
    expect(
      card?.classList.contains("agent-thread-card--thread-cache-loading"),
    ).toBe(true);
    expect(card?.querySelector(".agent-thread-card__skeleton")).not.toBeNull();
    expect(
      card?.querySelectorAll(".agent-thread-card__skeleton-line").length,
    ).toBe(3);

    resolveThread({ messages: [] });
    await flushPromises();
    await flushAnimationFrame();

    expect(card?.querySelector(".agent-thread-card__skeleton")).toBeNull();
  });

  it("shows the loading skeleton when a collapsed Thread Card enters fullscreen", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { agent } = await import("@platform/tauri/client");
    const threadId = "thread-card-fullscreen-skeleton-history";
    const host = document.createElement("div");
    document.body.append(host);

    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 50 });
      return 1;
    });
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    let resolveThread: (value: {
      messages: [];
      oldestSequence: null;
      hasMore: false;
    }) => void = () => undefined;
    const getThreadPageMock = agent.getThreadPage as unknown as {
      mockClear: () => void;
      mockImplementationOnce: (
        implementation: () => Promise<{
          messages: [];
          oldestSequence: null;
          hasMore: false;
        }>,
      ) => void;
    };
    getThreadPageMock.mockClear();
    getThreadPageMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveThread = resolve;
        }),
    );

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Fullscreen Skeleton",
              typeKey: "flowix",
              collapsed: true,
            },
          },
        ],
      },
    });

    const card = host.querySelector<HTMLElement>(".agent-thread-card");
    expect(card?.querySelector(".agent-thread-card__skeleton")).toBeNull();

    host
      .querySelector<HTMLButtonElement>(".agent-thread-card__fullscreen")
      ?.click();

    await flushPromises();
    await flushAnimationFrame();

    expect(card?.classList.contains("agent-thread-card--fullscreen")).toBe(
      true,
    );
    expect(card?.querySelector(".agent-thread-card__skeleton")).not.toBeNull();

    resolveThread({ messages: [], oldestSequence: null, hasMore: false });
    await flushPromises();
    await flushAnimationFrame();

    expect(card?.querySelector(".agent-thread-card__skeleton")).toBeNull();
  });

  it("defers expanded Thread Card history loading until the card is near the viewport", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { agent } = await import("@platform/tauri/client");
    const threadId = "thread-card-viewport-history";
    const host = document.createElement("div");
    document.body.append(host);

    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 50 });
      return 1;
    });
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    let triggerIntersection: (isIntersecting: boolean) => void =
      () => undefined;
    class MockIntersectionObserver {
      readonly callback: IntersectionObserverCallback;

      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        triggerIntersection = (isIntersecting: boolean) => {
          callback(
            [
              {
                isIntersecting,
              } as IntersectionObserverEntry,
            ],
            this as unknown as IntersectionObserver,
          );
        };
      }

      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

    const getThreadMock = agent.getThread as unknown as {
      mockClear: () => void;
    };
    const getThreadPageMock = agent.getThreadPage as unknown as {
      mockClear: () => void;
    };
    getThreadMock.mockClear();
    getThreadPageMock.mockClear();

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Viewport History",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });

    await flushPromises();
    await flushAnimationFrame();

    expect(agent.getThreadPage).not.toHaveBeenCalled();

    triggerIntersection(true);
    await flushPromises();
    await flushAnimationFrame();

    expect(agent.getThreadPage).toHaveBeenCalledWith(threadId, null, 10);
  });

  it("loads Thread Card history when a collapsed card enters fullscreen", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { agent } = await import("@platform/tauri/client");
    const threadId = "thread-card-fullscreen-history";
    const host = document.createElement("div");
    document.body.append(host);

    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 50 });
      return 1;
    });
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    const getThreadMock = agent.getThread as unknown as {
      mockClear: () => void;
    };
    const getThreadPageMock = agent.getThreadPage as unknown as {
      mockClear: () => void;
    };
    getThreadMock.mockClear();
    getThreadPageMock.mockClear();

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Fullscreen History",
              typeKey: "flowix",
              collapsed: true,
            },
          },
        ],
      },
    });

    await flushPromises();
    await flushAnimationFrame();

    expect(agent.getThreadPage).not.toHaveBeenCalled();

    host
      .querySelector<HTMLButtonElement>(".agent-thread-card__fullscreen")
      ?.click();

    await flushPromises();
    await flushAnimationFrame();

    expect(agent.getThreadPage).toHaveBeenCalledWith(threadId, null, 10);
  });

  it("does not move the editor selection after entering or exiting fullscreen", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const threadId = "thread-card-fullscreen-selection";
    const host = document.createElement("div");
    document.body.append(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "before" }],
          },
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Fullscreen Selection",
              typeKey: "flowix",
              collapsed: false,
            },
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "after" }],
          },
        ],
      },
    });

    editor.commands.setTextSelection(2);
    const selectionBefore = editor.state.selection.toJSON();

    host
      .querySelector<HTMLButtonElement>(".agent-thread-card__fullscreen")
      ?.click();
    await flushAnimationFrame();

    expect(editor.state.selection.toJSON()).toEqual(selectionBefore);

    host
      .querySelector<HTMLButtonElement>(".agent-thread-card__fullscreen")
      ?.click();
    await flushAnimationFrame();

    expect(editor.state.selection.toJSON()).toEqual(selectionBefore);
  });

  it("does not refocus the editor when clicking non-interactive card content", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const host = document.createElement("div");
    document.body.append(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "before" }],
          },
          {
            type: "agentThreadCard",
            attrs: {
              threadId: "thread-card-click-focus",
              title: "Click Focus",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });

    const focusSpy = vi.spyOn(editor.view, "focus");
    const body = host.querySelector<HTMLElement>(".agent-thread-card__body");
    expect(body).not.toBeNull();

    body!.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );

    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("keeps card mousedown events from bubbling to the editor host", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const host = document.createElement("div");
    document.body.append(host);
    const hostMouseDown = vi.fn();
    host.addEventListener("mousedown", hostMouseDown);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId: "thread-card-event-boundary",
              title: "Event Boundary",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });

    const body = host.querySelector<HTMLElement>(".agent-thread-card__body");
    expect(body).not.toBeNull();

    body!.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );

    expect(hostMouseDown).not.toHaveBeenCalled();
  });

  it("blurs a focused card input before outside pointer interactions", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const host = document.createElement("div");
    host.className = "editor-content";
    document.body.append(host);
    const outsideButton = document.createElement("button");
    document.body.append(outsideButton);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId: "thread-card-outside-blur",
              title: "Outside Blur",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });

    const input = host.querySelector<HTMLTextAreaElement>(
      ".agent-thread-card textarea",
    );
    expect(input).not.toBeNull();
    host.scrollTop = 123;
    input!.focus();
    expect(document.activeElement).toBe(input);

    outsideButton.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
    await flushAnimationFrame();
    await flushPromises();

    expect(document.activeElement).not.toBe(input);
    expect(host.scrollTop).toBe(123);
  });

  it("keeps a new Codex Thread Card without a document threadId until the session id is known", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { agent } = await import("@platform/tauri/client");
    const sessionId = "codex-session-after-first-run";
    const host = document.createElement("div");
    document.body.append(host);

    const chatStreamMock = agent.chatStream as unknown as {
      mockClear: () => void;
      mock: { calls: Array<[string, { runId?: string }]> };
    };
    const getCodexSessionIdMock = agent.getCodexSessionId as unknown as {
      mockClear: () => void;
      mockResolvedValueOnce: (value: unknown) => void;
    };
    chatStreamMock.mockClear();
    getCodexSessionIdMock.mockClear();

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId: null,
              title: "AI 对话",
              typeKey: "codex",
              collapsed: false,
            },
          },
        ],
      },
    });

    const card = host.querySelector<HTMLElement>(".agent-thread-card");
    const input = card?.querySelector<HTMLTextAreaElement>("textarea");
    const sendButton = card?.querySelector<HTMLButtonElement>(
      "button.agent-thread-card__send",
    );
    expect(input).not.toBeNull();
    expect(sendButton).not.toBeNull();

    input!.value = "first codex request";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    sendButton!.click();
    await flushPromises();

    const pendingThreadId = chatStreamMock.mock.calls[0]?.[0] as string;
    const runId = chatStreamMock.mock.calls[0]?.[1]?.runId;
    expect(pendingThreadId).toMatch(/^codex-pending-/);
    expect(editor.getJSON().content?.[0]?.attrs?.threadId).toBe(pendingThreadId);
    expect(editor.getJSON().content?.[0]?.attrs?.instanceId).toMatch(/^agent-inst-/);
    expect(card?.dataset.threadId).toBe(pendingThreadId);
    expect(card?.dataset.instanceId).toMatch(/^agent-inst-/);
    expect(card?.textContent).toContain("first codex request");

    const store = useChatStore.getState();
    store.dispatchAgentChunk({
      kind: "stream_start",
      thread_id: pendingThreadId,
      run_id: runId,
      agent_type: "codex",
    });
    store.dispatchAgentChunk({
      kind: "session_resolved",
      thread_id: pendingThreadId,
      session_id: sessionId,
      run_id: runId,
      agent_type: "codex",
    });
    store.dispatchAgentChunk({
      kind: "stream_end",
      thread_id: pendingThreadId,
      run_id: runId,
      reason: null,
      agent_type: "codex",
    });
    await flushPromises();
    await flushAnimationFrame();

    expect(editor.getJSON().content?.[0]?.attrs?.threadId).toBe(sessionId);
    expect(card?.dataset.threadId).toBe(sessionId);
    expect(card?.textContent).toContain("first codex request");
    expect(agent.getCodexSessionId).not.toHaveBeenCalled();
  });

  it("falls back instead of crashing when one Thread Card message cannot be rendered", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const threadId = "thread-card-dom-message-fallback";
    const host = document.createElement("div");
    document.body.append(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Fallback",
              typeKey: "codex",
              collapsed: false,
            },
          },
        ],
      },
    });

    const brokenInput = {};
    Object.defineProperty(brokenInput, "command", {
      enumerable: true,
      get() {
        throw new Error("bad command getter");
      },
    });

    const messages = [
      {
        id: "tool-broken",
        role: "tool" as const,
        content: "",
        timestamp: new Date().toISOString(),
        toolCallId: "tool-broken",
        toolName: "shell_command",
        toolInput: brokenInput,
      },
      {
        id: "assistant-after-broken",
        role: "assistant" as const,
        content: "still renders",
        timestamp: new Date().toISOString(),
      },
    ];

    useChatStore.setState((state) => ({
      threadTypes: { ...state.threadTypes, [threadId]: "codex" },
      threadStates: {
        ...state.threadStates,
        [threadId]: {
          messages: [],
          isLoading: false,
          activeRunId: null,
          runs: {},
          pendingAssistantId: null,
          pendingReasoningId: null,
          oldestSequence: null,
          hasMoreHistory: false,
          loadingMore: false,
        },
      },
    }));
    await seedRenderableMessages("codex", threadId, messages);

    await flushAnimationFrame();

    expect(host.querySelector(".agent-thread-card")?.textContent).toContain(
      "still renders",
    );
    expect(host.querySelectorAll(".agent-thread-card__message")).toHaveLength(
      2,
    );
  });
});

/**
 * 输入历史导航 ── 用 ↑/↓ 在 user 消息列表中翻, 越过末尾恢复 preNavDraft。
 * 详见 AgentThreadCardView 的 historyCursor / preNavDraft 字段注释。
 */
describe("AgentThreadCard input history navigation", () => {
  let editor: Editor | null = null;

  beforeEach(async () => {
    document.body.innerHTML = "";
    localStorage.clear();

    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(performance.now()), 0);
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) =>
      window.clearTimeout(id),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );

    const { useChatStore } = await import("@features/agent/store/chat-store");
    useChatStore.setState(useChatStore.getInitialState(), true);
    agentAccessState.config = { entries: [] };
  });

  afterEach(() => {
    editor?.destroy();
    editor = null;
    vi.unstubAllGlobals();
    // Fake timer 兜底 ── 任何测试调用 vi.useFakeTimers() 但中途失败 /
    // 漏调 vi.useRealTimers() 时, 下一测试不会被 rAF setTimeout 卡住。
    vi.useRealTimers();
  });

  function dispatchKey(input: HTMLTextAreaElement, key: string): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    return event;
  }

  function typeText(input: HTMLTextAreaElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("does nothing when the thread has no user messages", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const threadId = "thread-card-history-empty";
    const host = document.createElement("div");
    document.body.append(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Empty",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });
    await flushAnimationFrame();

    const input = host.querySelector<HTMLTextAreaElement>(
      ".agent-thread-card__composer textarea",
    )!;
    typeText(input, "draft");
    dispatchKey(input, "ArrowUp");

    expect(input.value).toBe("draft");
  });

  it("Up on empty input fills with the most recent user message", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const threadId = "thread-card-history-up-empty";
    const host = document.createElement("div");
    document.body.append(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "History",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });
    await flushAnimationFrame();

    const messages = [
      {
        role: "user" as const,
        content:
          "first question\n<## CONTEXT PROMPT ##>\n当前笔记路径: hidden\n\n# flowix CLI\nhidden",
        id: "u0",
        timestamp: "t0",
      },
      { role: "assistant" as const, content: "answer", id: "a0", timestamp: "t1" },
      {
        role: "user" as const,
        content: "second question",
        id: "u1",
        timestamp: "t2",
      },
    ];

    useChatStore.setState((state) => ({
      threadStates: {
        ...state.threadStates,
        [threadId]: {
          messages: [],
          isLoading: false,
          activeRunId: null,
          runs: {},
          pendingAssistantId: null,
          pendingReasoningId: null,
          oldestSequence: null,
          hasMoreHistory: false,
          loadingMore: false,
        },
      },
    }));
    await seedRenderableMessages("flowix", threadId, messages);
    await flushAnimationFrame();

    const input = host.querySelector<HTMLTextAreaElement>(
      ".agent-thread-card__composer textarea",
    )!;
    expect(input.value).toBe("");

    dispatchKey(input, "ArrowUp");
    expect(input.value).toBe("second question");

    dispatchKey(input, "ArrowUp");
    expect(input.value).toBe("first question");

    // 已经在最老一条, 再按 Up 应该 clamp 不动。
    dispatchKey(input, "ArrowUp");
    expect(input.value).toBe("first question");
  });

  it("saves the existing draft as preNavDraft and restores it on Down past newest", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const threadId = "thread-card-history-draft-roundtrip";
    const host = document.createElement("div");
    document.body.append(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Draft",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });
    await flushAnimationFrame();

    const messages = [
      { role: "user" as const, content: "older", id: "u0", timestamp: "t0" },
      { role: "user" as const, content: "newer", id: "u1", timestamp: "t1" },
    ];

    useChatStore.setState((state) => ({
      threadStates: {
        ...state.threadStates,
        [threadId]: {
          messages: [],
          isLoading: false,
          activeRunId: null,
          runs: {},
          pendingAssistantId: null,
          pendingReasoningId: null,
          oldestSequence: null,
          hasMoreHistory: false,
          loadingMore: false,
        },
      },
    }));
    await seedRenderableMessages("flowix", threadId, messages);
    await flushAnimationFrame();

    const input = host.querySelector<HTMLTextAreaElement>(
      ".agent-thread-card__composer textarea",
    )!;
    typeText(input, "my draft");
    dispatchKey(input, "ArrowUp");
    expect(input.value).toBe("newer");

    dispatchKey(input, "ArrowUp");
    expect(input.value).toBe("older");

    dispatchKey(input, "ArrowDown");
    expect(input.value).toBe("newer");

    // 越过最新一条 → 恢复进入 nav 之前的草稿。
    dispatchKey(input, "ArrowDown");
    expect(input.value).toBe("my draft");
  });

  it("does not persist previewed history entries over the latest draft", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const threadId = "thread-card-history-draft-not-overwritten";
    const host = document.createElement("div");
    document.body.append(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Draft not overwritten",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });
    await flushAnimationFrame();

    const messages = [
      { role: "user" as const, content: "older", id: "u0", timestamp: "t0" },
      { role: "user" as const, content: "newer", id: "u1", timestamp: "t1" },
    ];

    useChatStore.setState((state) => ({
      threadStates: {
        ...state.threadStates,
        [threadId]: {
          messages: [],
          isLoading: false,
          activeRunId: null,
          runs: {},
          pendingAssistantId: null,
          pendingReasoningId: null,
          oldestSequence: null,
          hasMoreHistory: false,
          loadingMore: false,
        },
      },
    }));
    await seedRenderableMessages("flowix", threadId, messages);
    await flushAnimationFrame();

    const input = host.querySelector<HTMLTextAreaElement>(
      ".agent-thread-card__composer textarea",
    )!;

    vi.useFakeTimers();

    typeText(input, "my latest draft");
    await vi.advanceTimersByTimeAsync(1000);
    expect(editor.getJSON().content?.[0]?.attrs?.inputDraft).toBe(
      "my latest draft",
    );

    dispatchKey(input, "ArrowUp");
    expect(input.value).toBe("newer");
    await vi.advanceTimersByTimeAsync(1000);
    expect(input.value).toBe("newer");
    expect(editor.getJSON().content?.[0]?.attrs?.inputDraft).toBe(
      "my latest draft",
    );

    dispatchKey(input, "ArrowDown");
    expect(input.value).toBe("my latest draft");

    dispatchKey(input, "ArrowDown");
    expect(input.value).toBe("my latest draft");

    dispatchKey(input, "ArrowUp");
    expect(input.value).toBe("newer");

    dispatchKey(input, "ArrowDown");
    expect(input.value).toBe("my latest draft");

    vi.useRealTimers();
  });

  it("treats Down as a no-op when not navigating", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const threadId = "thread-card-history-down-idle";
    const host = document.createElement("div");
    document.body.append(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Down idle",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });
    await flushAnimationFrame();

    const messages = [
      { role: "user" as const, content: "only one", id: "u0", timestamp: "t0" },
    ];

    useChatStore.setState((state) => ({
      threadStates: {
        ...state.threadStates,
        [threadId]: {
          messages: [],
          isLoading: false,
          activeRunId: null,
          runs: {},
          pendingAssistantId: null,
          pendingReasoningId: null,
          oldestSequence: null,
          hasMoreHistory: false,
          loadingMore: false,
        },
      },
    }));
    await seedRenderableMessages("flowix", threadId, messages);
    await flushAnimationFrame();

    const input = host.querySelector<HTMLTextAreaElement>(
      ".agent-thread-card__composer textarea",
    )!;
    typeText(input, "draft");
    // 未进入 nav 态, Down 不动作 (preventDefault 仍调用, 所以光标不移动)。
    dispatchKey(input, "ArrowDown");
    expect(input.value).toBe("draft");
  });

  it("typing in nav mode exits navigation but keeps the edited text", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const threadId = "thread-card-history-typing-exits";
    const host = document.createElement("div");
    document.body.append(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Typing",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });
    await flushAnimationFrame();

    const messages = [
      { role: "user" as const, content: "first", id: "u0", timestamp: "t0" },
      { role: "user" as const, content: "second", id: "u1", timestamp: "t1" },
    ];

    useChatStore.setState((state) => ({
      threadStates: {
        ...state.threadStates,
        [threadId]: {
          messages: [],
          isLoading: false,
          activeRunId: null,
          runs: {},
          pendingAssistantId: null,
          pendingReasoningId: null,
          oldestSequence: null,
          hasMoreHistory: false,
          loadingMore: false,
        },
      },
    }));
    await seedRenderableMessages("flowix", threadId, messages);
    await flushAnimationFrame();

    const input = host.querySelector<HTMLTextAreaElement>(
      ".agent-thread-card__composer textarea",
    )!;
    dispatchKey(input, "ArrowUp");
    expect(input.value).toBe("second");

    // 用户在历史条目上追加内容 ── input 事件把 historyCursor 清回 null,
    // 退出 nav 态; 当前编辑内容保留。
    typeText(input, "second (edited)");
    expect(input.value).toBe("second (edited)");

    // 再次按 Up: 重新拍 preNavDraft, 跳到最新 user 消息。
    dispatchKey(input, "ArrowUp");
    expect(input.value).toBe("second");
  });

  it("lets native Up and Down move the caret until the composer reaches a boundary line", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const threadId = "thread-card-history-caret-boundaries";
    const host = document.createElement("div");
    document.body.append(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Caret boundaries",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });
    await flushAnimationFrame();

    const messages = [
      { role: "user" as const, content: "older", id: "u0", timestamp: "t0" },
      { role: "user" as const, content: "newer\nline", id: "u1", timestamp: "t1" },
    ];

    useChatStore.setState((state) => ({
      threadStates: {
        ...state.threadStates,
        [threadId]: {
          messages: [],
          isLoading: false,
          activeRunId: null,
          runs: {},
          pendingAssistantId: null,
          pendingReasoningId: null,
          oldestSequence: null,
          hasMoreHistory: false,
          loadingMore: false,
        },
      },
    }));
    await seedRenderableMessages("flowix", threadId, messages);
    await flushAnimationFrame();

    const input = host.querySelector<HTMLTextAreaElement>(
      ".agent-thread-card__composer textarea",
    )!;

    typeText(input, "draft\nmiddle\nend");
    input.setSelectionRange("draft\n".length, "draft\n".length);
    const middleUp = dispatchKey(input, "ArrowUp");
    expect(middleUp.defaultPrevented).toBe(false);
    expect(input.value).toBe("draft\nmiddle\nend");

    input.setSelectionRange("draft\nmiddle".length, "draft\nmiddle".length);
    const middleDown = dispatchKey(input, "ArrowDown");
    expect(middleDown.defaultPrevented).toBe(false);
    expect(input.value).toBe("draft\nmiddle\nend");

    input.setSelectionRange(0, 0);
    const boundaryUp = dispatchKey(input, "ArrowUp");
    expect(boundaryUp.defaultPrevented).toBe(true);
    expect(input.value).toBe("newer\nline");
  });

  it("keeps the current history position when the selected history text is not modified", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const threadId = "thread-card-history-unmodified-entry";
    const host = document.createElement("div");
    document.body.append(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Unmodified",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });
    await flushAnimationFrame();

    const messages = [
      { role: "user" as const, content: "older", id: "u0", timestamp: "t0" },
      { role: "user" as const, content: "newer", id: "u1", timestamp: "t1" },
    ];

    useChatStore.setState((state) => ({
      threadStates: {
        ...state.threadStates,
        [threadId]: {
          messages: [],
          isLoading: false,
          activeRunId: null,
          runs: {},
          pendingAssistantId: null,
          pendingReasoningId: null,
          oldestSequence: null,
          hasMoreHistory: false,
          loadingMore: false,
        },
      },
    }));
    await seedRenderableMessages("flowix", threadId, messages);
    await flushAnimationFrame();

    const input = host.querySelector<HTMLTextAreaElement>(
      ".agent-thread-card__composer textarea",
    )!;

    dispatchKey(input, "ArrowUp");
    expect(input.value).toBe("newer");

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.setSelectionRange(0, 0);
    dispatchKey(input, "ArrowUp");

    expect(input.value).toBe("older");
  });
});

/**
 * 输入卡顿修复 ── 三处优化:
 *   A. update(node) 区分"消息影响类 attrs" 与"UI-only attrs", 后者跳过
 *      body 全量重建。
 *   B. persistInputDraft 走 1s debounce, 避免每个按键触发 ProseMirror 事务。
 *   C. updateAttrs 去掉手动 renderThreadState ── 之前与 ProseMirror 自己的
 *      update(node) 回调双调, 长对话下叠加 N 条消息重建, 肉眼可见输入卡顿。
 */
describe("AgentThreadCard input latency optimizations", () => {
  let editor: Editor | null = null;

  beforeEach(async () => {
    document.body.innerHTML = "";
    localStorage.clear();

    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(performance.now()), 0);
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) =>
      window.clearTimeout(id),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    // requestIdleCallback stub ── 立刻同步调用, 避免默认 setTimeout(300)
    // 在 1s debounce 触发前异步重建 body, 污染"lite 路径不重建"断言。
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 50 });
      return 1;
    });
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    const { useChatStore } = await import("@features/agent/store/chat-store");
    useChatStore.setState(useChatStore.getInitialState(), true);
    agentAccessState.config = { entries: [] };
  });

  afterEach(() => {
    editor?.destroy();
    editor = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function typeText(input: HTMLTextAreaElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("keeps the existing message DOM when only the inputDraft attr changes", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
    );
    const threadId = "thread-card-lite-render";
    const host = document.createElement("div");
    document.body.append(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Lite",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });
    await flushAnimationFrame();

    const messages = [
      {
        role: "user" as const,
        content: "old question",
        id: "u0",
        timestamp: new Date().toISOString(),
      },
      {
        role: "assistant" as const,
        content: "old answer",
        id: "a0",
        timestamp: new Date().toISOString(),
      },
      {
        role: "user" as const,
        content: "follow up",
        id: "u1",
        timestamp: new Date().toISOString(),
      },
    ];
    useAgentConversationStore
      .getState()
      .syncRenderableMessages("flowix", threadId, messages);
    useChatStore.setState((state) => ({
      threadStates: {
        ...state.threadStates,
        [threadId]: {
          messages,
          isLoading: false,
          activeRunId: null,
          runs: {},
          pendingAssistantId: null,
          pendingReasoningId: null,
          oldestSequence: null,
          hasMoreHistory: false,
          loadingMore: false,
        },
      },
    }));
    await flushAnimationFrame();

    // 首次渲染, 拿到消息 DOM 节点 ── 后续要确认它们没被销毁。
    const body = host.querySelector<HTMLElement>(".agent-thread-card__body")!;
    const initialMessageNodes = Array.from(
      body.querySelectorAll<HTMLElement>(".agent-thread-card__message"),
    );
    expect(initialMessageNodes).toHaveLength(3);
    // 标记每个节点, 后续比对是否还是同一批 DOM 节点 (lite 路径不重建)。
    initialMessageNodes.forEach((node, i) => {
      node.dataset.testid = `msg-${i}`;
    });
    const initialNodeIds = initialMessageNodes.map((node) => node.dataset.testid);

    const input = host.querySelector<HTMLTextAreaElement>(
      ".agent-thread-card__composer textarea",
    )!;

    // 用户开始打字 ── debounce 期间 (1s 内) inputDraft attr 不变, ProseMirror
    // 不会派发任何事务, update(node) 不会被调用 ── 这是 B 的效果。
    typeText(input, "typing…");
    expect(editor.getJSON().content?.[0]?.attrs?.inputDraft ?? null).toBeNull();

    // 等真实 1s 让 debounce 触发 (testTimeout 默认 5s, 1.1s 安全)。
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1100);
    });
    expect(editor.getJSON().content?.[0]?.attrs?.inputDraft).toBe("typing…");

    // A 的 lite 路径生效: inputDraft 是唯一变化的 attr, body 不重建。
    const afterNodeIds = Array.from(
      body.querySelectorAll<HTMLElement>(".agent-thread-card__message"),
    ).map((node) => node.dataset.testid);
    expect(afterNodeIds).toEqual(initialNodeIds);
  });
});

/**
 * 输入框运行期行为 ── 输入框不在 isLoading 时 disabled, 用户可以继续
 * 打字 / 改稿, 草稿保留至运行结束再投递。 此前的禁用策略让用户没有
 * 准备下一条消息的窗口, 现在的策略把"能否发送"这一拦截下放到 submit()
 * 里的 isBusy 早返。
 */
describe("AgentThreadCard composer during agent run", () => {
  let editor: Editor | null = null;

  beforeEach(async () => {
    document.body.innerHTML = "";
    localStorage.clear();

    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(performance.now()), 0);
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) =>
      window.clearTimeout(id),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );

    const { useChatStore } = await import("@features/agent/store/chat-store");
    useChatStore.setState(useChatStore.getInitialState(), true);
    agentAccessState.config = { entries: [] };
  });

  afterEach(() => {
    editor?.destroy();
    editor = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps the composer enabled while a run is in flight and preserves the draft", async () => {
    const { AgentThreadCard } =
      await import("@features/editor/extensions/agent-thread-card");
    const { useChatStore } = await import("@features/agent/store/chat-store");
    const threadId = "thread-card-busy-composer";
    const host = document.createElement("div");
    document.body.append(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              threadId,
              title: "Busy",
              typeKey: "flowix",
              collapsed: false,
            },
          },
        ],
      },
    });
    await flushAnimationFrame();

    // 模拟 agent 在跑 ── isLoading=true, activeRunId 已设置。
    useChatStore.setState((state) => ({
      threadStates: {
        ...state.threadStates,
        [threadId]: {
          messages: [],
          isLoading: true,
          activeRunId: "run-1",
          runs: {},
          pendingAssistantId: null,
          pendingReasoningId: null,
          oldestSequence: null,
          hasMoreHistory: false,
          loadingMore: false,
        },
      },
    }));
    await flushAnimationFrame();

    const input = host.querySelector<HTMLTextAreaElement>(
      ".agent-thread-card__composer textarea",
    )!;
    // 输入框不被 disabled ── 用户运行期可继续打字。
    expect(input.disabled).toBe(false);

    // 用户在运行期继续打字 ── 草稿留在 input 里。
    input.value = "next draft message";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.value).toBe("next draft message");

    // Enter / send 按钮在运行期都被拦截 ── submit() 早返, 不触发
    // sendMessageToThread, 也不清空 input (草稿保留)。
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    await flushPromises();
    expect(input.value).toBe("next draft message");
  });
});
