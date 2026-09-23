// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoItem } from "@/types/memo-item";

const { getMemos, getFeaturedNoteFilter, setFeaturedNoteFilter } = vi.hoisted(() => ({
  getMemos: vi.fn(),
  getFeaturedNoteFilter: vi.fn(),
  setFeaturedNoteFilter: vi.fn(),
}));

vi.mock("@platform/tauri/client", () => ({
  agent: {},
  dshIntegration: { checkUpdate: vi.fn() },
  memos: { getMemos },
  windows: {},
  // 筛选条件存在笔记本文件夹的 `.flowix/system.json`, 走 system IPC。
  system: { getFeaturedNoteFilter, setFeaturedNoteFilter },
}));

vi.mock("@platform/tauri/event-bus", () => ({
  subscribe: vi.fn(() => vi.fn()),
}));

vi.mock("@features/memo/store/memo-store", () => ({
  useMemoStore: {
    getState: () => ({ selectedNotebook: { id: "notebook-1" } }),
  },
}));

vi.mock("@features/memo/use-cases/open-by-target", () => ({
  openNoteByMemoId: vi.fn(),
}));

vi.mock("@features/workspace/use-cases/browser-column-navigation", () => ({
  openBrowserColumnFileBrowser: vi.fn(),
}));

import { ExternalAgentSettingsController } from "./external-agent-settings-controller";

/** 模拟笔记本文件夹里 `.flowix/system.json` 的 featuredNotes 段。 */
let storedFilter = { key: "", operator: "", value: "" };

function memo(id: string, properties: Record<string, unknown>): MemoItem {
  return {
    id,
    filename: `${id}.md`,
    preview: `${id} description`,
    thumbnail: null,
    tags: [],
    todos: [],
    agents: [],
    createdAt: 1,
    updatedAt: 1,
    favorited: false,
    icon: null,
    colors: [],
    properties,
  };
}

