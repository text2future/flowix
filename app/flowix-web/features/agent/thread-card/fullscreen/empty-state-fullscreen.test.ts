import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentClientMock } from "@features/agent/store/agent-client.test-support";

/**
 * 空状态形态与全屏的联动，必须在真实卡片上验证：
 * 形态只在这些时刻重算 ── 首次创建、以及每次 render 走
 * ThreadMessageRenderController 的复用判定。控制器单测能证明"形态变了会重建"，
 * 但证明不了"点全屏确实触发了那次 render"，而后者才是刷新后才正常的根因。
 */

vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(async () => undefined),
  openUrl: vi.fn(async () => undefined),
}));

vi.mock("@platform/tauri/client", () => ({
  agent: {
    ...createAgentClientMock(),
    listSupportedModels: vi.fn(async () => []),
    getCodexDefaultModel: vi.fn(async () => "gpt-5.5"),
    readNotebookAgentSkills: vi.fn(async () => []),
  },
  agentWorkspace: {},
  piModels: {
    getFeatures: vi.fn(async () => ({ toolSearch: false })),
    clearLegacyCodeMode: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
  },
  system: {
    getFeaturedNoteFilter: vi.fn(async () => ({ conditions: [], tableSelection: null })),
    setFeaturedNoteFilter: vi.fn(async () => undefined),
  },
  notes: { search: vi.fn(async () => []), list: vi.fn(async () => []) },
  files: { listTableDocuments: vi.fn(async () => []) },
  externalDocuments: { read: vi.fn(async () => "") },
  windows: {},
  deepseekHarness: {
    get: vi.fn(async () => ({ model: null })),
    list: vi.fn(async () => []),
    sessionUsage: vi.fn(async () => null),
  },
  dshIntegration: {
    checkUpdate: vi.fn(async () => ({
      currentVersion: null,
      latestVersion: null,
      updateAvailable: false,
    })),
  },
  listenToAgentStream: vi.fn(),
}));

vi.mock("@features/memo/store/note-store", () => ({
  useNoteStore: Object.assign(
    () => null,
    {
      getState: () => ({ selectedNotebook: null, selectedMemo: null, notebooks: [] }),
      subscribe: vi.fn(() => () => undefined),
    },
  ),
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
  useDocumentStore: { getState: () => ({ currentDocumentPath: "" }) },
}));

vi.mock("@features/shortcuts", () => ({ isWindowsPlatform: () => false }));

vi.mock("@features/preferences/store/user-settings-store", () => ({
  useUserSettingsStore: {
    getState: () => ({ settings: { language: "zh-CN" } }),
    subscribe: () => () => undefined,
  },
}));

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

describe("Thread Card 空状态随全屏切换", () => {
  let editor: Editor | null = null;

  beforeAll(() => {
    // jsdom 里既没有 ResizeObserver 也没有 idle 队列；空状态在全屏时依赖空闲
    // 回调节流加载技能，缺了会让展开态停在加载中。
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 50 });
      return 1;
    });
    vi.stubGlobal("cancelIdleCallback", vi.fn());
  });

  afterEach(() => {
    editor?.destroy();
    editor = null;
    document.body.replaceChildren();
  });

  it("空卡片进出全屏时换成对应形态的空状态", async () => {
    const { AgentThreadCard } = await import("@features/agent/thread-card");
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
            attrs: { title: "Empty Fullscreen Card", typeKey: "codex" },
          },
        ],
      },
    });

    const card = host.querySelector<HTMLElement>(".agent-thread-card");
    const empty = () => card?.querySelector<HTMLElement>(".agent-thread-card__empty");
    const toggle = () =>
      host.querySelector<HTMLButtonElement>(".agent-thread-card__fullscreen")?.click();

    expect(empty()?.classList.contains("agent-thread-card__empty--inline-card")).toBe(true);
    expect(card?.querySelector(".agent-conversation__controls")).not.toBeNull();

    toggle();
    await settle();

    // 全屏卡片与独立对话是同一个面，必须拿到同一份展开态指引。
    expect(card?.classList.contains("agent-thread-card--fullscreen")).toBe(true);
    expect(empty()?.classList.contains("agent-thread-card__empty--expanded")).toBe(true);
    expect(card?.querySelector(".agent-thread-card__empty-welcome")).not.toBeNull();
    expect(card?.querySelector(".agent-conversation__controls")).toBeNull();

    toggle();
    await settle();

    // 退全屏不能把展开态的 DOM 留在卡片里。
    expect(card?.classList.contains("agent-thread-card--fullscreen")).toBe(false);
    expect(empty()?.classList.contains("agent-thread-card__empty--inline-card")).toBe(true);
    expect(card?.querySelector(".agent-thread-card__empty-welcome")).toBeNull();
    expect(card?.querySelector(".agent-conversation__controls")).not.toBeNull();
  });
});
