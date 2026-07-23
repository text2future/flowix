import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAccessEntry } from "@/lib/types/agent-access";

const agentAccessMock = vi.hoisted(() => ({
  config: { version: 1, entries: [] as AgentAccessEntry[] },
  get: vi.fn(),
  set: vi.fn(),
  addFolderFromPicker: vi.fn(),
  addFolder: vi.fn(),
}));

const memoStoreMock = vi.hoisted(() => ({
  notebooks: [] as Array<{ id: string; icon?: string | null }>,
  loadNotebooks: vi.fn(),
  selectedNotebook: null as { id: string; path: string } | null,
}));

const conversationStoreMock = vi.hoisted(() => ({
  instances: {} as Record<
    string,
    { runtimeConfig?: { files?: { folders?: string[]; notebooks?: string[]; workspace?: string } } }
  >,
  setRuntimeConfig: vi.fn(),
}));

vi.mock("@platform/tauri/client", () => ({
  agentAccess: {
    get: agentAccessMock.get,
    set: agentAccessMock.set,
    addFolderFromPicker: agentAccessMock.addFolderFromPicker,
    addFolder: agentAccessMock.addFolder,
  },
}));

vi.mock("@features/memo", () => ({
  useMemoStore: {
    getState: () => memoStoreMock,
    subscribe: vi.fn(() => () => undefined),
  },
}));

