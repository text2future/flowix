import { beforeEach, describe, expect, it, vi } from "vitest";

const agentAccessMock = vi.hoisted(() => ({
  config: { version: 1, entries: [] as Array<Record<string, unknown>> },
  get: vi.fn(),
  set: vi.fn(),
  addFolderFromPicker: vi.fn(),
}));

vi.mock("@platform/tauri/client", () => ({
  agentAccess: {
    get: agentAccessMock.get,
    set: agentAccessMock.set,
    addFolderFromPicker: agentAccessMock.addFolderFromPicker,
  },
}));

type TestEntry = {
  id: string;
  kind: "folder" | "notebook";
  path: string;
  name: string;
  enabled: boolean;
  workspace: boolean;
  missing: boolean;
  addedAt: number;
  updatedAt: number;
};

function makeFolder(
  overrides: Partial<TestEntry> & { id: string; path: string },
): TestEntry {
  return {
    id: overrides.id,
    kind: "folder",
    path: overrides.path,
    name: overrides.name ?? overrides.path,
    enabled: overrides.enabled ?? true,
    workspace: overrides.workspace ?? false,
    missing: overrides.missing ?? false,
    addedAt: overrides.addedAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
  };
}

function entriesWithWorkspace(items: TestEntry[]): {
  version: 1;
  entries: TestEntry[];
} {
  return { version: 1, entries: items };
}

