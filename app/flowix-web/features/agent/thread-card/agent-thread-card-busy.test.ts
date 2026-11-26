
import type { AgentAccessConfig } from "@/lib/types/agent-workspace.test-support";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentClientMock } from "@features/agent/store/agent-client.test-support";

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
  config: { version: 1, entries: [] } as AgentAccessConfig,
}));

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({ toast: toastMock }));

vi.mock("@features/workspace/use-cases/browser-column-navigation", () => ({
  // 工作区内文件的链接需要 file-browser target；漏掉会让 openAgentLink
  // 抛 "createFileBrowserTarget is not a function"，链接点了没反应。
  createFileBrowserTarget: vi.fn(
    (activeFilePath: string | null, scopePath: string | null = null, folderPath: string | null = null) => ({
      kind: "file-browser" as const,
      activeFilePath,
      ...(scopePath ? { scopePath } : {}),
      ...(folderPath ? { folderPath } : {}),
    }),
  ),
  openBrowserColumnFileBrowser: vi.fn(() => ({
    host: 'column-2',
    surfaceId: 'file-browser:/Users/rop/Desktop/vibe/flowix-main',
    alreadyOpen: false,
  })),
  openBrowserColumnNotebookNote: vi.fn(() => ({
    host: 'column-2', surfaceId: 'file:external-note', alreadyOpen: false,
  })),
  openBrowserColumnText: vi.fn(() => ({
    host: 'column-2', surfaceId: 'file:external-text', alreadyOpen: false,
  })),
  openBrowserColumnWebpage: vi.fn(() => ({
    host: 'column-2',
    surfaceId: 'web:https://example.com/docs',
    alreadyOpen: false,
  })),
}));

vi.mock("@features/memo/public/note-navigation-api", () => ({
  openNoteByDeepLink: vi.fn(async () => undefined),
}));

const openSurfaceMock = vi.hoisted(() => vi.fn(async (_request?: unknown) => ({
    status: "opened",
    surfaceId: "browser:test",
    // 行号/锚点定位会读 opened.location 的 host 与 surfaceId。
    location: { host: "column-2", surfaceId: "browser:test" },
  })));
vi.mock("@features/workspace/public/open-surface-api", () => ({ openSurfaceAtPosition: openSurfaceMock }));

