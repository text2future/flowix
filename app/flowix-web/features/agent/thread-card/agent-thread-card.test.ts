import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types/agent";
import { createAgentClientMock } from "@features/agent/store/agent-client.test-support";
import type { AgentConversationInstanceUpsert } from "@platform/tauri/client";

const memoStateMock = vi.hoisted(() => ({
  memos: [] as Array<unknown>,
  selectedMemo: null,
  selectedNotebook: null as null | {
    id: string;
    path: string;
    name?: string;
  },
  notebooks: [] as Array<unknown>,
  loadNotebooks: vi.fn(async () => undefined),
}));

const agentAccessState = vi.hoisted(() => ({
  config: { entries: [] as Array<Record<string, unknown>> } as {
    entries: Array<Record<string, unknown>>;
    defaults?: {
      files?: Record<
        string,
        { workspace?: string; folders: string[]; notebooks: string[] }
      >;
    };
  },
}));

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({ toast: toastMock }));

vi.mock("@features/workspace/use-cases/browser-column-navigation", () => ({
  openBrowserColumnFileBrowser: vi.fn(() => ({
    host: 'browser-column',
    tabId: 'file-browser:/Users/rop/Desktop/vibe/flowix-main',
    alreadyOpen: false,
  })),
  openBrowserColumnText: vi.fn(() => "file:/Users/rop/Documents/Outside Text.txt"),
  openBrowserColumnWebpage: vi.fn(() => ({
    host: 'browser-column',
    tabId: 'web:https://example.com/docs',
    alreadyOpen: false,
  })),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(async () => undefined),
  openUrl: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("@platform/tauri/client", () => ({
  agent: {
    ...createAgentClientMock(),
    cacheImage: vi.fn(async () => ({
      path: "/tmp/cached-agent-image.png",
      mimeType: "image/png",
      name: "cached-agent-image.png",
    })),
    deleteCachedImage: vi.fn(async () => true),
    readCachedImage: vi.fn(async () => null),
    getDeepSeekHarnessSessionId: vi.fn(async () => null),
    getCodexSessionId: vi.fn(async () => null),
    getClaudeSessionId: vi.fn(async () => null),
    getCodexDefaultModel: vi.fn(async () => "gpt-5.5"),
  },
  memos: {
    listAgentRoleMemos: vi.fn(async () => []),
  },
  deepseekHarness: {
    get: vi.fn(async () => ({
      model: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiUrl: "",
        apiKeys: {},
      },
    })),
    list: vi.fn(async () => [{
      model: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiUrl: "",
        apiKeys: {},
      },
    }]),
    sessionUsage: vi.fn(async () => null),
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

vi.mock("@features/memo/store/memo-store", () => ({
  useMemoStore: {
    getState: () => memoStateMock,
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

vi.mock("@features/memo/use-cases/open-by-target", () => ({
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
    subscribe: () => () => undefined,
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

type ComposerInput = HTMLDivElement & { editor?: Editor };

function getComposerInput(root: ParentNode): ComposerInput {
  const input = root.querySelector<HTMLDivElement>(
    ".agent-thread-card__composer-input",
  ) as ComposerInput | null;
  if (!input) throw new Error("Composer input not found");
  return input;
}

function getComposerEditor(input: ComposerInput): Editor {
  if (!input.editor) throw new Error("Composer editor not mounted");
  return input.editor;
}

function getComposerValue(input: ComposerInput): string {
  return getComposerEditor(input).getMarkdown().replace(/ {2}\n/g, "\n");
}

function setComposerText(input: ComposerInput, value: string): void {
  const editor = getComposerEditor(input);
  editor.commands.setContent(value, { contentType: "markdown" });
  editor.commands.focus("end", { scrollIntoView: false });
}

function setComposerCaret(input: ComposerInput, textOffset: number): void {
  const editor = getComposerEditor(input);
  const { doc } = editor.state;
  let position = 1;
  for (let candidate = 1; candidate <= doc.content.size; candidate += 1) {
    if (doc.textBetween(0, candidate, "\n", "\n").length >= textOffset) {
      position = candidate;
      break;
    }
    position = candidate;
  }
  editor.commands.setTextSelection(position);
}

// ThreadMessageRenderController 在流式态把 render 合并到 trailing rAF (D),
// 叠加 streaming-buffer 自身的 rAF flush ── 一次 flushAnimationFrame 不够让
// 最新内容落地。flush 两帧覆盖 buffer flush + 合并渲染, 保证断言前 DOM 已
// 反映最新 input。
async function flushStreamingRender(): Promise<void> {
  await flushAnimationFrame();
  await flushAnimationFrame();
}

async function waitForEnabledSendButton(
  root: ParentNode,
): Promise<HTMLButtonElement> {
  let button: HTMLButtonElement | null = null;
  await vi.waitFor(() => {
    button = root.querySelector<HTMLButtonElement>(
      "button.agent-thread-card__send",
    );
    expect(button).not.toBeNull();
    expect(button!.disabled).toBe(false);
  });
  return button!;
}

async function seedRenderableMessages(
  _typeKey: "deepseek-harness" | "codex" | "claude" | "gemini" | "hermes" | "openclaw",
  threadId: string,
  messages: ChatMessage[],
): Promise<void> {
  // Phase 4 (2026-08-02): 真源切到 session-store.threadProjections[tid].messages.
  const { useAgentSessionStore } = await import(
    "@features/agent/store/agent-session-store"
  );
  useAgentSessionStore.getState().setThreadProjection(threadId, (p) => ({
    ...p,
    messages,
  }));
}

describe("AgentThreadCard NodeView streaming", () => {
  let editor: Editor | null = null;

  it("persists the card title and fullscreen state in markdown for reload", async () => {
    const {
      parseAgentThreadCardMarkdown,
      renderAgentThreadCardMarkdown,
    } = await import(
      "@features/agent/thread-card/agent-thread-card-markdown"
    );

    const markdown = renderAgentThreadCardMarkdown({
      attrs: {
        instanceId: "instance-title-reload",
        threadId: "thread-title-reload",
        title: "Investigate refresh regression",
        typeKey: "codex",
        collapsed: false,
        fullscreen: true,
        inputImages: [{
          path: "/tmp/pasted.png",
          mimeType: "image/png",
          name: "pasted.png",
        }],
      },
    });

    expect(markdown).toContain('title="Investigate refresh regression"');
    expect(markdown).toContain('fullscreen="true"');
    const parsed = parseAgentThreadCardMarkdown({ attrs: markdown }).attrs;
    expect(parsed.title).toBe("Investigate refresh regression");
    expect(parsed.fullscreen).toBe(true);
    expect(parsed.inputImages).toEqual([{
      path: "/tmp/pasted.png",
      mimeType: "image/png",
      name: "pasted.png",
    }]);
  });

  it("does not create a conversation instance during a Tiptap can() dry run", async () => {
    const { AgentThreadCard } = await import("@features/agent/thread-card");
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    const host = document.createElement("div");
    document.body.append(host);
    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: "<p></p>",
    });

    expect(editor.can().insertAgentThreadCard()).toBe(true);
    expect(
      Object.keys(useAgentSessionStore.getState().conversationRegistry.instances),
    ).toHaveLength(0);
  }, 30_000);

  it("cleans up a programmatically deleted card and restores its binding on undo", async () => {
    const { AgentThreadCard } = await import("@features/agent/thread-card");
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    const { agent } = await import("@platform/tauri/client");
    const host = document.createElement("div");
    document.body.append(host);
    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: "<p></p>",
    });
    expect(editor.commands.insertAgentThreadCard()).toBe(true);
    const [instanceId] = Object.keys(
      useAgentSessionStore.getState().conversationRegistry.instances,
    );
    expect(instanceId).toBeTruthy();
    editor.view.dispatch(closeHistory(editor.state.tr));

    let cardPos = -1;
    let cardSize = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "agentThreadCard") {
        cardPos = pos;
        cardSize = node.nodeSize;
      }
    });
    expect(cardPos).toBeGreaterThanOrEqual(0);
    editor.view.dispatch(editor.state.tr.delete(cardPos, cardPos + cardSize));
    await flushPromises();
    expect(useAgentSessionStore.getState().getInstance(instanceId)).toBeNull();
    expect(agent.deleteConversationInstance).toHaveBeenCalledWith(instanceId);

    expect(editor.commands.undo()).toBe(true);
    await flushPromises();
    expect(useAgentSessionStore.getState().getInstance(instanceId)).not.toBeNull();
  }, 10_000);

  beforeEach(async () => {
    document.body.innerHTML = "";
    localStorage.clear();
    vi.clearAllMocks();

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

    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    useChatStore.setState(useChatStore.getInitialState(), true);
    useAgentConversationStore.setState(
      useAgentConversationStore.getInitialState(),
      true,
    );
    useAgentSessionStore.setState(useAgentSessionStore.getInitialState(), true);
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
      await import("@features/agent/thread-card");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
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
              typeKey: "deepseek-harness",
              collapsed: false,
            },
          },
        ],
      },
    });

    const card = host.querySelector<HTMLElement>(".agent-thread-card");
    expect(card).not.toBeNull();

    const store = useChatStore.getState();
    store.bindThreadType(threadId, "deepseek-harness");
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

    await flushStreamingRender();

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
  }, 30_000);

  it("opens an encoded absolute assistant link with the system default app", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { openPath, openUrl } = await import("@tauri-apps/plugin-opener");
    vi.mocked(openPath).mockClear();
    vi.mocked(openUrl).mockClear();

    const threadId = "thread-card-local-file-link";
    const host = document.createElement("div");
    document.body.append(host);
    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [{
          type: "agentThreadCard",
          attrs: {
            threadId,
            title: "Local file link",
            typeKey: "codex",
            collapsed: false,
          },
        }],
      },
    });

    const store = useChatStore.getState();
    store.bindThreadType(threadId, "codex");
    store.dispatchAgentChunk({
      kind: "stream_start",
      thread_id: threadId,
      agent_type: "codex",
    });
    store.dispatchAgentChunk({
      kind: "text",
      thread_id: threadId,
      agent_type: "codex",
      text: '<a href="/Users/rop/Desktop/%E4%BA%BA%E7%89%A9%E6%A1%A3%E6%A1%88/tool-smoke-test/outputs/tool-smoke-report.docx">测试报告 DOCX</a>',
    });
    await flushStreamingRender();

    const link = host.querySelector<HTMLAnchorElement>(
      '.agent-thread-card__message--assistant a[href]',
    );
    expect(link).not.toBeNull();
    link?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flushPromises();

    expect(openPath).toHaveBeenCalledWith(
      "/Users/rop/Desktop/人物档案/tool-smoke-test/outputs/tool-smoke-report.docx",
    );
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("routes an assistant Markdown link through the browser column", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { openPath } = await import("@tauri-apps/plugin-opener");
    const { openBrowserColumnText } = await import(
      "@features/workspace/use-cases/browser-column-navigation",
    );
    vi.mocked(openPath).mockClear();
    vi.mocked(openBrowserColumnText).mockClear();

    const threadId = "thread-card-markdown-link";
    const host = document.createElement("div");
    document.body.append(host);
    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [{
          type: "agentThreadCard",
          attrs: {
            threadId,
            title: "Markdown link",
            typeKey: "codex",
            collapsed: false,
          },
        }],
      },
    });

    const store = useChatStore.getState();
    store.bindThreadType(threadId, "codex");
    store.dispatchAgentChunk({
      kind: "stream_start",
      thread_id: threadId,
      agent_type: "codex",
    });
    store.dispatchAgentChunk({
      kind: "text",
      thread_id: threadId,
      agent_type: "codex",
      text: '<a href="/Users/rop/Documents/Outside%20Note.md">Markdown</a>',
    });
    await flushStreamingRender();

    host.querySelector<HTMLAnchorElement>(
      '.agent-thread-card__message--assistant a[href]',
    )?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();

    expect(openBrowserColumnText).toHaveBeenCalledWith(
      "/Users/rop/Documents/Outside Note.md",
      "/Users/rop/Documents",
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it("opens a file inside the conversation workspace in the file browser", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useChatStore, useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade",
    );
    const { openBrowserColumnFileBrowser, openBrowserColumnText } = await import(
      "@features/workspace/use-cases/browser-column-navigation",
    );
    const threadId = "thread-card-workspace-file-link";
    const instance = useAgentConversationStore.getState().createInstance({
      agentType: "codex",
      title: "Workspace file link",
      threadId,
      runtimeConfig: {
        workspaceSnapshot: {
          version: 1,
          cwd: "/Users/rop/Desktop/vibe/flowix-main",
          workspacePaths: ["/Users/rop/Desktop/vibe/flowix-main"],
          capturedAt: 1,
        },
      },
      source: { kind: "thread-card" },
    });
    vi.mocked(openBrowserColumnFileBrowser).mockClear();
    vi.mocked(openBrowserColumnText).mockClear();

    const host = document.createElement("div");
    document.body.append(host);
    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [{
          type: "agentThreadCard",
          attrs: {
            threadId,
            instanceId: instance.instanceId,
            title: "Workspace file link",
            typeKey: "codex",
            collapsed: false,
          },
        }],
      },
    });

    const store = useChatStore.getState();
    store.bindThreadType(threadId, "codex");
    store.dispatchAgentChunk({
      kind: "stream_start",
      thread_id: threadId,
      agent_type: "codex",
    });
    store.dispatchAgentChunk({
      kind: "text",
      thread_id: threadId,
      agent_type: "codex",
      text: '<a href="/Users/rop/Desktop/vibe/flowix-main/src/main.ts:42">源文件</a>',
    });
    await flushStreamingRender();

    host.querySelector<HTMLAnchorElement>(
      '.agent-thread-card__message--assistant a[href]',
    )?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();

    expect(openBrowserColumnFileBrowser).toHaveBeenCalledWith(
      "/Users/rop/Desktop/vibe/flowix-main",
      "/Users/rop/Desktop/vibe/flowix-main/src/main.ts",
    );
    expect(openBrowserColumnText).not.toHaveBeenCalled();
  });

  it("uses thread runtime as the Thread Card footer running source", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const threadId = "thread-card-conversation-run-source";
    const instance = useAgentConversationStore.getState().createInstance({
      agentType: "deepseek-harness",
      title: "Conversation Run Source",
      threadId,
      source: { kind: "thread-card" },
    });
    useChatStore.getState().dispatchAgentChunk({
      kind: "stream_start",
      thread_id: threadId,
      run_id: "run-conversation-source",
      agent_type: "deepseek-harness",
    });

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
              instanceId: instance.instanceId,
              threadId,
              title: "Conversation Run Source",
              typeKey: "deepseek-harness",
              collapsed: false,
            },
          },
        ],
      },
    });

    const card = host.querySelector<HTMLElement>(".agent-thread-card");
    expect(
      card?.querySelector(".agent-thread-card__run-status--running"),
    ).not.toBeNull();
    expect(card?.classList.contains("agent-thread-card--running")).toBe(true);
  });

  it("patches the last rendered message without rebuilding previous message DOM", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
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
      threadTypes: { ...state.threadTypes, [threadId]: "deepseek-harness" },
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
    await seedRenderableMessages("deepseek-harness", threadId, [
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
              typeKey: "deepseek-harness",
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
    await seedRenderableMessages("deepseek-harness", threadId, patchedMessages);

    await flushAnimationFrame();

    const messagesAfter = host.querySelectorAll(".agent-thread-card__message");
    expect(messagesAfter[0]).toBe(firstMessageNode);
    expect(messagesAfter[1]?.textContent).toContain("Hello incremental patch");
  });

  it("renders oversized assistant messages in full without folding", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const { ASSISTANT_MESSAGE_DISPLAY_MAX_CHARS } = await import(
      "@features/agent/message/display-limits"
    );
    const threadId = "thread-card-assistant-display-budget";
    const host = document.createElement("div");
    document.body.append(host);
    const tail = "FULL_MESSAGE_TAIL";
    const content = `${"A".repeat(ASSISTANT_MESSAGE_DISPLAY_MAX_CHARS + 20)}${tail}`;

    useChatStore.setState((state) => ({
      threadTypes: { ...state.threadTypes, [threadId]: "deepseek-harness" },
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
    await seedRenderableMessages("deepseek-harness", threadId, [
      {
        id: "assistant-large",
        role: "assistant",
        content,
        timestamp: new Date().toISOString(),
      },
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
              title: "Display Budget",
              typeKey: "deepseek-harness",
              collapsed: false,
            },
          },
        ],
      },
    });
    await flushAnimationFrame();

    const message = host.querySelector<HTMLElement>(
      ".agent-thread-card__message--assistant",
    )!;
    // assistant 放行: 超长内容完整渲染 (含 tail), 不截断、不显示展开按钮。
    expect(message.textContent).toContain(tail);
    expect(
      message.querySelector(".agent-thread-card__message-display-toggle"),
    ).toBeNull();
  });

  it("does not select the Thread Card when clicking messages while editing the title", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
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
              typeKey: "deepseek-harness",
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
    store.bindThreadType(threadId, "deepseek-harness");
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
    // Markdown title is legacy recovery metadata; threads.title is authoritative.
    expect(editor.getJSON().content?.[0]?.attrs?.title).toBe("Editable title");
  });

  it("keeps the instance title when an existing conversation is rebound", async () => {
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-session-test-facade"
    );
    const { upsertAgentThreadCardConversationInstance } = await import(
      "@features/agent/thread-card/runtime/thread-card-conversation"
    );
    const instance = useAgentConversationStore.getState().createInstance({
      agentType: "deepseek-harness",
      title: "User renamed title",
      threadId: "thread-existing-title",
      source: { kind: "thread-card" },
      role: { memoId: "role-old", name: "Old role" },
    });

    const result = await upsertAgentThreadCardConversationInstance({
      instanceId: instance.instanceId,
      agentType: "deepseek-harness",
      title: "Prompt generated title",
      threadId: "thread-existing-title",
      source: { kind: "thread-card" },
      role: { memoId: "role-new", name: "New role" },
    });

    const updated = useAgentConversationStore
      .getState()
      .getInstance(result.instanceId);
    expect(updated?.title).toBe("User renamed title");
    expect(updated?.role).toEqual({ memoId: "role-new", name: "New role" });
  });

  it("renders each card's persisted title instead of the active Codex title", async () => {
    const { AgentThreadCard } = await import("@features/agent/thread-card");
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    const first = useAgentSessionStore.getState().createInstance({
      agentType: "codex",
      title: "First persisted title",
      threadId: "codex-product-first",
      source: { kind: "thread-card" },
    });
    const second = useAgentSessionStore.getState().createInstance({
      agentType: "codex",
      title: "Second persisted title",
      threadId: "codex-product-second",
      source: { kind: "thread-card" },
    });
    useAgentSessionStore.getState().setSessionMeta((meta) => ({
      ...meta,
      activeThreadIds: {
        ...meta.activeThreadIds,
        codex: first.threadId ?? undefined,
      },
      currentThreadTitles: {
        ...meta.currentThreadTitles,
        "legacy-codex-key": "Unrelated active title",
      },
    }));
    const host = document.createElement("div");
    document.body.append(host);
    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [first, second].map((instance) => ({
          type: "agentThreadCard",
          attrs: {
            instanceId: instance.instanceId,
            threadId: instance.threadId,
            title: "Stale Markdown title",
            typeKey: "codex",
            collapsed: false,
          },
        })),
      },
    });

    expect(
      [...host.querySelectorAll(".agent-thread-card__title")].map(
        (element) => element.textContent,
      ),
    ).toEqual(["First persisted title", "Second persisted title"]);
  });

  it("submits from the Thread Card and renders the response stream on the same card", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
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
              typeKey: "deepseek-harness",
              collapsed: false,
            },
          },
        ],
      },
    });

    const card = host.querySelector<HTMLElement>(".agent-thread-card");
    const input = card ? getComposerInput(card) : null;
    expect(card).not.toBeNull();
    expect(input).not.toBeNull();

    setComposerText(input!, "write a short answer");
    const sendButton = await waitForEnabledSendButton(card!);
    sendButton.click();
    await vi.waitFor(() => expect(agent.chatStream).toHaveBeenCalled());

    expect(agent.chatStream).toHaveBeenCalledWith(
      threadId,
      expect.objectContaining({
        content: "write a short answer",
        agentType: "deepseek-harness",
        runtimeConfig: expect.objectContaining({
          deepseekHarness: expect.any(Object),
        }),
      }),
    );
    await flushStreamingRender();
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
    await flushStreamingRender();

    expect(
      card?.querySelector(".agent-thread-card__message--assistant")
        ?.textContent,
    ).toContain("Streamed answer");
  });

  it("does not start chat until first-send title initialization is persisted", async () => {
    const { AgentThreadCard } = await import("@features/agent/thread-card");
    const { agent } = await import("@platform/tauri/client");
    let releaseInitialization!: () => void;
    const initializationPending = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    vi.mocked(agent.upsertConversationInstance).mockImplementationOnce(
      async (instance: AgentConversationInstanceUpsert) => {
        await initializationPending;
        return { ...instance, threadTitle: instance.initialTitle };
      },
    );
    const host = document.createElement("div");
    document.body.append(host);
    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [{
          type: "agentThreadCard",
          attrs: {
            threadId: "thread-awaited-initialization",
            title: "Awaited initialization",
            typeKey: "deepseek-harness",
            collapsed: false,
          },
        }],
      },
    });

    const card = host.querySelector<HTMLElement>(".agent-thread-card")!;
    const input = getComposerInput(card);
    setComposerText(input, "first message waits");
    (await waitForEnabledSendButton(card)).click();
    await flushPromises();
    expect(agent.chatStream).not.toHaveBeenCalled();

    releaseInitialization();
    await vi.waitFor(() => expect(agent.chatStream).toHaveBeenCalledTimes(1));
  });

  it("does not start chat when first-send title initialization fails", async () => {
    const { AgentThreadCard } = await import("@features/agent/thread-card");
    const { agent } = await import("@platform/tauri/client");
    vi.mocked(agent.upsertConversationInstance).mockRejectedValueOnce(
      new Error("thread initialization failed"),
    );
    const host = document.createElement("div");
    document.body.append(host);
    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [{
          type: "agentThreadCard",
          attrs: {
            threadId: null,
            title: "Failed initialization",
            typeKey: "deepseek-harness",
            collapsed: false,
          },
        }],
      },
    });

    const card = host.querySelector<HTMLElement>(".agent-thread-card")!;
    const input = getComposerInput(card);
    setComposerText(input, "must not be sent");
    (await waitForEnabledSendButton(card)).click();
    await vi.waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("thread initialization failed");
    });
    expect(agent.chatStream).not.toHaveBeenCalled();
  });

  it("persists short Thread Card composer drafts in node attrs", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const host = document.createElement("div");
    document.body.append(host);

    // inputDraft 落盘走 2s debounce ── 用 fake timer 推进时间。
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
              typeKey: "deepseek-harness",
              collapsed: false,
            },
          },
        ],
      },
    });

    const input = getComposerInput(host);
    expect(input).not.toBeNull();

    setComposerText(input, "unfinished message");

    // 立刻读还没落盘 ── debounce 期间 ProseMirror attr 保持旧值。
    expect(editor.getJSON().content?.[0]?.attrs?.inputDraft ?? null).toBeNull();

    vi.advanceTimersByTime(2100);

    expect(editor.getJSON().content?.[0]?.attrs?.inputDraft).toBe(
      "unfinished message",
    );

    vi.useRealTimers();
  });

  it("does not persist Thread Card composer drafts longer than 500 characters", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
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
              typeKey: "deepseek-harness",
              collapsed: false,
              inputDraft: "short",
            },
          },
        ],
      },
    });

    const input = getComposerInput(host);
    expect(input).not.toBeNull();

    setComposerText(input, "x".repeat(501));

    // debounce 期间 attr 仍是 "short", 推进 2s 后才被空字符串覆盖。
    expect(editor.getJSON().content?.[0]?.attrs?.inputDraft).toBe("short");
    vi.advanceTimersByTime(2100);
    expect(editor.getJSON().content?.[0]?.attrs?.inputDraft).toBeNull();
    expect(getComposerValue(input!)).toHaveLength(501);

    vi.useRealTimers();
  });

  it("clears persisted Thread Card composer draft after send", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
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
              typeKey: "deepseek-harness",
              collapsed: false,
              inputDraft: "send me",
            },
          },
        ],
      },
    });

    const input = getComposerInput(host);
    expect(getComposerValue(input)).toBe("send me");
    const sendButton = await waitForEnabledSendButton(host);

    sendButton.click();
    // submit() 内部会 flushPendingDraft ── 立刻清空 attr, 不等 debounce。
    vi.advanceTimersByTime(0);

    expect(editor.getJSON().content?.[0]?.attrs?.inputDraft).toBeNull();
    expect(getComposerValue(input)).toBe("");

    vi.useRealTimers();
  });

  it("submits Codex Thread Card messages with workspace derived from notebook folder defaults", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { agent } = await import("@platform/tauri/client");
    const threadId = "thread-card-submit-codex-workspace";
    memoStateMock.selectedNotebook = {
      id: "nb-current",
      path: "D:\\workspace\\main",
    };
    agentAccessState.config = {
      // defaults.folders 里的每个 folder 必须在 entries 里有对应的
      // enabled && !missing 授权条目, 否则 resolveAuthorizedDefaultFiles
      // 会把它收窄掉 (防越权)。
      entries: [
        { id: "e-main", kind: "folder", path: "D:\\workspace\\main", name: "main", enabled: true, missing: false },
        { id: "e-extra", kind: "folder", path: "D:\\workspace\\extra", name: "extra", enabled: true, missing: false },
      ],
      defaults: {
        files: {
          "nb-current": {
            workspace: "D:\\workspace\\main",
            folders: ["D:\\workspace\\main", "D:\\workspace\\extra"],
            notebooks: [],
          },
        },
      },
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
    const input = card ? getComposerInput(card) : null;
    expect(card).not.toBeNull();
    expect(input).not.toBeNull();

    setComposerText(input!, "check workspace");
    const sendButton = await waitForEnabledSendButton(card!);
    sendButton.click();
    await vi.waitFor(() => expect(agent.chatStream).toHaveBeenCalled());

    expect(agent.chatStream).toHaveBeenCalledWith(
      threadId,
      expect.objectContaining({
        content: "check workspace",
        agentType: "codex",
        runtimeConfig: {
          codex: expect.objectContaining({
            cwd: "D:\\workspace\\main",
            workspacePaths: ["D:\\workspace\\extra"],
          }),
        },
      }),
    );
  });

  it("renders Codex command tool calls with JSON-string arguments in Thread Card DOM", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
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

  it("renders the concrete MCP tool name in the primary color without a dot separator", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    const threadId = "thread-card-mcp-tool-name";
    const host = document.createElement("div");
    document.body.append(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [{
          type: "agentThreadCard",
          attrs: {
            threadId,
            title: "MCP tool",
            typeKey: "codex",
            collapsed: false,
          },
        }],
      },
    });

    const store = useChatStore.getState();
    store.bindThreadType(threadId, "codex");
    store.dispatchAgentChunk({
      kind: "tool_call",
      thread_id: threadId,
      id: "mcp-display",
      name: "mcp_tool_call",
      input: {
        server: "mcp_servers-flowix",
        tool: "memo",
        arguments: { command: "notebooks" },
      },
       agent_type: "codex",
     });
     await flushStreamingRender();

     const tool = host.querySelector(".agent-thread-card__message--tool");
    expect(
      tool?.querySelector(".agent-thread-card__message-tool-name")?.textContent,
    ).toBe("MCP");
    expect(
      tool?.querySelector(".agent-thread-card__message-tool-concrete-name")
        ?.textContent,
    ).toBe("memo");
    expect(
      tool?.querySelector(".agent-thread-card__message-tool-summary")
        ?.textContent,
    ).toBe("command: notebooks");
    expect(tool?.textContent).not.toContain("·");
  });

  it("canonicalizes a Codex local Thread Card id to the external session id before loading history", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
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
    expect(editor.getJSON().content?.[0]?.attrs?.threadId).toBe(localThreadId);
    expect(card?.dataset.threadId).toBe(localThreadId);
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
      await import("@features/agent/thread-card");
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
    const getDeepSeekHarnessThreadPageMock = agent.getDeepSeekHarnessThreadPage as unknown as {
      mockClear: () => void;
    };
    getThreadMock.mockClear();
    getDeepSeekHarnessThreadPageMock.mockClear();

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
              typeKey: "deepseek-harness",
              collapsed: true,
            },
          },
        ],
      },
    });

    await flushPromises();
    await flushAnimationFrame();

    expect(agent.getDeepSeekHarnessThreadPage).not.toHaveBeenCalled();

    host
      .querySelector<HTMLButtonElement>(".agent-thread-card__collapse")
      ?.click();

    await flushPromises();
    await flushAnimationFrame();

    expect(agent.getDeepSeekHarnessThreadPage).toHaveBeenCalledWith(threadId, null, 10);
  });

  it("rerenders cached messages when expanding a previously loaded collapsed Thread Card", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { agent } = await import("@platform/tauri/client");
    const threadId = "thread-card-expand-rerender-cache";
    const host = document.createElement("div");
    document.body.append(host);

    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 50 });
      return 1;
    });
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    const getDeepSeekHarnessThreadPageMock = agent.getDeepSeekHarnessThreadPage as unknown as {
      mockClear: () => void;
    };
    getDeepSeekHarnessThreadPageMock.mockClear();

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
              typeKey: "deepseek-harness",
              collapsed: false,
            },
          },
        ],
      },
    });

    await flushPromises();
    await flushAnimationFrame();

    await seedRenderableMessages("deepseek-harness", threadId, [
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

    getDeepSeekHarnessThreadPageMock.mockClear();

    host
      .querySelector<HTMLButtonElement>(".agent-thread-card__collapse")
      ?.click();

    await flushPromises();
    await flushAnimationFrame();

    expect(agent.getDeepSeekHarnessThreadPage).toHaveBeenCalledWith(
      threadId,
      null,
      10,
    );
    expect(card?.textContent).toContain("cached answer after finish");
  });

  it("shows a static skeleton while an expanded Thread Card loads history", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
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
              typeKey: "deepseek-harness",
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
      await import("@features/agent/thread-card");
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
    const getDeepSeekHarnessThreadPageMock = agent.getDeepSeekHarnessThreadPage as unknown as {
      mockClear: () => void;
      mockImplementationOnce: (
        implementation: () => Promise<{
          messages: [];
          oldestSequence: null;
          hasMore: false;
        }>,
      ) => void;
    };
    getDeepSeekHarnessThreadPageMock.mockClear();
    getDeepSeekHarnessThreadPageMock.mockImplementationOnce(
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
              typeKey: "deepseek-harness",
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
      await import("@features/agent/thread-card");
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
    const getDeepSeekHarnessThreadPageMock = agent.getDeepSeekHarnessThreadPage as unknown as {
      mockClear: () => void;
    };
    getThreadMock.mockClear();
    getDeepSeekHarnessThreadPageMock.mockClear();

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
              typeKey: "deepseek-harness",
              collapsed: false,
            },
          },
        ],
      },
    });

    await flushPromises();
    await flushAnimationFrame();

    expect(agent.getDeepSeekHarnessThreadPage).not.toHaveBeenCalled();

    triggerIntersection(true);
    await flushPromises();
    await flushAnimationFrame();

    expect(agent.getDeepSeekHarnessThreadPage).toHaveBeenCalledWith(threadId, null, 10);
  });

  it("loads Thread Card history when a collapsed card enters fullscreen", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
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
    const getDeepSeekHarnessThreadPageMock = agent.getDeepSeekHarnessThreadPage as unknown as {
      mockClear: () => void;
    };
    getThreadMock.mockClear();
    getDeepSeekHarnessThreadPageMock.mockClear();

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
              typeKey: "deepseek-harness",
              collapsed: true,
            },
          },
        ],
      },
    });

    await flushPromises();
    await flushAnimationFrame();

    expect(agent.getDeepSeekHarnessThreadPage).not.toHaveBeenCalled();

    host
      .querySelector<HTMLButtonElement>(".agent-thread-card__fullscreen")
      ?.click();

    await flushPromises();
    await flushAnimationFrame();

    expect(agent.getDeepSeekHarnessThreadPage).toHaveBeenCalledWith(threadId, null, 10);
  });

  it("persists fullscreen toggles in the Thread Card node attrs", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
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
              instanceId: "instance-fullscreen-persist",
              threadId: "thread-fullscreen-persist",
              title: "Fullscreen Persist",
              typeKey: "deepseek-harness",
              collapsed: false,
              fullscreen: false,
            },
          },
        ],
      },
    });

    const button = host.querySelector<HTMLButtonElement>(
      ".agent-thread-card__fullscreen",
    );
    button?.click();

    expect(editor.state.doc.firstChild?.attrs.fullscreen).toBe(true);

    button?.click();

    expect(editor.state.doc.firstChild?.attrs.fullscreen).toBe(false);
  });

  it("does not exit a Browser Column fullscreen card when main-third leaves agent view", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const workspaceHost = document.createElement("section");
    workspaceHost.dataset.workspaceHost = "browser-column";
    const host = document.createElement("div");
    workspaceHost.append(host);
    document.body.append(workspaceHost);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              instanceId: "instance-browser-column-fullscreen",
              threadId: "thread-browser-column-fullscreen",
              title: "Browser Column conversation",
              typeKey: "deepseek-harness",
              collapsed: false,
              fullscreen: false,
            },
          },
        ],
      },
    });

    host
      .querySelector<HTMLButtonElement>(".agent-thread-card__fullscreen")
      ?.click();

    const card = host.querySelector<HTMLElement>(".agent-thread-card");
    expect(card?.classList.contains("agent-thread-card--fullscreen")).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.fullscreen).toBe(true);

    window.dispatchEvent(
      new CustomEvent("flowix:agent-thread-card-request-fullscreen", {
        detail: { host: "main-third", exitOthers: true, persist: true },
      }),
    );

    expect(card?.classList.contains("agent-thread-card--fullscreen")).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.fullscreen).toBe(true);
  });

  it("persists a Work Column fullscreen exit and does not restore it on update", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const workspaceHost = document.createElement("section");
    workspaceHost.dataset.workspaceHost = "main-third";
    const host = document.createElement("div");
    workspaceHost.append(host);
    document.body.append(workspaceHost);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, AgentThreadCard],
      content: {
        type: "doc",
        content: [
          {
            type: "agentThreadCard",
            attrs: {
              instanceId: "instance-work-column-fullscreen",
              threadId: "thread-work-column-fullscreen",
              title: "Work Column conversation",
              typeKey: "deepseek-harness",
              collapsed: false,
              fullscreen: false,
            },
          },
        ],
      },
    });

    host
      .querySelector<HTMLButtonElement>(".agent-thread-card__fullscreen")
      ?.click();
    const card = host.querySelector<HTMLElement>(".agent-thread-card");
    expect(card?.classList.contains("agent-thread-card--fullscreen")).toBe(true);

    window.dispatchEvent(
      new CustomEvent("flowix:agent-thread-card-request-fullscreen", {
        detail: { host: "main-third", exitOthers: true, persist: true },
      }),
    );

    expect(card?.classList.contains("agent-thread-card--fullscreen")).toBe(false);
    expect(editor.state.doc.firstChild?.attrs.fullscreen).toBe(false);

    const currentNode = editor.state.doc.firstChild;
    expect(currentNode).not.toBeNull();
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(0, undefined, {
        ...currentNode?.attrs,
        title: "Work Column conversation updated",
      }),
    );
    await flushPromises();
    await flushAnimationFrame();

    expect(card?.classList.contains("agent-thread-card--fullscreen")).toBe(false);
    expect(editor.state.doc.firstChild?.attrs.fullscreen).toBe(false);
  });

  it("restores only the first fullscreen-marked Thread Card on document entry", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
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
              instanceId: "instance-fullscreen-first",
              threadId: "thread-fullscreen-first",
              title: "First Fullscreen",
              typeKey: "deepseek-harness",
              collapsed: false,
              fullscreen: true,
            },
          },
          {
            type: "agentThreadCard",
            attrs: {
              instanceId: "instance-fullscreen-second",
              threadId: "thread-fullscreen-second",
              title: "Second Fullscreen",
              typeKey: "deepseek-harness",
              collapsed: false,
              fullscreen: true,
            },
          },
        ],
      },
    });

    const pendingCards = host.querySelectorAll<HTMLElement>(
      ".agent-thread-card--restoring-fullscreen",
    );
    expect(pendingCards).toHaveLength(2);

    await flushPromises();
    await flushAnimationFrame();

    const cards = host.querySelectorAll<HTMLElement>(".agent-thread-card");
    expect(cards[0]?.classList.contains("agent-thread-card--fullscreen")).toBe(
      true,
    );
    expect(cards[1]?.classList.contains("agent-thread-card--fullscreen")).toBe(
      false,
    );
    expect(
      host.querySelector(".agent-thread-card--restoring-fullscreen"),
    ).toBeNull();
    expect(editor.state.doc.child(0).attrs.fullscreen).toBe(true);
    expect(editor.state.doc.child(1).attrs.fullscreen).toBe(true);

    cards[1]
      ?.querySelector<HTMLButtonElement>(".agent-thread-card__fullscreen")
      ?.click();

    expect(cards[0]?.classList.contains("agent-thread-card--fullscreen")).toBe(
      false,
    );
    expect(cards[1]?.classList.contains("agent-thread-card--fullscreen")).toBe(
      true,
    );
    expect(editor.state.doc.child(0).attrs.fullscreen).toBe(false);
    expect(editor.state.doc.child(1).attrs.fullscreen).toBe(true);
  });

  it("defaults cached messages to the bottom after restoring fullscreen", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const threadId = "thread-restored-fullscreen-bottom";
    await seedRenderableMessages("deepseek-harness", threadId, [
      {
        id: "cached-assistant-message",
        role: "assistant",
        content: "cached response",
        timestamp: new Date().toISOString(),
      },
    ]);

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
              instanceId: "instance-restored-fullscreen-bottom",
              threadId,
              title: "Restored Fullscreen Bottom",
              typeKey: "deepseek-harness",
              collapsed: false,
              fullscreen: true,
            },
          },
        ],
      },
    });

    const body = host.querySelector<HTMLElement>(".agent-thread-card__body");
    expect(body?.textContent).toContain("cached response");
    Object.defineProperty(body, "scrollHeight", {
      configurable: true,
      value: 720,
    });

    await flushPromises();
    await flushAnimationFrame();

    expect(body?.scrollTop).toBe(720);
  });

  it("keeps a legacy card hidden until its deduplicated fullscreen restore frame", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
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
              threadId: "thread-legacy-fullscreen-restore",
              title: "Legacy Fullscreen Restore",
              typeKey: "deepseek-harness",
              collapsed: false,
              fullscreen: true,
            },
          },
        ],
      },
    });

    await flushPromises();

    const card = host.querySelector<HTMLElement>(".agent-thread-card");
    expect(editor.state.doc.firstChild?.attrs.instanceId).toBeTruthy();
    expect(card?.classList.contains("agent-thread-card--fullscreen")).toBe(true);
    expect(
      card?.classList.contains("agent-thread-card--restoring-fullscreen"),
    ).toBe(true);

    await flushAnimationFrame();

    expect(
      card?.classList.contains("agent-thread-card--restoring-fullscreen"),
    ).toBe(false);
  });

  it("cancels a stale restore frame before a manual fullscreen cycle", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    let nextFrameId = 1;
    const frameCallbacks = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrameId;
      nextFrameId += 1;
      frameCallbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frameCallbacks.delete(id);
    });

    const threadId = "thread-stale-restore-frame";
    await seedRenderableMessages("deepseek-harness", threadId, [
      {
        id: "stale-frame-message",
        role: "assistant",
        content: "keep manual reading position",
        timestamp: new Date().toISOString(),
      },
    ]);
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
              instanceId: "instance-stale-restore-frame",
              threadId,
              title: "Stale Restore Frame",
              typeKey: "deepseek-harness",
              collapsed: false,
              fullscreen: true,
            },
          },
        ],
      },
    });

    await flushPromises();

    const body = host.querySelector<HTMLElement>(".agent-thread-card__body");
    const button = host.querySelector<HTMLButtonElement>(
      ".agent-thread-card__fullscreen",
    );
    Object.defineProperty(body, "scrollHeight", {
      configurable: true,
      value: 720,
    });
    if (body) body.scrollTop = 123;

    button?.click();
    button?.click();

    const pendingFrames = Array.from(frameCallbacks.entries());
    frameCallbacks.clear();
    pendingFrames.forEach(([, callback]) => callback(performance.now()));

    expect(body?.scrollTop).toBe(123);
    expect(
      host.querySelector(".agent-thread-card--restoring-fullscreen"),
    ).toBeNull();
  });

  it("restores fullscreen through the setContent document-switch path", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
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
              instanceId: "instance-before-document-switch",
              threadId: "thread-before-document-switch",
              title: "Before Document Switch",
              typeKey: "deepseek-harness",
              collapsed: false,
              fullscreen: false,
            },
          },
        ],
      },
    });
    await flushPromises();

    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "agentThreadCard",
          attrs: {
            instanceId: "instance-after-document-switch",
            threadId: "thread-after-document-switch",
            title: "After Document Switch",
            typeKey: "deepseek-harness",
            collapsed: false,
            fullscreen: true,
          },
        },
      ],
    });

    const card = host.querySelector<HTMLElement>(".agent-thread-card");
    expect(
      card?.classList.contains("agent-thread-card--restoring-fullscreen"),
    ).toBe(true);

    await flushPromises();
    await flushAnimationFrame();

    expect(card?.dataset.threadId).toBe("thread-after-document-switch");
    expect(card?.classList.contains("agent-thread-card--fullscreen")).toBe(true);
    expect(
      card?.classList.contains("agent-thread-card--restoring-fullscreen"),
    ).toBe(false);
  });

  it("does not move the editor selection after entering or exiting fullscreen", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
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
              typeKey: "deepseek-harness",
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

  it("focuses the composer input row after entering fullscreen", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
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
              threadId: "thread-card-fullscreen-input-focus",
              title: "Fullscreen Input Focus",
              typeKey: "deepseek-harness",
              collapsed: false,
            },
          },
        ],
      },
    });

    host
      .querySelector<HTMLButtonElement>(".agent-thread-card__fullscreen")
      ?.click();
    await flushAnimationFrame();

    const input = getComposerInput(host);
    const row = input.parentElement;
    expect(row?.classList.contains("agent-thread-card__composer-input-row")).toBe(true);

    input.blur();
    row?.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );

    expect(document.activeElement).toBe(input);
    expect(getComposerEditor(input).view.hasFocus()).toBe(true);
  });

  it("does not refocus the editor when clicking non-interactive card content", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
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
              typeKey: "deepseek-harness",
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
      await import("@features/agent/thread-card");
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
              typeKey: "deepseek-harness",
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

  it("clears the card node selection when its composer input receives focus", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
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
              threadId: "thread-card-focus-deselect",
              title: "Focus Deselect",
              typeKey: "deepseek-harness",
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

    let cardPos: number | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "agentThreadCard") {
        cardPos = pos;
        return false;
      }
      return true;
    });
    expect(cardPos).not.toBeNull();
    editor.commands.setNodeSelection(cardPos!);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);

    const card = host.querySelector<HTMLElement>(".agent-thread-card");
    const input = card ? getComposerInput(card) : null;
    expect(card).not.toBeNull();
    expect(input).not.toBeNull();
    expect(card!.classList.contains("ProseMirror-selectednode")).toBe(true);

    input!.focus();

    expect(document.activeElement).toBe(input);
    expect(editor.state.selection).not.toBeInstanceOf(NodeSelection);
    expect(card!.classList.contains("ProseMirror-selectednode")).toBe(false);
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(1).type.name).toBe("agentThreadCard");
  });

  it("blurs a focused card input before outside pointer interactions", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
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
              typeKey: "deepseek-harness",
              collapsed: false,
            },
          },
        ],
      },
    });

    const input = getComposerInput(host);
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
      await import("@features/agent/thread-card");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
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
    const input = card ? getComposerInput(card) : null;
    expect(card).not.toBeNull();
    expect(input).not.toBeNull();

    setComposerText(input!, "first codex request");
    const sendButton = await waitForEnabledSendButton(card!);
    sendButton.click();
    await vi.waitFor(() => expect(chatStreamMock).toHaveBeenCalled());

    const localThreadId = chatStreamMock.mock.calls[0]?.[0] as string;
    const runId = chatStreamMock.mock.calls[0]?.[1]?.runId;
    const instanceId = editor.getJSON().content?.[0]?.attrs?.instanceId as string;
    expect(instanceId).toMatch(/^agent-inst-/);
    expect(localThreadId).toBe(`codex-local-${instanceId}`);
    expect(editor.getJSON().content?.[0]?.attrs?.threadId).toBe(localThreadId);
    expect(card?.dataset.threadId).toBe(localThreadId);
    expect(card?.dataset.instanceId).toBe(instanceId);
    expect(card?.textContent).toContain("first codex request");

    const store = useChatStore.getState();
    store.dispatchAgentChunk({
      kind: "stream_start",
      thread_id: localThreadId,
      run_id: runId,
      agent_type: "codex",
    });
    store.dispatchAgentChunk({
      kind: "session_resolved",
      thread_id: localThreadId,
      session_id: sessionId,
      run_id: runId,
      agent_type: "codex",
    });
    store.dispatchAgentChunk({
      kind: "stream_end",
      thread_id: localThreadId,
      run_id: runId,
      reason: null,
      agent_type: "codex",
    });
    await flushPromises();
    await flushAnimationFrame();

    expect(editor.getJSON().content?.[0]?.attrs?.threadId).toBe(localThreadId);
    expect(card?.dataset.threadId).toBe(localThreadId);
    expect(card?.textContent).toContain("first codex request");
    expect(agent.getCodexSessionId).not.toHaveBeenCalled();
  });

  it("falls back instead of crashing when one Thread Card message cannot be rendered", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
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

    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
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

  function dispatchKey(input: ComposerInput, key: string): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    return event;
  }

  function typeText(input: ComposerInput, value: string): void {
    setComposerText(input, value);
  }

  it("does nothing when the thread has no user messages", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
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
              typeKey: "deepseek-harness",
              collapsed: false,
            },
          },
        ],
      },
    });
    await flushAnimationFrame();

    const input = getComposerInput(host);
    typeText(input, "draft");
    dispatchKey(input, "ArrowUp");

    expect(getComposerValue(input)).toBe("draft");
  });

  it("Up on empty input fills with the most recent user message", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
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
              typeKey: "deepseek-harness",
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
    await seedRenderableMessages("deepseek-harness", threadId, messages);
    await flushAnimationFrame();

    const input = getComposerInput(host);
    expect(getComposerValue(input)).toBe("");

    dispatchKey(input, "ArrowUp");
    expect(getComposerValue(input)).toBe("second question");

    dispatchKey(input, "ArrowUp");
    expect(getComposerValue(input)).toBe("first question");

    // 已经在最老一条, 再按 Up 应该 clamp 不动。
    dispatchKey(input, "ArrowUp");
    expect(getComposerValue(input)).toBe("first question");
  });

  it("saves the existing draft as preNavDraft and restores it on Down past newest", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
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
              typeKey: "deepseek-harness",
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
    await seedRenderableMessages("deepseek-harness", threadId, messages);
    await flushAnimationFrame();

    const input = getComposerInput(host);
    typeText(input, "my draft");
    dispatchKey(input, "ArrowUp");
    expect(getComposerValue(input)).toBe("newer");

    dispatchKey(input, "ArrowUp");
    expect(getComposerValue(input)).toBe("older");

    dispatchKey(input, "ArrowDown");
    expect(getComposerValue(input)).toBe("newer");

    // 越过最新一条 → 恢复进入 nav 之前的草稿。
    dispatchKey(input, "ArrowDown");
    expect(getComposerValue(input)).toBe("my draft");
  });

  it("does not persist previewed history entries over the latest draft", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
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
              typeKey: "deepseek-harness",
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
    await seedRenderableMessages("deepseek-harness", threadId, messages);
    await flushAnimationFrame();

    const input = getComposerInput(host);

    vi.useFakeTimers();

    typeText(input, "my latest draft");
    await vi.advanceTimersByTimeAsync(2000);
    expect(editor.getJSON().content?.[0]?.attrs?.inputDraft).toBe(
      "my latest draft",
    );

    dispatchKey(input, "ArrowUp");
    expect(getComposerValue(input)).toBe("newer");
    await vi.advanceTimersByTimeAsync(2000);
    expect(getComposerValue(input)).toBe("newer");
    expect(editor.getJSON().content?.[0]?.attrs?.inputDraft).toBe(
      "my latest draft",
    );

    dispatchKey(input, "ArrowDown");
    expect(getComposerValue(input)).toBe("my latest draft");

    dispatchKey(input, "ArrowDown");
    expect(getComposerValue(input)).toBe("my latest draft");

    dispatchKey(input, "ArrowUp");
    expect(getComposerValue(input)).toBe("newer");

    dispatchKey(input, "ArrowDown");
    expect(getComposerValue(input)).toBe("my latest draft");

    vi.useRealTimers();
  });

  it("treats Down as a no-op when not navigating", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
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
              typeKey: "deepseek-harness",
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
    await seedRenderableMessages("deepseek-harness", threadId, messages);
    await flushAnimationFrame();

    const input = getComposerInput(host);
    typeText(input, "draft");
    // 未进入 nav 态, Down 不动作 (preventDefault 仍调用, 所以光标不移动)。
    dispatchKey(input, "ArrowDown");
    expect(getComposerValue(input)).toBe("draft");
  });

  it("typing in nav mode exits navigation but keeps the edited text", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
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
              typeKey: "deepseek-harness",
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
    await seedRenderableMessages("deepseek-harness", threadId, messages);
    await flushAnimationFrame();

    const input = getComposerInput(host);
    dispatchKey(input, "ArrowUp");
    expect(getComposerValue(input)).toBe("second");

    // 用户在历史条目上追加内容 ── input 事件把 historyCursor 清回 null,
    // 退出 nav 态; 当前编辑内容保留。
    typeText(input, "second (edited)");
    expect(getComposerValue(input)).toBe("second (edited)");

    // 再次按 Up: 重新拍 preNavDraft, 跳到最新 user 消息。
    dispatchKey(input, "ArrowUp");
    expect(getComposerValue(input)).toBe("second");
  });

  it("lets native Up and Down move the caret until the composer reaches a boundary line", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
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
              typeKey: "deepseek-harness",
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
    await seedRenderableMessages("deepseek-harness", threadId, messages);
    await flushAnimationFrame();

    const input = getComposerInput(host);

    typeText(input, "draft\nmiddle\nend");
    setComposerCaret(input, "draft\n".length);
    const middleUp = dispatchKey(input, "ArrowUp");
    expect(middleUp.defaultPrevented).toBe(false);
    expect(getComposerValue(input)).toBe("draft\nmiddle\nend");

    setComposerCaret(input, "draft\nmiddle".length);
    const middleDown = dispatchKey(input, "ArrowDown");
    expect(middleDown.defaultPrevented).toBe(false);
    expect(getComposerValue(input)).toBe("draft\nmiddle\nend");

    setComposerCaret(input, 0);
    const boundaryUp = dispatchKey(input, "ArrowUp");
    expect(boundaryUp.defaultPrevented).toBe(true);
    expect(getComposerValue(input)).toBe("newer\nline");
  });

  it("keeps the current history position when the selected history text is not modified", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
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
              typeKey: "deepseek-harness",
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
    await seedRenderableMessages("deepseek-harness", threadId, messages);
    await flushAnimationFrame();

    const input = getComposerInput(host);

    dispatchKey(input, "ArrowUp");
    expect(getComposerValue(input)).toBe("newer");

    input.dispatchEvent(new Event("input", { bubbles: true }));
    setComposerCaret(input, 0);
    dispatchKey(input, "ArrowUp");

    expect(getComposerValue(input)).toBe("older");
  });
});

