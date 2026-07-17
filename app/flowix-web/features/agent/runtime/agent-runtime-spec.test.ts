import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentRuntimeConfig,
  getAgentAccessOptions,
  normalizeCodexPermissionMode,
  supportsAgentEmptySettings,
} from "@features/agent/runtime/agent-runtime-spec";
import type {
  AgentAccessEntry,
  AgentAccessConfig,
} from "@/lib/types/agent-access";

// store / agent-access-store 用 ── mock 后让 buildAgentRuntimeConfig 走 global
// 读取路径时不会真去 IPC 拿磁盘真值, 也不会被现有 thread 状态污染。
const agentAccessMock = vi.hoisted(() => ({
  config: { version: 1, entries: [] as AgentAccessEntry[] } as AgentAccessConfig,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@features/agent/store/agent-access-store", () => ({
  useAgentAccessStore: {
    getState: () => ({ config: agentAccessMock.config }),
  },
}));

vi.mock("@features/memo/components/notebook-icon", () => ({
  getNotebookIconMarkup: () => null,
}));

function makeFolder(
  overrides: Partial<AgentAccessEntry>,
): AgentAccessEntry {
  return {
    id: overrides.id ?? "folder-1",
    kind: overrides.kind ?? "folder",
    path: overrides.path ?? "D:\\projects\\first",
    name: overrides.name ?? "First",
    enabled: overrides.enabled ?? true,
    workspace: overrides.workspace ?? false,
    missing: overrides.missing ?? false,
    addedAt: 1,
    updatedAt: 1,
  };
}