describe("ExternalAgentSettingsController featured notes", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    getMemos.mockReset();
    // 用一个内存变量模拟后端存储, 让"写后重建列表"这条链路能读到新值。
    storedFilter = { key: "", operator: "", value: "" };
    getFeaturedNoteFilter.mockReset();
    getFeaturedNoteFilter.mockImplementation(async () => ({ ...storedFilter }));
    setFeaturedNoteFilter.mockReset();
    setFeaturedNoteFilter.mockImplementation(async (_notebookId, filter) => {
      storedFilter = { ...filter };
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * 设置弹层被 append 到 document.body (与 composer 的模型/权限弹窗同款),
   * 因此不能再用 empty.querySelector 去找, 必须从 body 上取。
   */
  function findPopover(): HTMLElement | null {
    return document.body.querySelector(".agent-thread-card__featured-notes-settings");
  }

  it("keeps the Agent icon and settings before asynchronously loaded note cards", async () => {
    getMemos
      .mockResolvedValueOnce({
        memos: [memo("hidden", {})],
        nextCursor: "page-2",
        hasMore: true,
      })
      .mockResolvedValueOnce({
        memos: [memo("skill", { type: "skill" })],
        nextCursor: null,
        hasMore: false,
      });

    const popover = document.createElement("div");
    const controller = new ExternalAgentSettingsController({
      popover,
      getTypeKey: () => "codex",
      getInstanceId: () => undefined,
      getLanguage: () => "zh-CN",
      t: (key) => key,
      isDestroyed: () => false,
    });

    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes")).not.toBeNull();
    });

    expect(getMemos).toHaveBeenNthCalledWith(1, expect.objectContaining({ cursor: undefined }));
    expect(getMemos).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: "page-2" }));

    const children = Array.from(empty.children);
    const iconIndex = children.findIndex((node) => node.classList.contains("agent-thread-card__empty-agent-icon"));
    const controlsIndex = children.findIndex((node) => node.classList.contains("agent-thread-card__empty-controls"));
    const notesIndex = children.findIndex((node) => node.classList.contains("agent-thread-card__featured-notes"));
    expect(iconIndex).toBeGreaterThanOrEqual(0);
    expect(controlsIndex).toBeGreaterThan(iconIndex);
    expect(notesIndex).toBeGreaterThan(controlsIndex);
    const notesPanel = empty.querySelector(".agent-thread-card__featured-notes");
    const panelChildren = Array.from(notesPanel?.children ?? []);
    expect(panelChildren.findIndex((node) => node.classList.contains("agent-thread-card__featured-notes-settings-footer")))
      .toBeGreaterThan(panelChildren.findIndex((node) => node.classList.contains("agent-thread-card__featured-notes-list")));

    controller.dispose();
  });

  it("persists a key/value filter and refreshes the visible cards", async () => {
    getMemos.mockResolvedValue({
      memos: [
        memo("skill", { type: "skill" }),
        memo("pinned", { pin: true }),
      ],
      nextCursor: null,
      hasMore: false,
    });

    const controller = new ExternalAgentSettingsController({
      popover: document.createElement("div"),
      getTypeKey: () => "codex",
      getInstanceId: () => undefined,
      getLanguage: () => "zh-CN",
      t: (key) => key,
      isDestroyed: () => false,
    });
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-note-title")?.textContent)
        .toBe("skill");
    });

    const settingsButton = empty.querySelector<HTMLButtonElement>(
      ".agent-thread-card__featured-notes-settings-button",
    );
    settingsButton?.click();
    const form = findPopover()?.querySelector<HTMLFormElement>("form");
    const keyInput = form?.elements.namedItem("key") as HTMLInputElement;
    const operatorInput = form?.elements.namedItem("operator") as HTMLInputElement;
    const valueInput = form?.elements.namedItem("value") as HTMLInputElement;
    expect(keyInput.value).toBe("type");
    expect(operatorInput.value).toBe("equals");
    expect(form?.querySelector("select")).toBeNull();
    const operatorTrigger = form?.querySelector<HTMLButtonElement>(
      ".agent-thread-card__featured-notes-operator-trigger",
    );
    operatorTrigger?.click();
    expect(form?.querySelector<HTMLElement>(
      ".agent-thread-card__featured-notes-operator-menu",
    )?.hidden).toBe(false);
    expect(valueInput.value).toBe("skill");
    keyInput.value = "pin";
    valueInput.value = "true";
    form?.requestSubmit();

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-note-title")?.textContent)
        .toBe("pinned");
    });
    // 落盘到笔记本文件夹的 .flowix/system.json (经 notebookId 定位), 不再用 localStorage。
    expect(setFeaturedNoteFilter).toHaveBeenCalledWith("notebook-1", {
      conditions: [{ key: "pin", operator: "equals", value: "true" }],
    });

    controller.dispose();
  });

  it("shows an inline error when persisting the filter fails", async () => {
    // 落盘失败必须可见: 静默失败会让用户以为配置已生效。
    getMemos.mockResolvedValue({
      memos: [memo("skill", { type: "skill" })],
      nextCursor: null,
      hasMore: false,
    });
    setFeaturedNoteFilter.mockRejectedValue(new Error("unsupported operator"));

    const controller = new ExternalAgentSettingsController({
      popover: document.createElement("div"),
      getTypeKey: () => "codex",
      getInstanceId: () => undefined,
      getLanguage: () => "zh-CN",
      t: (key) => key,
      isDestroyed: () => false,
    });
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes-settings-button"))
        .not.toBeNull();
    });

    empty.querySelector<HTMLButtonElement>(
      ".agent-thread-card__featured-notes-settings-button",
    )?.click();
    const form = findPopover()?.querySelector<HTMLFormElement>("form");
    (form?.elements.namedItem("key") as HTMLInputElement).value = "pin";
    (form?.elements.namedItem("value") as HTMLInputElement).value = "true";
    form?.requestSubmit();

    await vi.waitFor(() => {
      expect(form?.querySelector(".agent-thread-card__featured-notes-settings-error"))
        .not.toBeNull();
    });
    // 弹层保持打开, 用户可以改完重试。
    expect(findPopover()?.hidden).toBe(false);

    controller.dispose();
  });

  it("positions the root-level popover with viewport coordinates and flips it above", async () => {
    // 弹层挂到 document.body 后用 fixed + 视口坐标定位 (与 composer 的模型/权限
    // 弹窗同款)。这里断言真实的 top/left 计算值: 当按钮下方放不下时, 弹层应翻到
    // 按钮上方, 而不是溢出到视口外或被裁剪。
    getMemos.mockResolvedValue({
      memos: [memo("skill", { type: "skill" })],
      nextCursor: null,
      hasMore: false,
    });

    const controller = new ExternalAgentSettingsController({
      popover: document.createElement("div"),
      getTypeKey: () => "codex",
      getInstanceId: () => undefined,
      getLanguage: () => "zh-CN",
      t: (key) => key,
      isDestroyed: () => false,
    });
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes-settings-button"))
        .not.toBeNull();
    });

    const settingsButton = empty.querySelector<HTMLButtonElement>(
      ".agent-thread-card__featured-notes-settings-button",
    );
    // 按钮贴近视口底部 (jsdom 默认高 768): 下方只剩 20px, 放不下 220px 弹层,
    // 且按钮上方空间充足, 因此应向上翻转。
    vi.spyOn(settingsButton as HTMLButtonElement, "getBoundingClientRect").mockReturnValue({
      top: 748, bottom: 768, left: 380, right: 420,
      width: 40, height: 20, x: 380, y: 748, toJSON: () => ({}),
    } as DOMRect);

    // 弹层元素此时已挂在 body 上 (创建即 append), 先设好尺寸再打开。
    const popover = findPopover();
    vi.spyOn(popover as HTMLElement, "getBoundingClientRect").mockReturnValue({
      top: 0, bottom: 0, left: 0, right: 0,
      width: 420, height: 220, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);

    settingsButton?.click();

    // placeAbove → top = anchorTop - offset(6) - height(220) = 748 - 6 - 220 = 522
    expect(popover?.style.top).toBe("522px");
    // left 夹在 [padding(8), viewportWidth - padding - width] 之间
    expect(popover?.style.left).toBe("380px");

    controller.dispose();
  });

  it("renders one condition row with the four expected cells, actions last", async () => {
    // 表单纵向堆叠「条件行容器 + 操作行」; 每行内部才是 Key / 条件 / 值 / 删除
    // 四列。jsdom 不做布局, 因此这里锁住该布局依赖的 DOM 契约。
    getMemos.mockResolvedValue({
      memos: [memo("skill", { type: "skill" })],
      nextCursor: null,
      hasMore: false,
    });

    const controller = new ExternalAgentSettingsController({
      popover: document.createElement("div"),
      getTypeKey: () => "codex",
      getInstanceId: () => undefined,
      getLanguage: () => "zh-CN",
      t: (key) => key,
      isDestroyed: () => false,
    });
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes-settings-button"))
        .not.toBeNull();
    });

    const form = findPopover()?.querySelector<HTMLFormElement>("form");
    expect(Array.from(form?.children ?? []).map((node) => node.className)).toEqual([
      "agent-thread-card__featured-notes-settings-rows",
      "agent-thread-card__featured-notes-settings-actions",
    ]);

    const rows = form?.querySelector(".agent-thread-card__featured-notes-settings-rows");
    expect(rows?.childElementCount).toBe(1);
    const cells = Array.from(rows?.firstElementChild?.children ?? []);
    expect(cells.map((node) => node.className)).toEqual([
      "agent-thread-card__featured-notes-settings-field-key",
      "agent-thread-card__featured-notes-settings-field-operator",
      "agent-thread-card__featured-notes-settings-field-value",
      "agent-thread-card__featured-notes-settings-remove-condition",
    ]);
    // 前三个是 label (含输入控件), 删除按钮是 button。
    expect(cells.slice(0, 3).every((node) => node.tagName === "LABEL")).toBe(true);
    expect(cells[3]?.tagName).toBe("BUTTON");

    controller.dispose();
  });

  it("drops the field labels and prompts through placeholders instead", async () => {
    // 标签文案已移除, 改由 placeholder 提示; label 仍保留 (grid 子项 + 点击聚焦),
    // 但不应再包含文本节点。
    getMemos.mockResolvedValue({
      memos: [memo("skill", { type: "skill" })],
      nextCursor: null,
      hasMore: false,
    });

    const controller = new ExternalAgentSettingsController({
      popover: document.createElement("div"),
      getTypeKey: () => "codex",
      getInstanceId: () => undefined,
      getLanguage: () => "zh-CN",
      t: (key) => key,
      isDestroyed: () => false,
    });
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes-settings-button"))
        .not.toBeNull();
    });

    const form = findPopover()?.querySelector<HTMLFormElement>("form");
    // Key / Value 两个字段除了输入框不含任何文本; 条件字段的文本只来自下拉里
    // 的选项与当前选中值, 不应再出现"条件"这类标签文案。
    for (const fieldClass of [
      "agent-thread-card__featured-notes-settings-field-key",
      "agent-thread-card__featured-notes-settings-field-value",
    ]) {
      expect(form?.querySelector(`.${fieldClass}`)?.textContent?.trim()).toBe("");
    }
    const operatorField = form?.querySelector(
      ".agent-thread-card__featured-notes-settings-field-operator",
    );
    // label 的直接文本节点为空 → 标签文案确实删掉了。
    const operatorDirectText = Array.from(operatorField?.childNodes ?? [])
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent?.trim() ?? "")
      .join("");
    expect(operatorDirectText).toBe("");

    const keyInput = form?.elements.namedItem("key") as HTMLInputElement;
    const valueInput = form?.elements.namedItem("value") as HTMLInputElement;
    expect(keyInput.placeholder).toBe("editor.threadCard.featuredNotes.propertyKeyPlaceholder");
    expect(valueInput.placeholder).toBe("editor.threadCard.featuredNotes.propertyValuePlaceholder");

    controller.dispose();
  });

  it("prepends a title above the filter form using the shared settings title style", async () => {
    // 标题复用 composer 模型/权限弹窗的 .agent-thread-card__codex-settings-title,
    // 且必须是弹层的第一个子节点 (在 form 之前) 才会显示在字段上方。
    getMemos.mockResolvedValue({
      memos: [memo("skill", { type: "skill" })],
      nextCursor: null,
      hasMore: false,
    });

    const controller = new ExternalAgentSettingsController({
      popover: document.createElement("div"),
      getTypeKey: () => "codex",
      getInstanceId: () => undefined,
      getLanguage: () => "zh-CN",
      t: (key) => key,
      isDestroyed: () => false,
    });
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes-settings-button"))
        .not.toBeNull();
    });

    const popover = findPopover();
    const first = popover?.firstElementChild as HTMLElement | null;
    expect(first?.className).toBe("agent-thread-card__codex-settings-title");
    expect(first?.textContent).toBe("editor.threadCard.featuredNotes.settingsTitle");
    // 标题在表单之前。
    expect(first?.nextElementSibling?.tagName).toBe("FORM");

    controller.dispose();
  });

  it("offers only equals and contains in the condition dropdown", async () => {
    getMemos.mockResolvedValue({
      memos: [memo("skill", { type: "skill" })],
      nextCursor: null,
      hasMore: false,
    });

    const controller = new ExternalAgentSettingsController({
      popover: document.createElement("div"),
      getTypeKey: () => "codex",
      getInstanceId: () => undefined,
      getLanguage: () => "zh-CN",
      t: (key) => key,
      isDestroyed: () => false,
    });
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes-settings-button"))
        .not.toBeNull();
    });

    empty.querySelector<HTMLButtonElement>(
      ".agent-thread-card__featured-notes-settings-button",
    )?.click();
    const form = findPopover()?.querySelector<HTMLFormElement>("form");
    empty.querySelector<HTMLButtonElement>(
      ".agent-thread-card__featured-notes-operator-trigger",
    )?.click();

    const options = Array.from(
      form?.querySelectorAll<HTMLButtonElement>(
        ".agent-thread-card__featured-notes-operator-menu [role='option']",
      ) ?? [],
    );
    expect(options.map((option) => option.dataset.value)).toEqual(["equals", "contains"]);

    controller.dispose();
  });

  it("normalizes a legacy excludes operator to equals instead of silently keeping it", async () => {
    // 下拉已不提供 excludes, 但历史配置里可能存着。若只回落显示而不归一化,
    // 隐藏域会保留 excludes 并被原样写回, 与用户看到的"等于"不一致。
    getMemos.mockResolvedValue({
      memos: [memo("skill", { type: "skill" })],
      nextCursor: null,
      hasMore: false,
    });
    getFeaturedNoteFilter.mockResolvedValue({
      key: "type",
      operator: "excludes",
      value: "skill",
    });

    const controller = new ExternalAgentSettingsController({
      popover: document.createElement("div"),
      getTypeKey: () => "codex",
      getInstanceId: () => undefined,
      getLanguage: () => "zh-CN",
      t: (key) => key,
      isDestroyed: () => false,
    });
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes-settings-button"))
        .not.toBeNull();
    });

    empty.querySelector<HTMLButtonElement>(
      ".agent-thread-card__featured-notes-settings-button",
    )?.click();
    const form = findPopover()?.querySelector<HTMLFormElement>("form");
    const operatorInput = form?.elements.namedItem("operator") as HTMLInputElement;
    expect(operatorInput.value).toBe("equals");
    expect(
      form?.querySelector(".agent-thread-card__featured-notes-operator-trigger span")
        ?.textContent,
    ).toBe("editor.threadCard.featuredNotes.operator.equals");

    controller.dispose();
  });

  it("adds and removes condition rows, keeping at least one", async () => {
    getMemos.mockResolvedValue({
      memos: [memo("skill", { type: "skill" })],
      nextCursor: null,
      hasMore: false,
    });

    const controller = new ExternalAgentSettingsController({
      popover: document.createElement("div"),
      getTypeKey: () => "codex",
      getInstanceId: () => undefined,
      getLanguage: () => "zh-CN",
      t: (key) => key,
      isDestroyed: () => false,
    });
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes-settings-button"))
        .not.toBeNull();
    });
    empty.querySelector<HTMLButtonElement>(
      ".agent-thread-card__featured-notes-settings-button",
    )?.click();

    const form = findPopover()?.querySelector<HTMLFormElement>("form");
    const rows = form?.querySelector(".agent-thread-card__featured-notes-settings-rows");
    const addButton = form?.querySelector<HTMLButtonElement>(
      ".agent-thread-card__featured-notes-settings-add-condition",
    );
    const removeButtons = (): HTMLButtonElement[] => Array.from(
      rows?.querySelectorAll<HTMLButtonElement>(
        ".agent-thread-card__featured-notes-settings-remove-condition",
      ) ?? [],
    );

    // 初始一条, 且不允许删除 (否则会出现"零条件")。
    expect(rows?.childElementCount).toBe(1);
    expect(removeButtons()[0]?.hidden).toBe(true);

    addButton?.click();
    expect(rows?.childElementCount).toBe(2);
    // 两条起删除按钮才出现。
    expect(removeButtons().every((button) => !button.hidden)).toBe(true);

    removeButtons()[1]?.click();
    expect(rows?.childElementCount).toBe(1);
    expect(removeButtons()[0]?.hidden).toBe(true);
    // 注意用 hidden 而非 remove(): 行样式靠
    // `.featured-notes-settings-row:has(> ...-remove-condition[hidden])` 切换列
    // 模板, 让「值」输入框在无删除按钮时铺满到行尾。按钮被移出 DOM 的话这条
    // 规则就失效了。
    expect(removeButtons()[0]?.isConnected).toBe(true);

    controller.dispose();
  });

  it("caps how many conditions can be added", async () => {
    getMemos.mockResolvedValue({
      memos: [memo("skill", { type: "skill" })],
      nextCursor: null,
      hasMore: false,
    });

    const controller = new ExternalAgentSettingsController({
      popover: document.createElement("div"),
      getTypeKey: () => "codex",
      getInstanceId: () => undefined,
      getLanguage: () => "zh-CN",
      t: (key) => key,
      isDestroyed: () => false,
    });
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes-settings-button"))
        .not.toBeNull();
    });
    empty.querySelector<HTMLButtonElement>(
      ".agent-thread-card__featured-notes-settings-button",
    )?.click();

    const form = findPopover()?.querySelector<HTMLFormElement>("form");
    const rows = form?.querySelector(".agent-thread-card__featured-notes-settings-rows");
    const addButton = form?.querySelector<HTMLButtonElement>(
      ".agent-thread-card__featured-notes-settings-add-condition",
    );

    // 连点超过上限, 行数应停在 MAX_FEATURED_NOTE_CONDITIONS 且按钮禁用。
    for (let index = 0; index < 10; index += 1) addButton?.click();
    expect(rows?.childElementCount).toBe(5);
    expect(addButton?.disabled).toBe(true);

    controller.dispose();
  });

  it("saves every filled condition row", async () => {
    getMemos.mockResolvedValue({
      memos: [memo("skill", { type: "skill" })],
      nextCursor: null,
      hasMore: false,
    });

    const controller = new ExternalAgentSettingsController({
      popover: document.createElement("div"),
      getTypeKey: () => "codex",
      getInstanceId: () => undefined,
      getLanguage: () => "zh-CN",
      t: (key) => key,
      isDestroyed: () => false,
    });
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes-settings-button"))
        .not.toBeNull();
    });
    empty.querySelector<HTMLButtonElement>(
      ".agent-thread-card__featured-notes-settings-button",
    )?.click();

    const form = findPopover()?.querySelector<HTMLFormElement>("form");
    form?.querySelector<HTMLButtonElement>(
      ".agent-thread-card__featured-notes-settings-add-condition",
    )?.click();

    const rows = Array.from(
      form?.querySelectorAll<HTMLElement>(".agent-thread-card__featured-notes-settings-row")
        ?? [],
    );
    (rows[0]?.querySelector('[name="key"]') as HTMLInputElement).value = "type";
    (rows[0]?.querySelector('[name="value"]') as HTMLInputElement).value = "skill";
    (rows[1]?.querySelector('[name="key"]') as HTMLInputElement).value = "pin";
    (rows[1]?.querySelector('[name="value"]') as HTMLInputElement).value = "true";
    form?.requestSubmit();

    await vi.waitFor(() => {
      expect(setFeaturedNoteFilter).toHaveBeenCalled();
    });
    // 两行都被收集并按顺序落盘。
    expect(setFeaturedNoteFilter).toHaveBeenCalledWith("notebook-1", {
      conditions: [
        { key: "type", operator: "equals", value: "skill" },
        { key: "pin", operator: "equals", value: "true" },
      ],
    });

    controller.dispose();
  });

  it("renders note cards as icon plus content, with no try button", async () => {
    // 卡片首行原先右侧有个「试试」按钮 (featured-note-try), 已移除; 图标现在
    // 是卡片的直接子项, 与内容并列。
    getMemos.mockResolvedValue({
      memos: [memo("skill", { type: "skill" })],
      nextCursor: null,
      hasMore: false,
    });

    const controller = new ExternalAgentSettingsController({
      popover: document.createElement("div"),
      getTypeKey: () => "codex",
      getInstanceId: () => undefined,
      getLanguage: () => "zh-CN",
      t: (key) => key,
      isDestroyed: () => false,
    });
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector("button.agent-thread-card__featured-note")).not.toBeNull();
    });

    const card = empty.querySelector<HTMLButtonElement>(
      "button.agent-thread-card__featured-note",
    );
    expect(card?.querySelector(".agent-thread-card__featured-note-try")).toBeNull();
    expect(Array.from(card?.children ?? []).map((node) => node.className)).toEqual([
      "agent-thread-card__featured-note-icon",
      "agent-thread-card__featured-note-content",
    ]);

    controller.dispose();
  });

  it("inserts the note into the composer when a card is clicked", async () => {
    // 点击卡片不再打开笔记, 而是把该笔记作为行内引用交给宿主注入输入框。
    getMemos.mockResolvedValue({
      memos: [memo("skill", { type: "skill" })],
      nextCursor: null,
      hasMore: false,
    });
    const onSelectFeaturedNote = vi.fn();

    const controller = new ExternalAgentSettingsController({
      popover: document.createElement("div"),
      getTypeKey: () => "codex",
      getInstanceId: () => undefined,
      getLanguage: () => "zh-CN",
      t: (key) => key,
      isDestroyed: () => false,
      onSelectFeaturedNote,
    });
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector("button.agent-thread-card__featured-note")).not.toBeNull();
    });

    empty.querySelector<HTMLButtonElement>(
      "button.agent-thread-card__featured-note",
    )?.click();

    expect(onSelectFeaturedNote).toHaveBeenCalledTimes(1);
    // 标题取自文件名去掉 .md; filename 与 title 都传同一个值 (见 createFeaturedNoteCard)。
    expect(onSelectFeaturedNote).toHaveBeenCalledWith({
      id: "skill",
      filename: "skill",
      title: "skill",
    });

    controller.dispose();
  });
});
