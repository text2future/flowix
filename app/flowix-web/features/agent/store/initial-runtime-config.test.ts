/**
 * 覆盖 "重启产品后, 已存在的 thread card resume 时 cwd 缺失" 这条修复路径.
 *
 * 关键不变量:
 *   buildInitialInstanceRuntimeConfig() 必返回:
 *     - cwd: 同步可读 selectedNotebook.path (即使 agent-access-store
 *       还在 EMPTY_CONFIG 状态 ── 启动 race 窗口内的真实场景)
 *     - files.notebooks / files.folders: 从 agentAccessStore.enabled
 *       entries 派生
 *
 * 这是 instance 创建瞬间的 snapshot; 老 instance 的 backfill 走同一份
 * helper 同步落 SQLite, 见 `agent-conversation-store.ts::backfillMissingRuntimeConfig`.
 *
 * 测试策略: 通过 `vi.mock` 把 store 切到 test 控制下 ── 避免 chat-store
 * / memo-store 引发的 tauri-side 副作用 (`listen` 等) 误打断测试。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// 用 vi.hoisted 让 mocks 在文件顶层 hoist 后注入 ── 这是 vitest 通用模式.
const memoStateMock = vi.hoisted(() => ({
  selectedNotebook: null as null | { id: string; path: string } | unknown,
}));

const accessStateMock = vi.hoisted(() => ({
  config: {
    version: 1,
    entries: [] as Array<{
      id: string;
      kind: "folder" | "notebook";
      path: string;
      enabled: boolean;
      missing: boolean;
    }>,
  },
}));

vi.mock("@features/memo/store/memo-store", () => ({
  useMemoStore: {
    getState: () => ({
      selectedNotebook: memoStateMock.selectedNotebook,
    }),
  },
}));

vi.mock("@features/agent/store/agent-access-store", () => ({
  useAgentAccessStore: {
    getState: () => ({
      config: accessStateMock.config,
    }),
  },
}));

type TestEntry = {
  id: string;
  kind: "folder" | "notebook";
  path: string;
  enabled: boolean;
  missing: boolean;
};

function makeEntry(
  overrides: Partial<TestEntry> & { id: string; kind: TestEntry["kind"]; path: string },
): TestEntry {
  return {
    enabled: true,
    missing: false,
    ...overrides,
  };
}

describe("buildInitialInstanceRuntimeConfig", () => {
  beforeEach(() => {
    memoStateMock.selectedNotebook = null;
    accessStateMock.config = { version: 1, entries: [] };
  });

  it("selectedNotebook 已 hydrate 时, 给出 cwd + 一致 cwd 顶层字段", async () => {
    memoStateMock.selectedNotebook = {
      id: "nb-1",
      path: "/Users/rop/Desktop/Notes/菜谱",
    };
    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig();

    expect(config.cwd).toBe("/Users/rop/Desktop/Notes/菜谱");
    expect(config.files?.workspace).toBe("/Users/rop/Desktop/Notes/菜谱");
    // selectedNotebook 没进 agent-access-store entries 时, files.notebooks
    // 不会自动 unshift, 但 files.workspace 仍是 cwd. 这是与
    // buildAgentRuntimeConfig 的设计一致 ── workspace 字段单独管主目录,
    // folders/notebooks 是用户主动加进 access 的 entries.
    expect(config.files?.notebooks).toEqual([]);
    expect(config.files?.folders).toEqual([]);
  });

  it("selectedNotebook 还没 hydrate (启动 race) 时, 不抛错而返回 cwd=undefined, files 空", async () => {
    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig();

    // 这是启动 race 窗口内的真实场景. helper 必须不抛错, 允许
    // 兜底链 (userPayload.systemReminderDirectory / Rust session cwd) 兜住.
    expect(config.cwd).toBeUndefined();
    expect(config.files?.workspace).toBeUndefined();
    expect(config.files?.notebooks).toEqual([]);
    expect(config.files?.folders).toEqual([]);
  });

  it("agent-access 已有 enabled entries 时, 派生到 folders / notebooks", async () => {
    accessStateMock.config = {
      version: 1,
      entries: [
        makeEntry({
          id: "f1",
          kind: "folder",
          path: "/Users/rop/Desktop/folder-a",
        }),
        makeEntry({
          id: "n1",
          kind: "notebook",
          path: "/Users/rop/Desktop/Notes",
        }),
        makeEntry({
          id: "f2",
          kind: "folder",
          path: "/Users/rop/Desktop/folder-a", // dedupe
        }),
        makeEntry({
          id: "missing",
          kind: "folder",
          path: "/Users/rop/Desktop/ghost",
          missing: true, // missing → skip
        }),
        makeEntry({
          id: "disabled",
          kind: "folder",
          path: "/Users/rop/Desktop/disabled",
          enabled: false, // disabled → skip
        }),
      ],
    };
    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig();

    expect(config.files?.folders).toEqual(["/Users/rop/Desktop/folder-a"]);
    expect(config.files?.notebooks).toEqual(["/Users/rop/Desktop/Notes"]);
  });

  it("normalizeWorkspacePath 处理尾部斜杠, 避免 cwd 拼接漂移", async () => {
    memoStateMock.selectedNotebook = {
      id: "nb-1",
      path: "/Users/rop/Desktop/misc/",
    };
    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig();

    expect(config.cwd).toBe("/Users/rop/Desktop/misc");
    expect(config.files?.workspace).toBe("/Users/rop/Desktop/misc");
  });
});
