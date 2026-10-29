// @vitest-environment jsdom

import type { AgentAccessConfig, AgentAccessEntry } from "@/lib/types/agent-workspace.test-support";
import type { NotebookWorkspaceConfig } from "@/lib/types/agent-workspace";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  addFolderFromPicker,
  attachFolderToNotebook,
  detachFolderFromNotebook,
  openBrowserColumnFileBrowser,
  accessState,
} = vi.hoisted(() => ({
  addFolderFromPicker: vi.fn(),
  attachFolderToNotebook: vi.fn(async () => "saved" as const),
  detachFolderFromNotebook: vi.fn(async () => "saved" as const),
  openBrowserColumnFileBrowser: vi.fn(),
  // 可变 store 快照 ── 增删用例需要"写盘后重新读到新列表"这条链路成立。
  accessState: {
    config: { version: 1, entries: [], defaults: {} },
    notebookConfigs: {},
  } as {
    config: AgentAccessConfig;
    notebookConfigs: Record<string, NotebookWorkspaceConfig>;
  },
}));

vi.mock("@platform/tauri/client", () => ({
  agent: {},
  dshIntegration: { checkUpdate: vi.fn() },
  memos: { getMemos: vi.fn(async () => ({ memos: [], nextCursor: null, hasMore: false })) },
  windows: {},
  system: { getFeaturedNoteFilter: vi.fn(), setFeaturedNoteFilter: vi.fn() },
}));

vi.mock("@platform/tauri/event-bus", () => ({
  subscribe: vi.fn(() => vi.fn()),
}));

vi.mock("@features/memo/store/note-store", () => ({
  useNoteStore: {
    getState: () => ({
      selectedNotebook: { id: "notebook-1", name: "项目", path: "/repo/project" },
      notebooks: [{ id: "notebook-1", name: "项目", path: "/repo/project" }],
    }),
  },
}));

vi.mock("@features/memo/public/note-navigation-api", () => ({
  openNoteByMemoId: vi.fn(),
}));

vi.mock("@features/workspace/use-cases/browser-column-navigation", () => ({
  openBrowserColumnFileBrowser,
  openBrowserColumnNotebookNote: vi.fn(),
}));

vi.mock("@features/agent/store/agent-workspace-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@features/agent/store/agent-workspace-store")>();
  const getState = () => ({
      ...actual.useAgentWorkspaceStore.getState(),
      workspace: actual.projectAgentWorkspace({
        notebooks: [{ id: "notebook-1", name: "项目", path: "/repo/project" }],
        notebookConfigs: Object.fromEntries(Object.entries(accessState.notebookConfigs).map(([id, config]) => [id, {
          ...config, addDirs: config.addDirs.map(directory => ({ ...directory, missing: accessState.config.entries.find(e => e.path === directory.path)?.missing ?? false })),
        }])),
      }),
      workspaceActions: {
        ...actual.useAgentWorkspaceStore.getState().workspaceActions,
        addFolderFromPicker,
        attachFolderToNotebook,
        detachFolderFromNotebook,
        getNotebookFiles: () => undefined,
      },
    });
  return { ...actual, useAgentWorkspaceStore: Object.assign(
    (selector: Parameters<typeof actual.useAgentWorkspaceStore>[0]) => selector ? selector(getState()) : getState(),
    actual.useAgentWorkspaceStore,
    { getState },
  ) };
});

vi.mock("@features/agent/store/agent-session-store", () => ({
  useAgentSessionStore: {
    subscribe: vi.fn(() => vi.fn()),
    getState: () => ({
      getInstance: (id: string) => id === "mode-conversation"
        ? { runtimeConfig: { deepseekHarness: { mode: "standard" } } } : undefined,
      sessionMeta: { settings: {} },
    }),
  },
}));

vi.mock("@features/agent/store/dsh-model-config-store", () => ({
  loadDshModelConfigs: vi.fn(async () => []),
}));

