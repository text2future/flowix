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

const conversationStateMock = vi.hoisted(() => ({
  instances: {} as Record<string, unknown>,
  messageStates: {} as Record<string, unknown>,
}));

vi.mock("@features/agent/store/agent-conversation-store", () => ({
  useAgentConversationStore: {
    getState: () => ({
      instances: conversationStateMock.instances,
      messageStates: conversationStateMock.messageStates,
    }),
    setState: (updater: unknown) => {
      // Tests 调用 setState({ instances: {...}, messageStates: {...} }) (object 形式)
      // 时把 partial 合并进 conversationStateMock。
      if (typeof updater === "object" && updater !== null) {
        const patch = updater as {
          instances?: Record<string, unknown>;
          messageStates?: Record<string, unknown>;
        };
        if (patch.instances) {
          // 把 patch.instances 为空的视为 reset ── beforeEach 必须真清空,
          // 否则上一次的 instance 会污染下一条 case.
          if (Object.keys(patch.instances).length === 0) {
            conversationStateMock.instances = {};
          } else {
          conversationStateMock.instances = {
            ...conversationStateMock.instances,
            ...patch.instances,
          };
          }
        }
        if (patch.messageStates) {
          if (Object.keys(patch.messageStates).length === 0) {
            conversationStateMock.messageStates = {};
          } else {
          conversationStateMock.messageStates = {
            ...conversationStateMock.messageStates,
            ...patch.messageStates,
          };
          }
        }
      }
    },
  },
  selectLatestFrozenFileSeed: () => {
    let best: { updatedAt: number; files: { workspace?: string; folders: string[]; notebooks: string[] } } | null = null;
    for (const id of Object.keys(conversationStateMock.instances)) {
      const inst = conversationStateMock.instances[id] as {
        runtimeConfig?: { files?: { _frozen?: boolean; workspace?: string; folders: string[]; notebooks: string[] } };
        updatedAt: number;
      };
      const files = inst?.runtimeConfig?.files;
      if (!files?._frozen) continue;
      if (best === null || inst.updatedAt > best.updatedAt) {
        best = { updatedAt: inst.updatedAt, files: files };
      }
    }
    if (!best) return null;
    return {
      workspace: best.files.workspace,
      folders: best.files.folders,
      notebooks: best.files.notebooks,
    };
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
describe("buildInitialInstanceRuntimeConfig — frozen seed flow", () => {
  beforeEach(() => {
    memoStateMock.selectedNotebook = null;
    accessStateMock.config = { version: 1, entries: [] };
    // 清空 conversation store (hydrated state 容易污染跨 describe block)
    useAgentConversationStore.setState({
      instances: {},
      messageStates: {},
    });
  });

  it("没冻结 instance 时, 走 selectedNotebook + agent-access 派生 (原行为)", async () => {
    memoStateMock.selectedNotebook = {
      id: "nb-1",
      path: "/Users/rop/Desktop/Notes/菜谱",
    };
    accessStateMock.config = {
      version: 1,
      entries: [
        {
          id: "f-1",
          kind: "folder",
          path: "/Users/rop/Desktop/folder-1",
          enabled: true,
          missing: false,
        },
        {
          id: "n-1",
          kind: "notebook",
          path: "/Users/rop/Desktop/Notes/学习笔记",
          enabled: true,
          missing: false,
        },
      ],
    };
    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig();
    expect(config.cwd).toBe("/Users/rop/Desktop/Notes/菜谱");
    expect(config.files?.workspace).toBe("/Users/rop/Desktop/Notes/菜谱");
    expect(config.files?.folders).toEqual(["/Users/rop/Desktop/folder-1"]);
    expect(config.files?.notebooks).toEqual(["/Users/rop/Desktop/Notes/学习笔记"]);
  });

  it("已有冻结 instance 的 workspace 时, 优先用冻结值而不是 selectedNotebook", async () => {
    useAgentConversationStore.setState({
      instances: {
        "inst-a": {
          instanceId: "inst-a",
          agentType: "codex",
          title: "A",
          threadId: "tid-a",
          runtimeConfig: {
            files: {
              workspace: "D:\\user-set",
              folders: [],
              notebooks: [],
              _frozen: true,
            },
          },
          source: { kind: "thread-card" },
          role: null,
          run: null,
          createdAt: 1,
          updatedAt: 100,
        },
      },
      messageStates: {},
    });

    memoStateMock.selectedNotebook = {
      id: "nb-1",
      path: "D:\\current-notebook",
    };
    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig();
    expect(config.cwd).toBe("D:\\user-set");
    expect(config.files?.workspace).toBe("D:\\user-set");
  });

  it("多个 instance 时, 取最近 updatedAt 的冻结 instance 作种子", async () => {
    useAgentConversationStore.setState({
      instances: {
        "inst-old": {
          instanceId: "inst-old",
          agentType: "codex",
          title: "old",
          threadId: "tid-old",
          runtimeConfig: {
            files: {
              workspace: "D:\\old-set",
              folders: [],
              notebooks: [],
              _frozen: true,
            },
          },
          source: { kind: "thread-card" },
          role: null,
          run: null,
          createdAt: 1,
          updatedAt: 50,
        },
        "inst-newer": {
          instanceId: "inst-newer",
          agentType: "codex",
          title: "newer",
          threadId: "tid-newer",
          runtimeConfig: {
            files: {
              workspace: "D:\\newer-set",
              folders: [],
              notebooks: [],
              _frozen: true,
            },
          },
          source: { kind: "thread-card" },
          role: null,
          run: null,
          createdAt: 1,
          updatedAt: 200,
        },
        "inst-not-frozen": {
          instanceId: "inst-not-frozen",
          agentType: "codex",
          title: "unfrozen",
          threadId: "tid-unfrozen",
          runtimeConfig: {
            files: {
              workspace: "D:\\never-frozen",
              folders: [],
              notebooks: [],
            },
          },
          source: { kind: "thread-card" },
          role: null,
          run: null,
          createdAt: 1,
          updatedAt: 1000,
        },
      },
      messageStates: {},
    });

    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig();
    expect(config.cwd).toBe("D:\\newer-set");
  });

  it("冻结种子的 folders 与全局 enabled folders 取并集去重", async () => {
    useAgentConversationStore.setState({
      instances: {
        "inst-a": {
          instanceId: "inst-a",
          agentType: "codex",
          title: "A",
          threadId: "tid-a",
          runtimeConfig: {
            files: {
              workspace: "D:\\x",
              folders: ["D:\\seed-only"],
              notebooks: ["D:\\seed-notebook"],
              _frozen: true,
            },
          },
          source: { kind: "thread-card" },
          role: null,
          run: null,
          createdAt: 1,
          updatedAt: 100,
        },
      },
      messageStates: {},
    });
    accessStateMock.config = {
      version: 1,
      entries: [
        {
          id: "f-1",
          kind: "folder",
          path: "D:\\seed-only",
          enabled: true,
          missing: false,
        },
        {
          id: "f-2",
          kind: "folder",
          path: "D:\\global-only",
          enabled: true,
          missing: false,
        },
        {
          id: "n-1",
          kind: "notebook",
          path: "D:\\global-notebook",
          enabled: true,
          missing: false,
        },
      ],
    };

    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig();
    expect(config.files?.folders).toEqual([
      "D:\\seed-only",
      "D:\\global-only",
    ]);
    expect(config.files?.notebooks).toEqual([
      "D:\\seed-notebook",
      "D:\\global-notebook",
    ]);
  });
});
describe("buildInitialInstanceRuntimeConfig — backfill 同源 (回归)", () => {
  beforeEach(() => {
    memoStateMock.selectedNotebook = null;
    accessStateMock.config = { version: 1, entries: [] };
    conversationStateMock.instances = {};
    conversationStateMock.messageStates = {};
  });

  it("backfill 调用与新建 instance 拿到相同的 seed - 与 selectLatestFrozenFileSeed 直接调用一致", async () => {
    // 设一个 frozen instance (workspace: D:\\frozen-set, folders: [D:\\seed-folder])
    conversationStateMock.instances = {
      "inst-frozen": {
        instanceId: "inst-frozen",
        agentType: "codex",
        title: "Frozen",
        threadId: "tid-frozen",
        runtimeConfig: {
          files: {
            workspace: "D:\\frozen-set",
            folders: ["D:\\seed-folder"],
            notebooks: [],
            _frozen: true,
          },
        },
        source: { kind: "thread-card" },
        role: null,
        run: null,
        createdAt: 1,
        updatedAt: 100,
      },
    };

    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    // 这条是 extension insertAgentThreadCard 与 view ensureInstanceBinding
    // 共用的"新建 instance" path ── 直接复用同一 helper.
    const config = buildInitialInstanceRuntimeConfig();

    expect(config.cwd).toBe("D:\\frozen-set");
    expect(config.files?.workspace).toBe("D:\\frozen-set");
    expect(config.files?.folders).toEqual(["D:\\seed-folder"]);
  });
});
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";
describe("buildInitialInstanceRuntimeConfig — extension.insertAgentThreadCard 等价路径", () => {
  beforeEach(() => {
    memoStateMock.selectedNotebook = null;
    accessStateMock.config = { version: 1, entries: [] };
    conversationStateMock.instances = {};
    conversationStateMock.messageStates = {};
  });

  it("worker 默认 cwd = 'D:\\user-pinned' 时, 新 instance 的 workspace 等于它", async () => {
    // 模拟 worker 已结过 workspace = D:\\user-pinned, 没修改 folders/notebooks
    conversationStateMock.instances = {
      "inst-a": {
        instanceId: "inst-a",
        agentType: "codex",
        title: "A",
        threadId: "tid-a",
        runtimeConfig: {
          files: {
            workspace: "D:\\user-pinned",
            folders: ["D:\\a-folder"],
            notebooks: ["D:\\a-notebook"],
            _frozen: true,
          },
        },
        source: { kind: "thread-card" },
        role: null,
        run: null,
        createdAt: 1,
        updatedAt: 200,
      },
    };

    // 同时 selectedNotebook 是某个别的值, 不能覆盖 frozen
    memoStateMock.selectedNotebook = {
      id: "nb-other",
      path: "D:\\another-notebook",
    };

    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");
    const config = buildInitialInstanceRuntimeConfig();

    expect(config.cwd).toBe("D:\\user-pinned");
    expect(config.files?.workspace).toBe("D:\\user-pinned");
    // folders/notebooks 取并集
    expect(config.files?.folders).toContain("D:\\a-folder");
    expect(config.files?.notebooks).toContain("D:\\a-notebook");
  });

  it("worker 未冻结, 走 selectedNotebook + 第一个 enabled folder", async () => {
    // selectedNotebook 已 hydrate, 是只读的「选中」语义来源
    memoStateMock.selectedNotebook = {
      id: "nb-1",
      path: "D:\\current",
    };
    accessStateMock.config = {
      version: 1,
      entries: [
        {
          id: "f-1",
          kind: "folder",
          path: "D:\\flowix",
          enabled: true,
          missing: false,
        },
      ],
    };

    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");
    const config = buildInitialInstanceRuntimeConfig();

    // 没冻结 → workspace 取 selectedNotebook
    expect(config.cwd).toBe("D:\\current");
    expect(config.files?.workspace).toBe("D:\\current");
    // folders 还是从 enabled 拿
    expect(config.files?.folders).toEqual(["D:\\flowix"]);
  });
});