vi.mock("@features/agent/store/agent-conversation-store", () => ({
  useAgentConversationStore: {
    getState: () => conversationStoreMock,
    subscribe: vi.fn(() => () => undefined),
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

const t = (key: string): string => key;

describe("AccessPopoverController handleClick delegation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    agentAccessMock.config = {
      version: 1,
      entries: [
        makeFolder({
          id: "folder-1",
          path: "D:\\first",
          name: "First",
        }),
        makeFolder({
          id: "folder-2",
          path: "D:\\second",
          name: "Second",
        }),
      ],
    };
    agentAccessMock.get.mockImplementation(async () => agentAccessMock.config);
    agentAccessMock.set.mockImplementation(async (config) => {
      agentAccessMock.config = config;
    });
    agentAccessMock.addFolderFromPicker.mockImplementation(async () => null);
    memoStoreMock.notebooks = [];
    memoStoreMock.loadNotebooks.mockResolvedValue(undefined);
    conversationStoreMock.instances = {};
    conversationStoreMock.setRuntimeConfig.mockClear();
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("clicking the avatar calls useAgentAccessStore.setWorkspace", async () => {
    // 关键回归 ── 直接派发 click 给 avatar (folder 图标本身), 断言 store.setWorkspace 被调用。
    // 这条覆盖整个 delegation 链路: button click → popover handleClick →
    // resolveAccessAction → store.setWorkspace。
    const { AccessPopoverController } = await import(
      "@features/editor/extensions/agent-thread-card/access/access-popover-controller"
    );
    const { useAgentAccessStore } = await import(
      "@features/agent/store/agent-access-store"
    );
    useAgentAccessStore.setState({
      config: { version: 1, entries: agentAccessMock.config.entries },
      isLoading: false,
    });

    const button = document.createElement("button");
    button.type = "button";
    const popover = document.createElement("div");
    popover.className = "agent-thread-card__access-popover";
    popover.hidden = true;
    document.body.append(popover);

    const controller = new AccessPopoverController({
      button,
      popover,
      t: t as never,
      isDestroyed: () => false,
      isInsideRelatedTarget: () => false,
      consumeOutsidePointer: () => {},
    });
    controller.setOpen(true);

    // 找到 popover 里的 set-workspace avatar ── setOpen(true) → render() 触发。
    const setBtn = popover.querySelector<HTMLButtonElement>(
      ".agent-thread-card__access-avatar--set-workspace",
    );
    expect(setBtn).not.toBeNull();
    expect(setBtn?.dataset.action).toBe("set-workspace");
    expect(setBtn?.dataset.entryId).toBe("folder-1");

    // 派发真实 click。
    setBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // 等待 microtask flush ── setWorkspace 是 async, 同步部分已 set 完。
    await Promise.resolve();
    await Promise.resolve();

    // store.setWorkspace 必须被调到。 mock 写到 agentAccessMock.config,
    // 校验 workspace 标志被翻到 folder-1 上。
    const written = useAgentAccessStore.getState().config;
    const folder1 = written.entries.find((e) => e.id === "folder-1");
    expect(folder1?.workspace).toBe(true);
    const folder2 = written.entries.find((e) => e.id === "folder-2");
    expect(folder2?.workspace).toBe(false);

    controller.dispose();
  });

  it("set-workspace on an unchecked per-thread entry selects it and pins the per-thread workspace path", async () => {
    // 细节回归 ── 在 thread 上下文里点一个"未勾选" entry 的 avatar 设主空间,
    // 必须同时: (1) 把它勾选进 per-thread folders/notebooks (checkbox 一致);
    // (2) 把 per-thread workspace (instanceFiles.workspace) 指向它的 path, 让
    // cascade 把 cwd 显式落到它。 否则会出现 "三角亮了但 checkbox 没勾 /
    // cwd 没落到它" 的不一致。
    conversationStoreMock.instances = {
      "instance-1": {
        runtimeConfig: {
          files: {
            workspace: undefined,
            folders: ["D:\\first"],
            notebooks: [],
          },
        },
      },
    };
    agentAccessMock.config = {
      version: 1,
      entries: [
        makeFolder({ id: "folder-1", path: "D:\\first", workspace: false }),
        makeFolder({ id: "folder-2", path: "D:\\second", workspace: false }),
      ],
    };

    const { AccessPopoverController } = await import(
      "@features/editor/extensions/agent-thread-card/access/access-popover-controller"
    );
    const { useAgentAccessStore } = await import(
      "@features/agent/store/agent-access-store"
    );
    useAgentAccessStore.setState({
      config: { version: 1, entries: agentAccessMock.config.entries },
      isLoading: false,
    });

    const button = document.createElement("button");
    const popover = document.createElement("div");
    popover.className = "agent-thread-card__access-popover";
    popover.hidden = true;
    document.body.append(popover);

    const controller = new AccessPopoverController({
      button,
      popover,
      t: t as never,
      isDestroyed: () => false,
      isInsideRelatedTarget: () => false,
      consumeOutsidePointer: () => {},
      getInstanceId: () => "instance-1",
    });
    controller.setOpen(true);

    conversationStoreMock.setRuntimeConfig.mockClear();
    // folder-2 在 per-thread folders 里没有 (未勾选), 点它的 avatar 设主空间。
    const avatar = popover.querySelector<HTMLButtonElement>(
      '[data-entry-id="folder-2"] .agent-thread-card__access-avatar--set-workspace',
    )!;
    avatar.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    // folder-2 被勾选进 per-thread folders, 且 per-thread workspace 指向它。
    expect(conversationStoreMock.setRuntimeConfig).toHaveBeenCalledWith(
      "instance-1",
      {
        files: {
          workspace: "D:\\second",
          folders: ["D:\\first", "D:\\second"],
          notebooks: [],
        },
      },
    );

    // 全局 flag 也落到 folder-2 (三角蒙块出现)。
    const folder2 = useAgentAccessStore
      .getState()
      .config.entries.find((e) => e.id === "folder-2");
    expect(folder2?.workspace).toBe(true);

    controller.dispose();
  });

  it("preserves scroll position across a set-workspace re-render", async () => {
    // 回归 ── render() 用 replaceChildren 重建 scrollWrap, 旧实现新容器
    // scrollTop=0, 点 avatar 设主空间触发重渲后列表甩回顶部。 修复后 render
    // 先记下旧 scrollTop 再还原, 应保持不动。
    agentAccessMock.config = {
      version: 1,
      entries: [
        makeFolder({ id: "folder-1", path: "D:\\first", workspace: true }),
        makeFolder({ id: "folder-2", path: "D:\\second", workspace: false }),
      ],
    };
    const { AccessPopoverController } = await import(
      "@features/editor/extensions/agent-thread-card/access/access-popover-controller"
    );
    const { useAgentAccessStore } = await import(
      "@features/agent/store/agent-access-store"
    );
    useAgentAccessStore.setState({
      config: { version: 1, entries: agentAccessMock.config.entries },
      isLoading: false,
    });

    const button = document.createElement("button");
    const popover = document.createElement("div");
    popover.className = "agent-thread-card__access-popover";
    popover.hidden = true;
    document.body.append(popover);

    const controller = new AccessPopoverController({
      button,
      popover,
      t: t as never,
      isDestroyed: () => false,
      isInsideRelatedTarget: () => false,
      consumeOutsidePointer: () => {},
    });
    controller.setOpen(true);

    // 模拟用户滚动 (jsdom 不做布局, scrollTop 是普通可读写属性)。
    const scrollWrap = popover.querySelector<HTMLDivElement>(
      ".agent-thread-card__access-popover-scroll",
    )!;
    scrollWrap.scrollTop = 60;
    expect(scrollWrap.scrollTop).toBe(60);

    // 点 folder-2 的 avatar 设主空间 -> access store 变化 -> render() 重渲。
    const avatar = popover.querySelector<HTMLButtonElement>(
      '[data-entry-id="folder-2"] .agent-thread-card__access-avatar--set-workspace',
    )!;
    avatar.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    // scrollWrap 复用 (同一个元素, 内联 maxHeight / scrollTop 都留着), 没重建。
    const scrollWrapAfter = popover.querySelector<HTMLDivElement>(
      ".agent-thread-card__access-popover-scroll",
    )!;
    expect(scrollWrapAfter).toBe(scrollWrap);
    expect(scrollWrapAfter.scrollTop).toBe(60);

    controller.dispose();
  });

  it("clicking the checkbox toggles the entry in the conversation store", async () => {
    const { AccessPopoverController } = await import(
      "@features/editor/extensions/agent-thread-card/access/access-popover-controller"
    );
    const { useAgentAccessStore } = await import(
      "@features/agent/store/agent-access-store"
    );
    useAgentAccessStore.setState({
      config: { version: 1, entries: agentAccessMock.config.entries },
      isLoading: false,
    });

    const button = document.createElement("button");
    const popover = document.createElement("div");
    popover.className = "agent-thread-card__access-popover";
    popover.hidden = true;
    document.body.append(popover);

    const controller = new AccessPopoverController({
      button,
      popover,
      t: t as never,
      isDestroyed: () => false,
      isInsideRelatedTarget: () => false,
      consumeOutsidePointer: () => {},
      getInstanceId: () => undefined, // fallback to global store
    });
    controller.setOpen(true);

    const checkbox = popover.querySelector<HTMLButtonElement>(
      ".agent-thread-card__access-checkbox",
    );
    expect(checkbox?.dataset.action).toBe("toggle");

    checkbox!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();

    const written = useAgentAccessStore.getState().config;
    // 原 enabled=true, toggle 后应变 false。
    const folder1 = written.entries.find((e) => e.id === "folder-1");
    expect(folder1?.enabled).toBe(false);
    // 关键 UX 回归 ── 切换 checkbox 不应该顺手把弹窗关掉: 用户经常连续
    // 勾多个 folder, 一勾一个关一次是无法用的。 这里断言 popover.isOpen
    // 在 toggle 之后仍然为 true。
    expect(controller.isOpen).toBe(true);

    controller.dispose();
  });

  it("toggling the checkbox does not close the popover (full pointerdown + click flow)", async () => {
    // 完整还原生产路径 ── handleOutsidePointer 挂在 document 捕获阶段,
    // 因此哪怕按钮自身 listener 拦 stopPropagation, document 监听依然会先跑。
    // 这里断言: 即使跑完整 pointerdown → mouseup → click 序列, popover
    // 仍然开着。
    const { AccessPopoverController } = await import(
      "@features/editor/extensions/agent-thread-card/access/access-popover-controller"
    );
    const { useAgentAccessStore } = await import(
      "@features/agent/store/agent-access-store"
    );
    useAgentAccessStore.setState({
      config: { version: 1, entries: agentAccessMock.config.entries },
      isLoading: false,
    });

    const button = document.createElement("button");
    const popover = document.createElement("div");
    popover.className = "agent-thread-card__access-popover";
    popover.hidden = true;
    document.body.append(popover);

    const controller = new AccessPopoverController({
      button,
      popover,
      t: t as never,
      isDestroyed: () => false,
      isInsideRelatedTarget: () => false,
      consumeOutsidePointer: () => {},
      getInstanceId: () => undefined,
    });
    controller.setOpen(true);

    const checkbox = popover.querySelector<HTMLButtonElement>(
      ".agent-thread-card__access-checkbox",
    )!;
    checkbox.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
      }),
    );
    checkbox.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    checkbox.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
    );
    checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.isOpen).toBe(true);
    // toggle 实际派发了 ── 跑完整个事件链仍生效, 不是靠 popover 还开着
    // 凑出来的伪绿。
    const written = useAgentAccessStore.getState().config;
    expect(written.entries.find((e) => e.id === "folder-1")?.enabled).toBe(
      false,
    );

    controller.dispose();
  });

  it("clicking the row name area does NOT trigger toggle or any state change", async () => {
    // 关键 UX 回归 ── row 的 name / avatar 默认区不再回退到 toggle, 必须
    // 显式点 checkbox / avatar / remove。 这里点 name-wrap, 断言 store 没
    // 任何变化、且 popover 没被重渲 (子节点引用应保持)。
    const { AccessPopoverController } = await import(
      "@features/editor/extensions/agent-thread-card/access/access-popover-controller"
    );
    const { useAgentAccessStore } = await import(
      "@features/agent/store/agent-access-store"
    );
    useAgentAccessStore.setState({
      config: {
        version: 1,
        entries: [makeFolder({ id: "folder-1" })],
      },
      isLoading: false,
    });

    const button = document.createElement("button");
    const popover = document.createElement("div");
    popover.className = "agent-thread-card__access-popover";
    popover.hidden = true;
    document.body.append(popover);

    const controller = new AccessPopoverController({
      button,
      popover,
      t: t as never,
      isDestroyed: () => false,
      isInsideRelatedTarget: () => false,
      consumeOutsidePointer: () => {},
    });
    controller.setOpen(true);

    // 拿一个 row 子节点引用, 后面比 ── 如果 row 被 replaceChildren,
    // 引用就变, 我们就能检测到"无意义的重渲"。
    const rowBefore = popover.querySelector(
      '[data-entry-id="folder-1"]',
    ) as HTMLElement;

    const nameWrap = popover.querySelector<HTMLElement>(
      '[data-entry-id="folder-1"] .agent-thread-card__access-name-wrap',
    )!;
    nameWrap.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();

    // store 不变 (folder-1.enabled 仍是 true)。
    const written = useAgentAccessStore.getState().config;
    expect(written.entries[0]?.enabled).toBe(true);

    // row 引用保持 ── 没有重渲。
    const rowAfter = popover.querySelector(
      '[data-entry-id="folder-1"]',
    ) as HTMLElement;
    expect(rowAfter).toBe(rowBefore);

    // 弹窗仍然打开。
    expect(controller.isOpen).toBe(true);

    controller.dispose();
  });

  it("popover re-renders to show workspace mark after avatar click", async () => {
    // 关键 UX 回归 ── 点击 avatar 后, popover 必须重渲: 原 workspace folder
    // 失去三角蒙块, 新选中的 folder 拿到三角蒙块。 这条覆盖了"setWorkspace 触发
    // store 变化 → 订阅触发 → controller.render() → DOM 更新" 的全链路。
    const { AccessPopoverController } = await import(
      "@features/editor/extensions/agent-thread-card/access/access-popover-controller"
    );
    const { useAgentAccessStore } = await import(
      "@features/agent/store/agent-access-store"
    );
    useAgentAccessStore.setState({
      config: {
        version: 1,
        entries: [
          makeFolder({
            id: "folder-1",
            workspace: true,
          }),
          makeFolder({
            id: "folder-2",
            workspace: false,
          }),
        ],
      },
      isLoading: false,
    });

    const button = document.createElement("button");
    const popover = document.createElement("div");
    popover.className = "agent-thread-card__access-popover";
    popover.hidden = true;
    document.body.append(popover);

    const controller = new AccessPopoverController({
      button,
      popover,
      t: t as never,
      isDestroyed: () => false,
      isInsideRelatedTarget: () => false,
      consumeOutsidePointer: () => {},
    });
    controller.setOpen(true);

    // 初始状态: folder-1 是 workspace (folder + 三角蒙块, 没有 set-workspace avatar),
    // folder-2 是普通 folder (有 set-workspace avatar)。
    // 控制器构造时已订阅 useAgentAccessStore, store 变化会自动重渲 ──
    // 不再需要测试手动接 subscription。
    expect(
      popover.querySelector('[data-entry-id="folder-1"] .agent-thread-card__access-avatar--workspace'),
    ).not.toBeNull();
    expect(
      popover.querySelector('[data-entry-id="folder-2"] .agent-thread-card__access-avatar--set-workspace'),
    ).not.toBeNull();

    // 点 folder-2 的 avatar。
    const setBtn2 = popover.querySelector<HTMLButtonElement>(
      '[data-entry-id="folder-2"] .agent-thread-card__access-avatar--set-workspace',
    )!;
    setBtn2.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // 现在 folder-2 应该是 workspace, folder-1 应该回到普通 folder。
    expect(
      popover.querySelector('[data-entry-id="folder-2"] .agent-thread-card__access-avatar--workspace'),
    ).not.toBeNull();
    expect(
      popover.querySelector('[data-entry-id="folder-1"] .agent-thread-card__access-avatar--workspace'),
    ).toBeNull();
    // folder-1 现在有 set-workspace avatar了 (folder-2 不再有)。
    expect(
      popover.querySelector('[data-entry-id="folder-1"] .agent-thread-card__access-avatar--set-workspace'),
    ).not.toBeNull();
    expect(
      popover.querySelector('[data-entry-id="folder-2"] .agent-thread-card__access-avatar--set-workspace'),
    ).toBeNull();

    controller.dispose();
  });

  it("unchecking the workspace folder reassigns workspace to the next checked folder", async () => {
    // 用户要求: 取消勾选的是工作空间文件夹, 工作空间要重置为"选中的第一个"。
    // 这里 workspace=folder-1, 取消勾选后 per-thread 还剩 folder-2 勾选,
    // 期待新 workspace = folder-2。
    conversationStoreMock.instances = {
      "instance-1": {
        runtimeConfig: {
          files: {
            folders: ["D:\\first", "D:\\second"],
            notebooks: [],
          },
        },
      },
    };
    agentAccessMock.config = {
      version: 1,
      entries: [
        makeFolder({
          id: "folder-1",
          path: "D:\\first",
          workspace: true,
        }),
        makeFolder({
          id: "folder-2",
          path: "D:\\second",
        }),
      ],
    };
    agentAccessMock.set.mockClear();
    agentAccessMock.set.mockImplementation(async (config) => {
      agentAccessMock.config = config;
    });

    const { AccessPopoverController } = await import(
      "@features/editor/extensions/agent-thread-card/access/access-popover-controller"
    );
    const { useAgentAccessStore } = await import(
      "@features/agent/store/agent-access-store"
    );
    useAgentAccessStore.setState({
      config: { version: 1, entries: agentAccessMock.config.entries },
      isLoading: false,
    });

    const button = document.createElement("button");
    const popover = document.createElement("div");
    popover.className = "agent-thread-card__access-popover";
    popover.hidden = true;
    document.body.append(popover);

    const controller = new AccessPopoverController({
      button,
      popover,
      t: t as never,
      isDestroyed: () => false,
      isInsideRelatedTarget: () => false,
      consumeOutsidePointer: () => {},
      getInstanceId: () => "instance-1",
    });
    controller.setOpen(true);

    const folder1Checkbox = popover.querySelector<HTMLButtonElement>(
      '[data-entry-id="folder-1"].agent-thread-card__access-checkbox, [data-entry-id="folder-1"] .agent-thread-card__access-checkbox',
    );
    // fallback: 用 row 的 checkbox query selector
    const checkboxes = popover.querySelectorAll<HTMLButtonElement>(
      '.agent-thread-card__access-checkbox',
    );
    const folder1 =
      folder1Checkbox ?? checkboxes[0]!;

    folder1.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    // 期待: workspace 标志从 folder-1 转到 folder-2 ── "选中的第一个"。
    const finalConfig = useAgentAccessStore.getState().config;
    expect(finalConfig.entries[0]?.workspace).toBe(false);
    expect(finalConfig.entries[1]?.workspace).toBe(true);

    controller.dispose();
  });

  it("unchecking the workspace with no remaining folders clears all workspace markers", async () => {
    // 用户需求: 没有选中的文件夹时, 弹窗里不能留下任何带 workspace 样式的
    // folder ── 不能用"自动 addFolder 当前笔记本路径"造一个隐性 workspace。
    // cwd 兜底交给 agent-runtime-spec cascade (由 systemReminderDirectory
    // = 当前 notebook 路径注入), 不在 UI 层造虚拟 workspace。
    conversationStoreMock.instances = {
      "instance-1": {
        runtimeConfig: {
          files: {
            folders: ["D:\\first"],
            notebooks: [],
          },
        },
      },
    };
    agentAccessMock.config = {
      version: 1,
      entries: [
        makeFolder({
          id: "folder-1",
          path: "D:\\first",
          workspace: true,
        }),
      ],
    };
    memoStoreMock.selectedNotebook = {
      id: "nb-1",
      path: "D:\\current-notebook",
    };
    agentAccessMock.set.mockClear();
    agentAccessMock.set.mockImplementation(async (config) => {
      agentAccessMock.config = config;
    });
    agentAccessMock.addFolder.mockClear();

    const { AccessPopoverController } = await import(
      "@features/editor/extensions/agent-thread-card/access/access-popover-controller"
    );
    const { useAgentAccessStore } = await import(
      "@features/agent/store/agent-access-store"
    );
    useAgentAccessStore.setState({
      config: { version: 1, entries: agentAccessMock.config.entries },
      isLoading: false,
    });

    const button = document.createElement("button");
    const popover = document.createElement("div");
    popover.className = "agent-thread-card__access-popover";
    popover.hidden = true;
    document.body.append(popover);

    const controller = new AccessPopoverController({
      button,
      popover,
      t: t as never,
      isDestroyed: () => false,
      isInsideRelatedTarget: () => false,
      consumeOutsidePointer: () => {},
      getInstanceId: () => "instance-1",
    });
    controller.setOpen(true);

    const checkboxes = popover.querySelectorAll<HTMLButtonElement>(
      '.agent-thread-card__access-checkbox',
    );
    checkboxes[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 期待: 所有 entries 的 workspace 标志都被清掉, 没人带 workspace 样式;
    // addFolder 也没被调到 ── 兜底不需要新增 entry, 直接走 cwd 那条路。
    expect(agentAccessMock.addFolder).not.toHaveBeenCalled();
    const finalConfig = useAgentAccessStore.getState().config;
    expect(finalConfig.entries.every((e) => e.workspace !== true)).toBe(true);
    // 老 workspace folder-1 还存在, 只是 workspace 标志位被清掉 ── 用户
    // 重新勾选它时再走 setWorkspace 路径才能恢复 workspace 标记。
    const folder1 = finalConfig.entries.find((e) => e.id === "folder-1");
    expect(folder1).toBeDefined();
    expect(folder1?.workspace).toBe(false);

    controller.dispose();
  });

  it("places the add-folder button right after the folder section, before notebook section", async () => {
    // 回归 ── "添加文件夹"按钮应当紧贴 folder 列表末尾, 让用户扫完
    // folder section 就能续上"加一个", 再去翻 notebook section。 早期版本
    // 把按钮放在最末端, 用户必须先翻完 notebook 才看到全局动作 ── 与
    // folder 语义割裂。
    const { AccessPopoverController } = await import(
      "@features/editor/extensions/agent-thread-card/access/access-popover-controller"
    );
    const { useAgentAccessStore } = await import(
      "@features/agent/store/agent-access-store"
    );
    useAgentAccessStore.setState({
      config: {
        version: 1,
        entries: [
          makeFolder({ id: "folder-1", path: "D:\\1" }),
          makeFolder({ id: "folder-2", path: "D:\\2" }),
        ],
      },
      isLoading: false,
    });

    const button = document.createElement("button");
    const popover = document.createElement("div");
    popover.className = "agent-thread-card__access-popover";
    popover.hidden = true;
    document.body.append(popover);

    const controller = new AccessPopoverController({
      button,
      popover,
      t: t as never,
      isDestroyed: () => false,
      isInsideRelatedTarget: () => false,
      consumeOutsidePointer: () => {},
    });
    controller.setOpen(true);

    // 收集 scrollWrap 直接子节点的 tagName 序列 ── 验证"folder section →
    // footerWrap → divider (此用例没 notebook 所以不会真出现) → ..." 的
    // 顺序, 而不是把 footerWrap 拖到末尾。
    const scrollWrap = popover.querySelector(
      ".agent-thread-card__access-popover-scroll",
    )!;
    const childTags = Array.from(scrollWrap.children).map(
      (child) =>
        child.tagName +
        (child.className ? `.${child.className.split(" ")[0]}` : ""),
    );
    const footerIndex = childTags.findIndex((t) =>
      t.includes("access-popover-footer"),
    );
    expect(footerIndex).toBeGreaterThan(0);
    // footer 之前的最后一个节点必须是 folder row ── 也就是说 footer 紧贴
    // folder 列表, 而不是被 notebook section 隔开。
    expect(childTags[footerIndex - 1]).toMatch(/access-row/);

    controller.dispose();
  });

  it("automatically selects a newly added folder for the current thread", async () => {
    conversationStoreMock.instances = {
      "instance-1": {
        runtimeConfig: {
          files: {
            workspace: "D:\\first",
            folders: ["D:\\first"],
            notebooks: ["D:\\notes"],
          },
        },
      },
    };
    const addedFolder = makeFolder({
      id: "folder-added",
      path: "D:\\new-project",
      name: "New project",
    });
    agentAccessMock.addFolderFromPicker.mockImplementation(async () => {
      agentAccessMock.config = {
        ...agentAccessMock.config,
        entries: [...agentAccessMock.config.entries, addedFolder],
      };
      return addedFolder;
    });

    const { AccessPopoverController } = await import(
      "@features/editor/extensions/agent-thread-card/access/access-popover-controller"
    );
    const { useAgentAccessStore } = await import(
      "@features/agent/store/agent-access-store"
    );
    useAgentAccessStore.setState({
      config: { version: 1, entries: agentAccessMock.config.entries },
      isLoading: false,
    });

    const button = document.createElement("button");
    const popover = document.createElement("div");
    popover.className = "agent-thread-card__access-popover";
    popover.hidden = true;
    document.body.append(popover);

    const controller = new AccessPopoverController({
      button,
      popover,
      t: t as never,
      isDestroyed: () => false,
      isInsideRelatedTarget: () => false,
      consumeOutsidePointer: () => {},
      getInstanceId: () => "instance-1",
    });
    controller.setOpen(true);

    popover
      .querySelector<HTMLButtonElement>(".agent-thread-card__access-add")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(conversationStoreMock.setRuntimeConfig).toHaveBeenCalledWith(
        "instance-1",
        {
          files: {
            workspace: "D:\\first",
            folders: ["D:\\first", "D:\\new-project"],
            notebooks: ["D:\\notes"],
          },
        },
      );
    });

    controller.dispose();
  });

  it("opens below by default and keeps 26px clear of the viewport bottom", async () => {
    const { AccessPopoverController } = await import(
      "@features/editor/extensions/agent-thread-card/access/access-popover-controller"
    );
    const { useAgentAccessStore } = await import(
      "@features/agent/store/agent-access-store"
    );
    useAgentAccessStore.setState({
      config: { version: 1, entries: agentAccessMock.config.entries },
      isLoading: false,
    });

    vi.spyOn(window, "innerWidth", "get").mockReturnValue(800);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);

    const button = document.createElement("button");
    const popover = document.createElement("div");
    popover.className = "agent-thread-card__access-popover";
    popover.hidden = true;
    document.body.append(button, popover);
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
      new DOMRect(500, 280, 100, 20),
    );
    vi.spyOn(popover, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 208, 320),
    );

    const controller = new AccessPopoverController({
      button,
      popover,
      t: t as never,
      isDestroyed: () => false,
      isInsideRelatedTarget: () => false,
      consumeOutsidePointer: () => {},
    });
    controller.setOpen(true);
    const scrollWrap = popover.querySelector<HTMLDivElement>(
      ".agent-thread-card__access-popover-scroll",
    )!;
    vi.spyOn(scrollWrap, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 208, 308),
    );
    (
      controller as unknown as { positionPopover: () => void }
    ).positionPopover();

    expect(scrollWrap.style.maxHeight).toBe("260px");
    expect(popover.style.top).toBe("302px");
    expect(600 - (Number.parseFloat(popover.style.top) + 272)).toBe(26);

    controller.dispose();
  });

  it("opens above when the usable space below is under 192px and above has more room", async () => {
    const { AccessPopoverController } = await import(
      "@features/editor/extensions/agent-thread-card/access/access-popover-controller"
    );
    const { useAgentAccessStore } = await import(
      "@features/agent/store/agent-access-store"
    );
    useAgentAccessStore.setState({
      config: { version: 1, entries: agentAccessMock.config.entries },
      isLoading: false,
    });

    vi.spyOn(window, "innerWidth", "get").mockReturnValue(800);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);

    const button = document.createElement("button");
    const popover = document.createElement("div");
    popover.className = "agent-thread-card__access-popover";
    popover.hidden = true;
    document.body.append(button, popover);
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
      new DOMRect(500, 361, 100, 20),
    );
    vi.spyOn(popover, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 208, 320),
    );

    const controller = new AccessPopoverController({
      button,
      popover,
      t: t as never,
      isDestroyed: () => false,
      isInsideRelatedTarget: () => false,
      consumeOutsidePointer: () => {},
    });
    controller.setOpen(true);
    (
      controller as unknown as { positionPopover: () => void }
    ).positionPopover();

    expect(popover.style.top).toBe("26px");

    controller.dispose();
  });

  it("keeps the popover open when its anchor element is disconnected mid-flight", async () => {
    // 回归 ── anchor (external settings 的 files 按钮) 在 toggle checkbox
    // 触发的 renderThreadState -> renderEmptyState 路径里被 body.replaceChildren
    // 重建, 旧 anchor disconnected。 旧版 positionPopover 检测到
    // `!anchor.isConnected` 就 setOpen(false) 关弹窗, 违反"切换勾选不关闭
    // 弹窗"的 UX 契约。 修正后: anchor 失联时保持 popover 上次位置, 不关。
    const { AccessPopoverController } = await import(
      "@features/editor/extensions/agent-thread-card/access/access-popover-controller"
    );
    const { useAgentAccessStore } = await import(
      "@features/agent/store/agent-access-store"
    );
    useAgentAccessStore.setState({
      config: { version: 1, entries: agentAccessMock.config.entries },
      isLoading: false,
    });

    const triggerButton = document.createElement("button");
    const popover = document.createElement("div");
    popover.className = "agent-thread-card__access-popover";
    popover.hidden = true;
    document.body.append(popover);

    // anchor 是一个独立的 files-button (模拟 external settings 的 files
    // control), 与 popover 一样挂在 body 上。
    const filesAnchor = document.createElement("button");
    document.body.append(filesAnchor);

    const controller = new AccessPopoverController({
      button: triggerButton,
      popover,
      t: t as never,
      isDestroyed: () => false,
      isInsideRelatedTarget: () => false,
      consumeOutsidePointer: () => {},
    });
    controller.setOpen(true, filesAnchor);
    expect(controller.isOpen).toBe(true);

    // 模拟 renderEmptyState 重建 files-button: 旧 anchor 从 DOM 移除。
    filesAnchor.remove();
    expect(filesAnchor.isConnected).toBe(false);

    // 直接调 positionPopover (rAF 回调里跑的同一段逻辑) ── 旧版会在这里
    // 因 `!anchor.isConnected` 触发 setOpen(false)。
    (
      controller as unknown as { positionPopover: () => void }
    ).positionPopover();

    expect(controller.isOpen).toBe(true); // anchor 失联不关弹窗
    // popover 仍在 DOM 里 (只是 anchor 失联, popover 自身没被移除)。
    expect(popover.isConnected).toBe(true);

    controller.dispose();
  });

  it("closes the popover when the popover element itself is disconnected", async () => {
    // 对照测试 ── popover 自身被移除 (NodeView 销毁等) 时, positionPopover
    // 仍然要关弹窗, 否则 controller 状态会与 DOM 脱节。
    const { AccessPopoverController } = await import(
      "@features/editor/extensions/agent-thread-card/access/access-popover-controller"
    );
    const { useAgentAccessStore } = await import(
      "@features/agent/store/agent-access-store"
    );
    useAgentAccessStore.setState({
      config: { version: 1, entries: agentAccessMock.config.entries },
      isLoading: false,
    });

    const triggerButton = document.createElement("button");
    const popover = document.createElement("div");
    popover.className = "agent-thread-card__access-popover";
    popover.hidden = true;
    document.body.append(popover);

    const controller = new AccessPopoverController({
      button: triggerButton,
      popover,
      t: t as never,
      isDestroyed: () => false,
      isInsideRelatedTarget: () => false,
      consumeOutsidePointer: () => {},
    });
    controller.setOpen(true);
    expect(controller.isOpen).toBe(true);

    // popover 自身被移除 ── 模拟 NodeView destroy 路径。
    popover.remove();
    expect(popover.isConnected).toBe(false);

    (
      controller as unknown as { positionPopover: () => void }
    ).positionPopover();

    expect(controller.isOpen).toBe(false); // popover 失联才关

    controller.dispose();
  });
});