/**
 * 输入卡顿修复 ── 三处优化:
 *   A. update(node) 区分"消息影响类 attrs" 与"UI-only attrs", 后者跳过
 *      body 全量重建。
 *   B. persistInputDraft 走 2s debounce, 避免每个按键触发 ProseMirror 事务。
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
    // 在 debounce 触发前异步重建 body, 污染"lite 路径不重建"断言。
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 50 });
      return 1;
    });
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    useChatStore.setState(useChatStore.getInitialState(), true);
    agentAccessState.config = { entries: [] };
  });

  afterEach(() => {
    editor?.destroy();
    editor = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function typeText(input: ComposerInput, value: string): void {
    setComposerText(input, value);
  }

  it("keeps the existing message DOM when only the inputDraft attr changes", async () => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
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
              typeKey: "deepseek-harness",
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
    // Phase 4 (2026-08-02): 真源切到 session-store.
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    useAgentSessionStore.getState().setThreadProjection(threadId, (p) => ({
      ...p,
      messages,
    }));
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

    const input = getComposerInput(host);

    // 用户开始打字 ── debounce 期间 inputDraft attr 不变, ProseMirror
    // 不会派发任何事务, update(node) 不会被调用 ── 这是 B 的效果。
    typeText(input, "typing…");
    expect(editor.getJSON().content?.[0]?.attrs?.inputDraft ?? null).toBeNull();

    // 等真实 2s 让 debounce 触发 (testTimeout 默认 5s, 2.1s 安全)。
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2100);
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

    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
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
      await import("@features/agent/thread-card");
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
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
              typeKey: "deepseek-harness",
              collapsed: false,
            },
          },
        ],
      },
    });
    await flushAnimationFrame();

    // 模拟 agent 在跑 ── 真源是 useAgentSessionStore.threadProjections.
    // Phase 4 重构后 view 只读真源, 写 chat-store.threadStates 不会被读到.
    useAgentSessionStore.getState().setThreadProjection(threadId, (p) => ({
      ...p,
      runs: {
        isLoading: true,
        activeRunId: "run-1",
        runs: {
          "run-1": {
            runId: "run-1",
            agentType: "deepseek-harness",
            threadId,
            startedAt: Date.now(),
            status: "running",
          },
        },
      },
    }));
    await flushAnimationFrame();

    const input = getComposerInput(host);
    // 输入框不被 disabled ── 用户运行期可继续打字。
    expect(input.contentEditable).toBe("true");

    // 用户在运行期继续打字 ── 草稿留在 input 里。
    setComposerText(input, "next draft message");
    expect(getComposerValue(input)).toBe("next draft message");

    // DSH 运行期提交走 steer()，所以已提交草稿会被清空；输入框仍保持
    // 可编辑，后续消息进入 next-step steering 队列。
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    await flushPromises();
    expect(getComposerValue(input)).toBe("");
  });
});
