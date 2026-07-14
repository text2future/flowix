/**
 * 回归测试 ── `getFilesControlLabel` 兜底链
 *
 * 覆盖"默认态显示的工作空间文件夹 与 下拉标三角的不一致" 这一类 bug:
 *   - per-thread `files.workspace` / `folders[0]` 被另一条 entry 占用时,
 *     之前会直接用 per-thread 路径 (跟全局 `entry.workspace=true` 不同),
 *     视觉上默认态与下拉三角对不上。 修复后默认态优先走下拉标的同一条 entry。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAccessEntry } from "@/lib/types/agent-access";

const agentAccessMock = vi.hoisted(() => ({
  config: { version: 1, entries: [] as AgentAccessEntry[] },
  isLoading: false,
  loadInitial: vi.fn(async () => undefined),
  toggle: vi.fn(async () => undefined),
  setWorkspace: vi.fn(async () => undefined),
  clearWorkspace: vi.fn(async () => undefined),
  addFolderFromPicker: vi.fn(async () => ({ ok: false, code: "not-selected" as const })),
  addFolder: vi.fn(async () => ({ ok: false, code: "save-failed" as const })),
  removeFolder: vi.fn(async () => undefined),
}));

const conversationStoreMock = vi.hoisted(() => ({
  instances: {} as Record<
    string,
    {
      runtimeConfig?: {
        files?: {
          workspace?: string;
          folders?: string[];
          notebooks?: string[];
        };
      };
    }
  >,
  setRuntimeConfig: vi.fn(),
}));

const chatStoreMock = vi.hoisted(() => ({
  agentCodexModel: "inherit",
  agentCodexReasoningEffort: "medium",
  agentPermissionMode: "workspace-write",
  setAgentCodexModel: vi.fn(),
  setAgentCodexReasoningEffort: vi.fn(),
  setAgentPermissionMode: vi.fn(),
}));

const memoStoreMock = vi.hoisted(() => ({
  selectedNotebook: null as null | { path?: string; id?: string } | unknown,
}));

vi.mock("@features/agent/store/agent-access-store", () => ({
  useAgentAccessStore: {
    getState: () => agentAccessMock,
  },
}));

vi.mock("@features/agent/store/agent-conversation-store", () => ({
  useAgentConversationStore: {
    getState: () => conversationStoreMock,
  },
}));

vi.mock("@features/agent/store/chat-store", () => ({
  useChatStore: {
    getState: () => chatStoreMock,
  },
}));

vi.mock("@features/memo/store/memo-store", () => ({
  useMemoStore: {
    getState: () => ({ selectedNotebook: memoStoreMock.selectedNotebook }),
  },
}));

vi.mock("@platform/tauri/client", () => ({
  agent: {
    getCodexDefaultModel: vi.fn(async () => ""),
    listSupportedModels: vi.fn(async () => []),
  },
}));

vi.mock("@features/editor/extensions/agent-thread-card/popover/popover-position", () => ({
  applyPopoverPosition: vi.fn(),
  calculateAnchoredPopoverPosition: vi.fn(() => ({ left: 0, top: 0 })),
}));

vi.mock("@features/agent/config/codex-options", () => ({
  CODEX_MODEL_OPTIONS: [],
  CODEX_REASONING_OPTIONS: [],
}));

vi.mock("@features/agent/runtime/agent-runtime-spec", () => ({
  getAgentAccessOptions: () => [],
  supportsAgentRuntimeSetting: () => false,
}));

function makeEntry(
  overrides: Partial<AgentAccessEntry>,
): AgentAccessEntry {
  return {
    id: overrides.id ?? "entry-1",
    kind: overrides.kind ?? "folder",
    path: overrides.path ?? "/Users/rop/Documents/flowix/",
    name: overrides.name ?? "flowix",
    enabled: overrides.enabled ?? true,
    workspace: overrides.workspace ?? false,
    missing: overrides.missing ?? false,
    addedAt: 1,
    updatedAt: 1,
  };
}

async function loadController() {
  const mod = await import(
    "@features/editor/extensions/agent-thread-card/settings/external-agent-settings-controller"
  );
  return mod.ExternalAgentSettingsController;
}

function makeControllerArgs(instanceId?: string) {
  const popover = document.createElement("div");
  document.body.append(popover);
  return {
    popover,
    getTypeKey: () => "codex" as const,
    getInstanceId: () => instanceId,
    getLanguage: () => "zh-CN" as const,
    t: (key: string) => key,
    isDestroyed: () => false,
    isAccessPopoverOpen: () => false,
    setAccessPopoverOpen: vi.fn(),
  };
}

describe("ExternalAgentSettingsController.getFilesControlLabel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    agentAccessMock.config = { version: 1, entries: [] };
    conversationStoreMock.instances = {};
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("默认态 - 全局无 instance 时显示全局 entry.workspace=true", async () => {
    // 模拟用户场景:
    //   - 全局 workspace 设在了 flowix (下拉标三角)
    //   - per-thread 也配了 workspace = 菜谱 (用户在弹窗里改的)
    // 新语义: instance 优先 ── 用户已显式改过 per-thread workspace, 它压过
    // 全局 entry.workspace=true。 旧版是"全局压 per-thread", 与用户预期不符
    // (用户在 thread 里改的东西被无视)。 全局 flowix 只在 per-thread 完全
    // 没设时, 作为"默认未配置时"的兜底生效。
    // 本 case 验证: thread 里已显式设了 workspace=菜谱, 它压过全局 flowix。
    agentAccessMock.config = {
      version: 1,
      entries: [
        makeEntry({
          id: "flowix",
          path: "/Users/rop/Documents/flowix/",
          name: "flowix",
          workspace: true,
        }),
        makeEntry({
          id: "caipu",
          path: "/Users/rop/Desktop/Notes/菜谱/",
          name: "菜谱",
          workspace: false,
        }),
      ],
    };
    conversationStoreMock.instances = {
      "inst-1": {
        runtimeConfig: {
          files: {
            workspace: "/Users/rop/Desktop/Notes/菜谱/",
            folders: ["/Users/rop/Desktop/Notes/菜谱/"],
            notebooks: [],
          },
        },
      },
    };

    const Controller = await loadController();
    const args = makeControllerArgs("inst-1");
    const controller = new Controller(args);
    const empty = controller.createEmptySettings();
    const valueEl = empty.querySelector<HTMLElement>(
      ".agent-thread-card__empty-control-value",
    );
    expect(valueEl?.textContent).toBe("菜谱");
    controller.dispose();
  });

  it("无全局 workspace 时, 退到 per-thread files.workspace", async () => {
    agentAccessMock.config = {
      version: 1,
      entries: [
        makeEntry({
          id: "caipu",
          path: "/Users/rop/Desktop/Notes/菜谱/",
          name: "菜谱",
          workspace: false,
        }),
      ],
    };
    conversationStoreMock.instances = {
      "inst-1": {
        runtimeConfig: {
          files: {
            workspace: "/Users/rop/Desktop/Notes/菜谱/",
            folders: [],
            notebooks: [],
          },
        },
      },
    };

    const Controller = await loadController();
    const args = makeControllerArgs("inst-1");
    const controller = new Controller(args);
    const empty = controller.createEmptySettings();
    const valueEl = empty.querySelector<HTMLElement>(
      ".agent-thread-card__empty-control-value",
    );
    expect(valueEl?.textContent).toBe("菜谱");
    controller.dispose();
  });

  it("默认态 - per-thread 没设时, 退化到全局 entry.workspace=true", async () => {
    // 模拟用户从未在弹窗里改过 per-thread, 完全依赖全局默认:
    //   - 全局 workspace 设在了 flowix
    //   - thread 上 files 全空 (没 instance.workspace, 没 folders, 没 notebooks)
    // 应当显示 flowix, 因为全局主空间作为"默认未配置时"的兜底生效。
    agentAccessMock.config = {
      version: 1,
      entries: [
        makeEntry({
          id: "flowix",
          path: "/Users/rop/Documents/flowix/",
          name: "flowix",
          workspace: true,
        }),
        makeEntry({
          id: "caipu",
          path: "/Users/rop/Desktop/Notes/菜谱/",
          name: "菜谱",
          workspace: false,
        }),
      ],
    };
    conversationStoreMock.instances = {
      "inst-1": {
        runtimeConfig: {
          files: {
            workspace: undefined,
            folders: [],
            notebooks: [],
          },
        },
      },
    };

    const Controller = await loadController();
    const args = makeControllerArgs("inst-1");
    const controller = new Controller(args);
    const empty = controller.createEmptySettings();
    const valueEl = empty.querySelector<HTMLElement>(
      ".agent-thread-card__empty-control-value",
    );
    expect(valueEl?.textContent).toBe("flowix");
    controller.dispose();
  });

  it("无全局 workspace + per-thread folders[0] 时, 展示 per-thread 第一项", async () => {
    agentAccessMock.config = {
      version: 1,
      entries: [
        makeEntry({
          id: "flowix",
          path: "/Users/rop/Documents/flowix/",
          name: "flowix",
          workspace: false,
        }),
      ],
    };
    conversationStoreMock.instances = {
      "inst-1": {
        runtimeConfig: {
          files: {
            workspace: undefined,
            folders: ["/Users/rop/Documents/flowix/"],
            notebooks: [],
          },
        },
      },
    };

    const Controller = await loadController();
    const args = makeControllerArgs("inst-1");
    const controller = new Controller(args);
    const empty = controller.createEmptySettings();
    const valueEl = empty.querySelector<HTMLElement>(
      ".agent-thread-card__empty-control-value",
    );
    expect(valueEl?.textContent).toBe("flowix");
    controller.dispose();
  });

  it("完全无配置时, 展示空态文案", async () => {
    agentAccessMock.config = { version: 1, entries: [] };
    conversationStoreMock.instances = {};

    const Controller = await loadController();
    const args = makeControllerArgs("inst-1");
    const controller = new Controller(args);
    const empty = controller.createEmptySettings();
    const valueEl = empty.querySelector<HTMLElement>(
      ".agent-thread-card__empty-control-value",
    );
    expect(valueEl?.textContent).toBe("agent.access.empty.empty");
    controller.dispose();
  });
});