describe("buildAgentRuntimeConfig primaryWorkspace cascade", () => {
  beforeEach(() => {
    agentAccessMock.config = { version: 1, entries: [] };
  });

  it("returns cwd=undefined when global is empty and no input (CLI would fail)", () => {
    // 完全没有任何输入 ── global store 空 + cwd 没传 + instanceFiles 没设,
    // 这种情况下 buildAgentRuntimeConfig 不强行编一个 cwd 出来, 把"空"事实
    // 暴露给上层, 让 dispatch 层判断是否要拦截而不是闷头 invoke CLI。
    const result = buildAgentRuntimeConfig({
      typeKey: "claude",
      cwd: undefined,
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "low",
    });
    expect(result.claude?.cwd).toBeUndefined();
    expect(result.claude?.workspacePaths).toEqual([]);
  });

  it("uses cwd when no per-thread and no global workspace exist", () => {
    // 兜底链的最后一环 ── 用户从某篇 note 提交 (systemReminderDirectory
    // 给出当前 note 所在 notebook 路径), 这条 cwd 还没被 per-thread 覆盖。
    const result = buildAgentRuntimeConfig({
      typeKey: "claude",
      cwd: "D:\\notes\\first",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "low",
    });
    expect(result.claude?.cwd).toBe("D:\\notes\\first");
  });

  it("does not fall back to global workspace when runtime files are explicitly empty", () => {
    agentAccessMock.config = {
      version: 1,
      entries: [
        makeFolder({
          id: "folder-global",
          path: "D:\\global-workspace",
          name: "GlobalWS",
          workspace: true,
          enabled: true,
        }),
        makeFolder({
          id: "folder-extra",
          path: "D:\\extra",
          name: "Extra",
          workspace: false,
          enabled: true,
        }),
      ],
    };

    const result = buildAgentRuntimeConfig({
      typeKey: "claude",
      cwd: "D:\\notes\\first",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "low",
      instanceRuntimeConfig: {
        files: {
          workspace: undefined,
          folders: [],
          notebooks: [],
          _frozen: true,
        },
      },
    });

    expect(result.claude?.cwd).toBe("D:\\notes\\first");
  });

  it("prefers per-thread first folder when user has toggled per-thread folders", () => {
    // 用户已经按 thread 单独 toggled 过 checkbox ── 这种情况下 per-thread
    // 选择优先, 不要被 global workspace 抢过去。 跟"用户没主动调 thread"
    // 的场景是对称的。
    agentAccessMock.config = {
      version: 1,
      entries: [
        makeFolder({
          id: "folder-global",
          path: "D:\\global-workspace",
          name: "GlobalWS",
          workspace: true,
          enabled: true,
        }),
        makeFolder({
          id: "folder-perthread",
          path: "D:\\perthread-folder",
          name: "PerThread",
          workspace: false,
          enabled: true,
        }),
      ],
    };

    const result = buildAgentRuntimeConfig({
      typeKey: "claude",
      cwd: undefined,
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "low",
      instanceRuntimeConfig: {
        files: {
          workspace: undefined,
          folders: ["D:\\perthread-folder"],
          notebooks: [],
        },
      },
    });

    expect(result.claude?.cwd).toBe("D:\\perthread-folder");
  });

  it("uses per-thread workspace field when set, ignoring global", () => {
    // per-thread 显式设了 workspace 时, 必须以 per-thread 为准 ── 即便
    // global 上有另一个 workspace folder, 也不抢主空间。 这条守住老约定。
    agentAccessMock.config = {
      version: 1,
      entries: [
        makeFolder({
          id: "folder-global",
          path: "D:\\global-workspace",
          name: "GlobalWS",
          workspace: true,
          enabled: true,
        }),
        makeFolder({
          id: "folder-perthread",
          path: "D:\\perthread-workspace",
          name: "PerThreadWS",
          workspace: false,
          enabled: true,
        }),
      ],
    };

    const result = buildAgentRuntimeConfig({
      typeKey: "claude",
      cwd: undefined,
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "low",
      instanceRuntimeConfig: {
        files: {
          workspace: "D:\\perthread-workspace",
          folders: ["D:\\perthread-workspace"],
          notebooks: [],
        },
      },
    });

    expect(result.claude?.cwd).toBe("D:\\perthread-workspace");
  });

  it("workspacePaths stay empty when runtime files are explicitly empty", () => {
    agentAccessMock.config = {
      version: 1,
      entries: [
        makeFolder({ id: "f-1", path: "D:\\a", name: "A", workspace: true }),
        makeFolder({ id: "f-2", path: "D:\\b", name: "B" }),
      ],
    };

    const result = buildAgentRuntimeConfig({
      typeKey: "claude",
      cwd: undefined,
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "low",
      instanceRuntimeConfig: {
        files: {
          workspace: undefined,
          folders: [],
          notebooks: [],
        },
      },
    });

    expect(result.claude?.workspacePaths).toEqual([]);
  });

  it("flowix runtime uses per-thread files for cwd and workspacePaths", () => {
    agentAccessMock.config = {
      version: 1,
      entries: [
        makeFolder({
          id: "folder-global",
          path: "D:\\global-workspace",
          name: "GlobalWS",
          workspace: true,
          enabled: true,
        }),
      ],
    };

    const result = buildAgentRuntimeConfig({
      typeKey: "flowix",
      cwd: "D:\\notes\\first",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "low",
      instanceRuntimeConfig: {
        files: {
          workspace: "D:\\runtime-workspace",
          folders: ["D:\\runtime-workspace", "D:\\reference"],
          notebooks: ["D:\\notes"],
        },
      },
    });

    expect(result.flowix?.cwd).toBe("D:\\runtime-workspace");
    expect(result.flowix?.workspacePaths).toEqual([
      "D:\\runtime-workspace",
      "D:\\reference",
      "D:\\notes",
    ]);
  });

  it("flowix supports empty-card runtime settings for files", () => {
    expect(supportsAgentEmptySettings("flowix")).toBe(true);
  });

  it("exposes yolo on Codex and Claude access options", () => {
    expect(getAgentAccessOptions("codex").map((option) => option.id)).toContain(
      "yolo",
    );
    expect(getAgentAccessOptions("claude").map((option) => option.id)).toContain(
      "yolo",
    );
  });

  it("passes yolo through Codex runtime config normalization", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "codex",
      cwd: "/tmp/project",
      permissionMode: "yolo",
      codexModel: "inherit",
      codexReasoningEffort: "medium",
    });

    expect(normalizeCodexPermissionMode("yolo")).toBe("yolo");
    expect(result.codex?.permissionMode).toBe("yolo");
  });

  it("passes yolo through Claude runtime config", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "claude",
      cwd: "/tmp/project",
      permissionMode: "yolo",
      codexModel: "inherit",
      codexReasoningEffort: "medium",
    });

    expect(result.claude?.permissionMode).toBe("yolo");
  });
});