import { ExternalAgentSettingsController } from "./external-agent-settings-controller";
import { AgentThreadCardSubscriptionsController } from "../runtime/thread-card-subscriptions-controller";
import { useAgentDataStore } from "@features/agent/store/agent-data-store";
import { useAgentWorkspaceStore } from "@features/agent/store/agent-workspace-store";

function folderEntry(path: string, name: string, missing = false): AgentAccessEntry {
  return {
    id: `fld_${name}`,
    kind: "folder",
    path,
    name,
    enabled: true,
    addedAt: 1,
    updatedAt: 1,
    missing,
  };
}

function setupAccess(entries: AgentAccessEntry[], addDirs: Array<{ path: string; label: string }>) {
  accessState.config = { version: 1, entries, defaults: {} };
  accessState.notebookConfigs = {
    "notebook-1": {
      version: 1,
      revision: 0,
      addDirs: addDirs.map((item) => ({
        id: `dir_${item.label}`,
        path: item.path,
        label: item.label,
        enabled: true,
      })),
    },
  };
}

describe("agent workspace popover repositories page", () => {
  let popover: HTMLDivElement;
  let controller: ExternalAgentSettingsController;
  let toast: ReturnType<typeof vi.fn<(kind: "success" | "error" | "info", message: string) => void>>;

  beforeEach(() => {
    document.body.replaceChildren();
    addFolderFromPicker.mockReset();
    attachFolderToNotebook.mockReset().mockResolvedValue("saved");
    detachFolderFromNotebook.mockReset().mockResolvedValue("saved");
    openBrowserColumnFileBrowser.mockReset();
    toast = vi.fn();
    setupAccess(
      [folderEntry("/repo/docs", "docs"), folderEntry("/repo/assets", "assets")],
      [
        { path: "/repo/docs", label: "docs" },
        { path: "/repo/assets", label: "assets" },
      ],
    );
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    popover = document.createElement("div");
    document.body.append(popover);
    controller = new ExternalAgentSettingsController({
      popover,
      getTypeKey: () => "codex",
      getInstanceId: () => undefined,
      getLanguage: () => "zh-CN",
      getEmptyStatePresentation: () => "inline-card",
      t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
      isDestroyed: () => false,
      toast,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 直接驱动「可访问」弹窗, 绕过 composer 控件。 */
  function openAccessPopover() {
    const button = controller.createComposerWorkspaceButton();
    document.body.append(button!);
    button!.click();
  }

  function pageTitles(): string[] {
    return Array.from(
      popover.querySelectorAll(".agent-thread-card__codex-settings-item-label"),
    ).map((node) => node.textContent ?? "");
  }

  /** 页头 / 页标题走独立的 title 类, 与列表行标签分开读。 */
  function headings(): string[] {
    return Array.from(
      popover.querySelectorAll(
        ".agent-thread-card__codex-settings-title, .agent-thread-card__codex-settings-header-title",
      ),
    ).map((node) => node.textContent ?? "");
  }

  it("keeps the DSH mode button and open picker subscribed to the user's choice", () => {
    useAgentDataStore.getState().setUserPreference("dsh", { mode: "code" });
    const modeController = new ExternalAgentSettingsController({
      popover, getTypeKey: () => "dsh", getInstanceId: () => "mode-conversation",
      getLanguage: () => "zh-CN", getEmptyStatePresentation: () => "inline-card",
      t: (key) => key, isDestroyed: () => false,
    });
    const button = modeController.createComposerModeButton()!;
    document.body.append(button);
    const subscriptions = new AgentThreadCardSubscriptionsController({
      getRuntimeThreadId: () => null, getRenderThreadId: () => null, getStoredThreadId: () => null,
      getTypeKey: () => "dsh", getInstanceId: () => "mode-conversation",
      getResolvedSessionId: () => null, renderThreadState: vi.fn(), refreshAttrs: vi.fn(),
      refreshExternalAgentEmptySettings: () => modeController.refreshEmptySettings(),
      isExternalSettingsOpen: () => true,
      renderCodexSettingsPopover: () => modeController.renderPopover(),
      applyResolvedExternalSessionId: vi.fn(), syncRuntimeBadge: vi.fn(),
    });
    subscriptions.subscribe();
    try {
      expect(button.textContent).toContain("agent.mode.code");
      button.click();
      expect(popover.querySelector('[aria-checked="true"]')?.textContent).toContain("agent.mode.code");
      useAgentDataStore.getState().setUserPreference("dsh", { mode: "minimal" });
      expect(button.textContent).toContain("agent.mode.minimal");
      expect(popover.querySelector('[aria-checked="true"]')?.textContent).toContain("agent.mode.minimal");
    } finally {
      subscriptions.dispose();
      modeController.dispose();
    }
  });

  it("refreshes Agent settings when the workspace snapshot changes", () => {
    const refreshAttrs = vi.fn();
    const refreshExternalAgentEmptySettings = vi.fn();
    const subscriptions = new AgentThreadCardSubscriptionsController({
      getRuntimeThreadId: () => null, getRenderThreadId: () => null, getStoredThreadId: () => null,
      getTypeKey: () => "dsh", getInstanceId: () => null,
      getResolvedSessionId: () => null, renderThreadState: vi.fn(), refreshAttrs,
      refreshExternalAgentEmptySettings, isExternalSettingsOpen: () => false,
      renderCodexSettingsPopover: vi.fn(), applyResolvedExternalSessionId: vi.fn(), syncRuntimeBadge: vi.fn(),
    });
    const previousWorkspace = useAgentWorkspaceStore.getState().workspace;
    subscriptions.subscribe();
    try {
      useAgentWorkspaceStore.setState({ workspace: {
        ...previousWorkspace,
        resources: [...previousWorkspace.resources, {
          id: "folder-1", path: "/folder-1", name: "folder-1", enabled: true, missing: false,
        }],
      } });
      expect(refreshAttrs).toHaveBeenCalledOnce();
      expect(refreshExternalAgentEmptySettings).toHaveBeenCalledOnce();
    } finally {
      subscriptions.dispose();
      useAgentWorkspaceStore.setState({ workspace: previousWorkspace });
    }
  });

  it("首先渲染只读的「可访问」页, 不跳转文件浏览器", () => {
    openAccessPopover();
    expect(headings()).toContain("agent.workspace.access");
    expect(pageTitles()).toContain("docs");
    expect(pageTitles()).toContain("assets");
    // 旧实现点击「设置」会直接打开文件浏览器列; 现在必须是弹窗内翻页。
    expect(openBrowserColumnFileBrowser).not.toHaveBeenCalled();
  });

  it("点击「管理仓库」在原弹窗内翻页到仓库列表", () => {
    openAccessPopover();
    const manage = Array.from(
      popover.querySelectorAll<HTMLButtonElement>(".agent-thread-card__codex-settings-settings"),
    )[0];
    manage.click();

    expect(popover.querySelector(".agent-thread-card__codex-settings-header")).not.toBeNull();
    expect(headings()).toContain("agent.workspace.repositories");
    expect(pageTitles()).toContain("docs");
    expect(pageTitles()).toContain("assets");
    expect(pageTitles()).toContain("agent.workspace.addRepository");
    // 翻页仍然停留在同一个弹窗节点里。
    expect(openBrowserColumnFileBrowser).not.toHaveBeenCalled();
  });

  it("仓库行是 div 容器, 不含 disabled 状态且删除入口可交互", () => {
    openAccessPopover();
    (popover.querySelector(".agent-thread-card__codex-settings-settings") as HTMLButtonElement).click();

    const rows = Array.from(
      popover.querySelectorAll<HTMLElement>(
        ".agent-thread-card__codex-settings-repository",
      ),
    );
    expect(rows).toHaveLength(2);
    rows.forEach((row) => {
      // 行不能是 button: 内层再嵌删除 button 属于非法嵌套, HTML 解析器会把
      // 内层按钮弹出到行外, 删除入口就脱离行布局了。
      expect(row.tagName).toBe("DIV");
      expect(row.hasAttribute("aria-disabled")).toBe(false);
      expect(row.classList.contains("agent-thread-card__codex-settings-item--readonly")).toBe(false);
      expect(row.getAttribute("role")).toBe("menuitem");
      expect(row.hasAttribute("aria-checked")).toBe(false);
      // 行不是可点项, 唯一的动作是行内删除按钮。
      const remove = row.querySelector<HTMLButtonElement>(
        ".agent-thread-card__codex-settings-repository-remove",
      );
      expect(remove).not.toBeNull();
      expect(remove?.disabled).toBe(false);
      expect(remove?.parentElement).toBe(row);
    });
  });

  it("仓库列表可以返回到「可访问」页", () => {
    openAccessPopover();
    (popover.querySelector(".agent-thread-card__codex-settings-settings") as HTMLButtonElement).click();
    const back = popover.querySelector<HTMLButtonElement>(".agent-thread-card__codex-settings-back")!;
    expect(back).not.toBeNull();
    expect(back.querySelector(".agent-thread-card__codex-settings-header-title")?.textContent)
      .toBe("agent.workspace.repositories");
    back.click();

    expect(popover.querySelector(".agent-thread-card__codex-settings-header")).toBeNull();
    expect(headings()).toContain("agent.workspace.access");
    expect(pageTitles()).toContain("agent.workspace.manageRepositories");
  });

  it("删除仓库只从当前笔记本移除对应路径", async () => {
    openAccessPopover();
    (popover.querySelector(".agent-thread-card__codex-settings-settings") as HTMLButtonElement).click();

    const removeButtons = popover.querySelectorAll<HTMLButtonElement>(
      ".agent-thread-card__codex-settings-repository-remove",
    );
    expect(removeButtons).toHaveLength(2);
    removeButtons[0].click();

    await vi.waitFor(() => {
      expect(detachFolderFromNotebook).toHaveBeenCalledTimes(1);
    });
    expect(detachFolderFromNotebook).toHaveBeenCalledWith("notebook-1", "/repo/docs");
    expect(toast).toHaveBeenCalledWith(
      "success",
      expect.stringContaining("agent.access.folderDeleted"),
    );
  });

  it("添加仓库把 picker 选中的目录追加到列表", async () => {
    addFolderFromPicker.mockResolvedValue({
      ok: true,
      entry: folderEntry("/repo/new", "new"),
    });
    openAccessPopover();
    (popover.querySelector(".agent-thread-card__codex-settings-settings") as HTMLButtonElement).click();

    // 「添加仓库」与第一页的「管理仓库」共用 settings 行契约, 所以按文案定位。
    const add = Array.from(
      popover.querySelectorAll<HTMLButtonElement>(".agent-thread-card__codex-settings-settings"),
    ).find((button) => button.textContent?.includes("agent.workspace.addRepository"))!;
    add.click();

    await vi.waitFor(() => {
      expect(addFolderFromPicker).toHaveBeenCalledWith("notebook-1");
    });
    expect(attachFolderToNotebook).not.toHaveBeenCalled();
  });

  it("关闭弹窗后重新打开会回到「可访问」页", () => {
    openAccessPopover();
    (popover.querySelector(".agent-thread-card__codex-settings-settings") as HTMLButtonElement).click();
    expect(popover.querySelector(".agent-thread-card__codex-settings-header")).not.toBeNull();

    controller.setSettingsPopoverOpen(false);
    openAccessPopover();

    expect(popover.querySelector(".agent-thread-card__codex-settings-header")).toBeNull();
    expect(headings()).toContain("agent.workspace.access");
  });

  it("列表为空时显示引导文案, 并保留添加入口", () => {
    setupAccess([], []);
    openAccessPopover();
    (popover.querySelector(".agent-thread-card__codex-settings-settings") as HTMLButtonElement).click();

    const empty = popover.querySelector(".agent-thread-card__codex-settings-empty");
    expect(empty?.textContent).toBe("agent.workspace.repositoriesEmpty");
    expect(
      Array.from(
        popover.querySelectorAll<HTMLButtonElement>(".agent-thread-card__codex-settings-settings"),
      ).some((button) => button.textContent?.includes("agent.workspace.addRepository")),
    ).toBe(true);
  });
});