describe("agent-access-store workspace selection", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    agentAccessMock.config = { version: 1, entries: [] };
    agentAccessMock.get.mockImplementation(async () => agentAccessMock.config);
    agentAccessMock.set.mockImplementation(async (config) => {
      agentAccessMock.config = config;
    });
    agentAccessMock.addFolderFromPicker.mockImplementation(async () => null);
    const { useAgentAccessStore } =
      await import("@features/agent/store/agent-access-store");
    useAgentAccessStore.setState({
      config: { version: 1, entries: [] },
      isLoading: false,
    });
  });

  it("does NOT auto-promote a folder to workspace on initial load", async () => {
    // 新契约: workspace 完全由 setWorkspace 显式触发, loadInitial 不会把
    // 第一个 enabled folder 自动升为主空间。 磁盘原值原样落库。
    const { useAgentAccessStore } =
      await import("@features/agent/store/agent-access-store");
    agentAccessMock.config = entriesWithWorkspace([
      makeFolder({
        id: "folder-1",
        path: "D:\\projects\\first",
        name: "First",
      }),
      makeFolder({
        id: "folder-2",
        path: "D:\\projects\\second",
        name: "Second",
      }),
    ]);

    await useAgentAccessStore.getState().loadInitial();

    const entries = useAgentAccessStore.getState().config.entries;
    expect(entries.every((entry) => entry.workspace === false)).toBe(true);
  });

  it("setWorkspace is unique and forces the target folder to enabled", async () => {
    const { useAgentAccessStore } =
      await import("@features/agent/store/agent-access-store");
    useAgentAccessStore.setState({
      config: entriesWithWorkspace([
        makeFolder({
          id: "folder-1",
          path: "D:\\projects\\first",
          name: "First",
          enabled: true,
          workspace: false,
        }),
        makeFolder({
          id: "folder-2",
          path: "D:\\projects\\second",
          name: "Second",
          enabled: false,
          workspace: false,
        }),
      ]),
      isLoading: false,
    });

    // 目标 folder 当前是 enabled=false, setWorkspace 必须强制翻为 true,
    // 并把之前 workspace 标志清空 (要求 1: 唯一)。
    await useAgentAccessStore.getState().setWorkspace("folder-2");

    const entries = useAgentAccessStore.getState().config.entries;
    const workspaces = entries.filter((entry) => entry.workspace === true);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.id).toBe("folder-2");
    expect(entries.find((entry) => entry.id === "folder-2")?.enabled).toBe(true);
    expect(entries.find((entry) => entry.id === "folder-1")?.workspace).toBe(
      false,
    );
  });

  it("clearWorkspace removes the workspace marker from every entry", async () => {
    // 取消勾选最后一个 folder 时调用 ── 用户要求弹窗里不留任何 workspace
    // 样式。 这里直接验证 store 端: 多条 entry, 其中一条 workspace=true,
    // 调 clearWorkspace 后所有 entries 的 workspace 都变 false, enabled
    // 不动 (workspace 不再"绑架" enabled)。
    const { useAgentAccessStore } =
      await import("@features/agent/store/agent-access-store");
    useAgentAccessStore.setState({
      config: entriesWithWorkspace([
        makeFolder({
          id: "folder-1",
          path: "D:\\projects\\first",
          name: "First",
          enabled: true,
          workspace: true,
        }),
        makeFolder({
          id: "folder-2",
          path: "D:\\projects\\second",
          name: "Second",
          enabled: true,
          workspace: false,
        }),
      ]),
      isLoading: false,
    });

    await useAgentAccessStore.getState().clearWorkspace();

    const entries = useAgentAccessStore.getState().config.entries;
    expect(entries.every((entry) => entry.workspace === false)).toBe(true);
    // enabled 状态保留 ── workspace 不再"绑定" enabled, 清 workspace
    // 不该顺带把已勾选的 folder 也取消掉。
    expect(entries.find((entry) => entry.id === "folder-1")?.enabled).toBe(true);
    expect(entries.find((entry) => entry.id === "folder-2")?.enabled).toBe(true);
  });

  it("clearWorkspace is a no-op when no entry is marked as workspace", async () => {
    // 防御: 没人带 workspace 标志时调 clearWorkspace, 不写盘也不刷新
    // updatedAt, 保持 entries 引用稳定 ── 避免无意义的 store set 触发
    // 跨窗口事件。
    const { useAgentAccessStore } =
      await import("@features/agent/store/agent-access-store");
    useAgentAccessStore.setState({
      config: entriesWithWorkspace([
        makeFolder({
          id: "folder-1",
          path: "D:\\projects\\first",
          name: "First",
          enabled: true,
          workspace: false,
        }),
      ]),
      isLoading: false,
    });
    const before = useAgentAccessStore.getState().config;

    await useAgentAccessStore.getState().clearWorkspace();

    const after = useAgentAccessStore.getState().config;
    expect(after).toBe(before); // 引用未变 ── 早返路径没走 set
  });

  it("removeFolder on the workspace promotes the first remaining folder", async () => {
    // 需求 4: 撤销工作空间选中 (此处=删掉 workspace folder) 必须把 workspace
    // 重新指派给列表里第一个 enabled folder, 保持"workspace 唯一且有承载"。
    const { useAgentAccessStore } =
      await import("@features/agent/store/agent-access-store");
    useAgentAccessStore.setState({
      config: entriesWithWorkspace([
        makeFolder({
          id: "folder-1",
          path: "D:\\projects\\first",
          name: "First",
        }),
        makeFolder({
          id: "folder-2",
          path: "D:\\projects\\second",
          name: "Second",
          enabled: true,
          workspace: true,
        }),
      ]),
      isLoading: false,
    });

    await useAgentAccessStore.getState().removeFolder("folder-2");

    const entries = useAgentAccessStore.getState().config.entries;
    const workspaces = entries.filter((entry) => entry.workspace === true);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.id).toBe("folder-1");
    expect(workspaces[0]?.enabled).toBe(true);
    expect(entries.find((entry) => entry.id === "folder-2")).toBeUndefined();
  });

  it("removeFolder on the workspace with no remaining enabled folders leaves workspace empty", async () => {
    const { useAgentAccessStore } =
      await import("@features/agent/store/agent-access-store");
    useAgentAccessStore.setState({
      config: entriesWithWorkspace([
        makeFolder({
          id: "folder-only",
          path: "D:\\only",
          name: "Only",
          enabled: true,
          workspace: true,
        }),
      ]),
      isLoading: false,
    });

    await useAgentAccessStore.getState().removeFolder("folder-only");

    const entries = useAgentAccessStore.getState().config.entries;
    expect(entries).toHaveLength(0);
    expect(entries.some((entry) => entry.workspace === true)).toBe(false);
  });

  it("toggle off on the workspace reassigns workspace to the first remaining folder", async () => {
    // 需求 4 + 3 联合: 关闭 workspace folder 的勾选 = "撤销工作空间选中",
    // 此时不变量 (workspace ⇒ enabled) 被打破, 必须立刻把 workspace 重新
    // 指派给列表里第一个 enabled folder (folder-1 仍然是 enabled)。
    const { useAgentAccessStore } =
      await import("@features/agent/store/agent-access-store");
    useAgentAccessStore.setState({
      config: entriesWithWorkspace([
        makeFolder({
          id: "folder-1",
          path: "D:\\projects\\first",
          name: "First",
          enabled: true,
        }),
        makeFolder({
          id: "folder-2",
          path: "D:\\projects\\second",
          name: "Second",
          enabled: true,
          workspace: true,
        }),
      ]),
      isLoading: false,
    });

    await useAgentAccessStore.getState().toggle("folder-2");

    const entries = useAgentAccessStore.getState().config.entries;
    const workspaces = entries.filter((entry) => entry.workspace === true);
    expect(workspaces).toHaveLength(1);
    // folder-1 保持 enabled=true, 自动升为新 workspace;
    // folder-2 toggle 后 enabled=false, 不再带 workspace 标志。
    expect(workspaces[0]?.id).toBe("folder-1");
    expect(entries.find((entry) => entry.id === "folder-1")?.enabled).toBe(
      true,
    );
    expect(entries.find((entry) => entry.id === "folder-2")?.workspace).toBe(
      false,
    );
    expect(entries.find((entry) => entry.id === "folder-2")?.enabled).toBe(
      false,
    );
  });

  it("toggle off on the only workspace leaves workspace empty", async () => {
    const { useAgentAccessStore } =
      await import("@features/agent/store/agent-access-store");
    useAgentAccessStore.setState({
      config: entriesWithWorkspace([
        makeFolder({
          id: "folder-only",
          path: "D:\\only",
          name: "Only",
          enabled: true,
          workspace: true,
        }),
      ]),
      isLoading: false,
    });

    await useAgentAccessStore.getState().toggle("folder-only");

    const entries = useAgentAccessStore.getState().config.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.enabled).toBe(false);
    expect(entries.some((entry) => entry.workspace === true)).toBe(false);
  });

  it("toggle on a non-workspace folder does NOT auto-promote it to workspace", async () => {
    // 保持 toggle 与 workspace 解耦: 单纯勾选一个非 workspace folder,
    // 不会把它升为主空间, 避免"勾选就抢主空间"的副作用。 workspace 只
    // 走 setWorkspace 显式触发, 或被 workspace 槽位兜底逻辑接住。
    const { useAgentAccessStore } =
      await import("@features/agent/store/agent-access-store");
    useAgentAccessStore.setState({
      config: entriesWithWorkspace([
        makeFolder({
          id: "folder-1",
          path: "D:\\projects\\first",
          name: "First",
          enabled: true,
          workspace: true,
        }),
        makeFolder({
          id: "folder-2",
          path: "D:\\projects\\second",
          name: "Second",
          enabled: false,
        }),
      ]),
      isLoading: false,
    });

    await useAgentAccessStore.getState().toggle("folder-2");

    const entries = useAgentAccessStore.getState().config.entries;
    expect(entries.find((entry) => entry.id === "folder-2")?.enabled).toBe(
      true,
    );
    expect(entries.find((entry) => entry.id === "folder-2")?.workspace).toBe(
      false,
    );
    expect(entries.find((entry) => entry.id === "folder-1")?.workspace).toBe(
      true,
    );
  });

  it("addFolder keeps new folders as non-workspace even when no workspace exists", async () => {
    // 不再隐式 promote: 加文件夹不会"顺手"抢占空缺的 workspace 槽位, 用
    // 户必须显式触发 setWorkspace 才能指派。
    const { useAgentAccessStore } =
      await import("@features/agent/store/agent-access-store");
    useAgentAccessStore.setState({
      config: { version: 1, entries: [] },
      isLoading: false,
    });

    const result = await useAgentAccessStore
      .getState()
      .addFolder("D:\\projects\\new");
    expect(result.ok).toBe(true);

    const entries = useAgentAccessStore.getState().config.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.enabled).toBe(true);
    expect(entries[0]?.workspace).toBe(false);
  });
});