vi.mock("@features/workspace/public/session-opening-api", async (importOriginal) => ({
  ...await importOriginal<typeof import('@features/workspace/public/session-opening-api')>(),
  openPreparedSurfaceInColumn: async (_request: unknown, prepare: (isCurrent: () => boolean) => Promise<{ target: unknown }>) => {
    const prepared = await prepare(() => true);
    return openSurfaceMock({ index: 1, source: 'agent-message', target: prepared.target });
  },
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(async () => undefined),
  openUrl: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("@platform/tauri/client", () => ({
  files: {
    resolveLocation: vi.fn(async (path: string) => ({ path, notebookId: null, notebookPath: null, isDirectory: false })),
  },
  // The cloud access card reads account state through this surface; it is not the
  // subject of these tests, so every call resolves empty rather than throwing.
  cloud: new Proxy({} as Record<string, unknown>, {
    get: () => vi.fn(async () => null),
  }),
  agent: {
    ...createAgentClientMock(),
    listSupportedModels: vi.fn(async () => []),
    cacheAttachment: vi.fn(async () => ({
      path: "/tmp/cached-agent-image.png",
      mimeType: "image/png",
      name: "cached-agent-image.png",
    })),
    deleteCachedAttachment: vi.fn(async () => true),
    readCachedAttachment: vi.fn(async () => null),
    getDeepSeekHarnessSessionId: vi.fn(async () => null),
    getCodexSessionId: vi.fn(async () => null),
    getClaudeSessionId: vi.fn(async () => null),
    getCodexDefaultModel: vi.fn(async () => "gpt-5.5"),
  },
  agentWorkspace: {},
  piModels: {
    getFeatures: vi.fn(async () => ({ toolSearch: false })),
    clearLegacyCodeMode: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
  },
  notes: {
    search: vi.fn(async () => []),
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
  // The DeepSeek Harness empty state probes for a newer runtime on render.
  // Resolve with "no update" so the notice stays hidden; without this export
  // the mocked module throws before the caller's .catch() can run.
  dshIntegration: {
    checkUpdate: vi.fn(async () => ({
      currentVersion: null,
      latestVersion: null,
      updateAvailable: false,
    })),
  },
  listenToAgentStream: vi.fn(),
}));

vi.mock("@features/agent/store/agent-workspace-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@features/agent/store/agent-workspace-store")>();
  const getState = () => ({ ...actual.useAgentWorkspaceStore.getState(),
    workspace: {
      ...actual.useAgentWorkspaceStore.getState().workspace,
      ...actual.projectAgentWorkspace({ notebooks: agentAccessState.config.entries.filter(e => e.kind === "notebook"), notebookConfigs: Object.fromEntries(
        Object.entries(agentAccessState.config.defaults?.files ?? {}).map(([id, files]) => [id, {
          version: 1, revision: 1, addDirs: files.folders.map((path) => ({ id: path, path, label: path, enabled: true })),
        }]),
      ) }),
    },
    workspaceActions: {
      ...actual.useAgentWorkspaceStore.getState().workspaceActions,
      addFolderFromPicker: vi.fn(async () => ({ ok: true as const })),
      attachFolderToNotebook: vi.fn(async () => "saved" as const),
      detachFolderFromNotebook: vi.fn(async () => "saved" as const),
      getNotebookFiles: (id: string | null | undefined) => id ? agentAccessState.config.defaults?.files?.[id] : undefined,
      loadInitial: vi.fn(async () => true),
    },
  });
  return { ...actual, ensureAgentWorkspaceReady: vi.fn(async () => {}), useAgentWorkspaceStore: Object.assign(
    (selector: Parameters<typeof actual.useAgentWorkspaceStore>[0]) => selector ? selector(getState()) : getState(),
    actual.useAgentWorkspaceStore,
    { getState },
  ) };
});

vi.mock("@features/agent/store/agent-runtime-store", () => {
  const state = {
    statusByType: {},
    isChecking: false,
    refresh: vi.fn(),
    refreshIfStale: vi.fn(async () => undefined),
  };
  // The source consumes this as a hook (`useAgentRuntimeStore(selector)`), so the
  // mock has to be callable — a plain object breaks any render path that reaches it.
  const useAgentRuntimeStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    {
      getState: () => state,
      subscribe: vi.fn(() => () => undefined),
    },
  );
  return { useAgentRuntimeStore };
});

vi.mock("@features/memo/store/note-store", () => ({
  useNoteStore: Object.assign(
    (selector: (state: typeof memoStateMock) => unknown) => selector(memoStateMock),
    {
      getState: () => memoStateMock,
      subscribe: vi.fn(() => () => undefined),
    },
  ),
}));

vi.mock("@features/memo/components/notebook-icon", () => ({
  getNotebookIconLetter: () => "N",
  getNotebookIconUrl: () => null,
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
vi.mock("@features/document/store/document-session-service", () => ({
  getActiveDocumentDraft: () => null,
}));
vi.mock("@features/document/store/document-store", () => ({
  useDocumentStore: {
    getState: () => ({ currentDocumentPath: "" }),
  },
}));

vi.mock("@features/memo/public/note-navigation-api", () => ({
  openNoteByDeepLink: vi.fn(),
}));

vi.mock("@features/shortcuts", () => ({
  isWindowsPlatform: () => false,
}));

vi.mock("@features/preferences/store/user-settings-store", () => {
  const state = {
    settings: { language: "zh-CN", agents: { enabledByType: {} } },
    updateSettings: vi.fn(),
  };
  return {
    // Consumers call this as a hook, so the mock must be callable.
    useUserSettingsStore: Object.assign(
      (selector: (value: typeof state) => unknown) => selector(state),
      {
        getState: () => state,
        subscribe: () => () => undefined,
      },
    ),
  };
});

async function flushAnimationFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

type ComposerInput = HTMLDivElement & { editor?: Editor };

function getComposerInput(root: ParentNode): ComposerInput {
  const input = root.querySelector<HTMLDivElement>(
    ".agent-composer__input",
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

// Load the integration graph during module collection, outside interaction budgets.
await import("@features/agent/thread-card");
await import("@features/editor/extensions/block-drag");
await import("@tiptap/markdown");

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
        unobserve() {}
        disconnect() {}
      },
    );

    const { useChatStore } = await import("@features/agent/store/agent-session-test-facade");
    useChatStore.setState(useChatStore.getInitialState(), true);
    agentAccessState.config = { version: 1, entries: [] };
  });

  afterEach(() => {
    editor?.destroy();
    editor = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each(["dsh", "pi"] as const)("queues a message while %s is running", async (agentType) => {
    const { AgentThreadCard } =
      await import("@features/agent/thread-card");
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    const threadId = `thread-card-busy-composer-${agentType}`;
    const host = document.createElement("div");
    document.body.append(host);
    useAgentSessionStore.getState().updateThreadHistory(threadId, (projection) => ({
      ...projection,
      messages: [{ role: "user", content: "initial message", id: "initial-user", timestamp: new Date().toISOString() }],
    }));

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
              typeKey: agentType,
              collapsed: false,
            },
          },
        ],
      },
    });
    await flushAnimationFrame();

    // 模拟 agent 在跑 ── 真源是 useAgentSessionStore.threadProjections.
    // Phase 4 重构后 view 只读真源, 写 chat-store.threadStates 不会被读到.
    useAgentSessionStore.getState().updateThreadRuns(threadId, () => ({
        isLoading: true,
        activeRunId: "run-1",
        runs: {
          "run-1": {
            runId: "run-1",
            agentType,
            threadId,
            startedAt: Date.now(),
            status: "running",
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

    // 运行中提交后清空草稿；Pi 的消息默认进入 Follow-up。
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    await vi.waitFor(() => expect(getComposerValue(input)).toBe(""));
    if (agentType === "pi") {
      await vi.waitFor(() => {
        expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toEqual([
          expect.objectContaining({ content: "next draft message", deliveryMode: "follow_up" }),
        ]);
      });
      // 排队行的 DOM 呈现（马上发送 / 立即发送 / 删除）依赖卡片的 render
      // 周期，在 jsdom 时序下不可靠，这里只断言 store 层的排队语义。
      // steer 与删除的交互由真实环境覆盖（view 的 promoteFollowUpToSteer /
      // deleteQueuedFollowUp，见 agent-thread-card-view.tsx 的队列行渲染）。
    }
  });
});
