import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_ACTION,
  createAccessEntryRow,
  resolveAccessAction,
} from "./access-entries";
import type { AgentAccessEntry } from "@/lib/types/agent-access";

vi.mock("@features/memo/components/notebook-icon", () => ({
  getNotebookIconMarkup: () => null,
}));

function makeEntry(overrides: Partial<AgentAccessEntry>): AgentAccessEntry {
  return {
    id: "folder-1",
    kind: "folder",
    path: "D:\\projects\\first",
    name: "First",
    enabled: true,
    workspace: false,
    missing: false,
    addedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const t = (key: string): string => key;

describe("createAccessEntryRow", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("declares row metadata for delegation (no per-button listeners)", () => {
    // 简化设计 ── 行内 button 不再挂 listener, 全靠 data-action / data-entry-id
    // 给 popover 顶层 delegation 路由。 这里只断言 DOM 结构正确, 不再断言
    // stopPropagation 或单 button 触发, 那是 controller 层职责。
    const entry = makeEntry({ id: "folder-1", workspace: false });
    const row = createAccessEntryRow({
      entry,
      notebooks: [],
      t,
    });

    expect(row.dataset.entryId).toBe("folder-1");

    const checkbox = row.querySelector<HTMLButtonElement>(
      ".agent-thread-card__access-checkbox",
    );
    expect(checkbox?.dataset.action).toBe(ACCESS_ACTION.TOGGLE);
    expect(checkbox?.dataset.entryId).toBe("folder-1");

    const setBtn = row.querySelector<HTMLButtonElement>(
      ".agent-thread-card__access-avatar--set-workspace",
    );
    expect(setBtn?.dataset.action).toBe(ACCESS_ACTION.SET_WORKSPACE);
    expect(setBtn?.dataset.entryId).toBe("folder-1");

    const remove = row.querySelector<HTMLButtonElement>(
      ".agent-thread-card__access-remove",
    );
    expect(remove?.dataset.action).toBe(ACCESS_ACTION.REMOVE);
    expect(remove?.dataset.entryId).toBe("folder-1");
    expect(row.lastElementChild).toBe(checkbox);
  });

  it("does not render the set-workspace button when entry is already workspace", () => {
    // workspace folder 的 avatar 是 folder + 左上角三角蒙块, 没有"再设一次"的入口。
    const entry = makeEntry({ id: "folder-1", workspace: true });
    const row = createAccessEntryRow({ entry, notebooks: [], t });

    const setBtn = row.querySelector(
      ".agent-thread-card__access-avatar--set-workspace",
    );
    expect(setBtn).toBeNull();
  });

  it("renders a top-left triangle mark for workspace folders", () => {
    // workspace 的视觉标记改为 folder 图标左上角的三角蒙块 ── 图标本身仍是
    // 普通 folder (不再用 folder-star 图标)。
    const entry = makeEntry({ id: "folder-1", workspace: true });
    const row = createAccessEntryRow({ entry, notebooks: [], t });

    expect(
      row.querySelector(".agent-thread-card__access-avatar--workspace"),
    ).not.toBeNull();
    expect(
      row.querySelector(".agent-thread-card__access-workspace-mark"),
    ).not.toBeNull();
  });

  it("renders the workspace mark for a workspace notebook", () => {
    // notebook 被设为主空间时, 与 folder 一样在 avatar 左上角叠三角蒙块。
    const entry = makeEntry({ id: "nb-1", kind: "notebook", workspace: true });
    const row = createAccessEntryRow({ entry, notebooks: [], t });

    expect(
      row.querySelector(".agent-thread-card__access-avatar--workspace"),
    ).not.toBeNull();
    expect(
      row.querySelector(".agent-thread-card__access-workspace-mark"),
    ).not.toBeNull();
  });

  it("does not render the set-workspace button for missing entry", () => {
    const entry = makeEntry({ missing: true });
    const row = createAccessEntryRow({ entry, notebooks: [], t });

    const setBtn = row.querySelector(
      ".agent-thread-card__access-avatar--set-workspace",
    );
    expect(setBtn).toBeNull();
  });

  it("does not render the remove button for notebook entries", () => {
    // notebook 行没有 trash ── notebook 走"删除笔记本"主路径, 不在这里删。
    const entry = makeEntry({ id: "nb-1", kind: "notebook" });
    const row = createAccessEntryRow({ entry, notebooks: [], t });

    expect(
      row.querySelector(".agent-thread-card__access-remove"),
    ).toBeNull();
    expect(row.lastElementChild).toBe(
      row.querySelector(".agent-thread-card__access-checkbox"),
    );
  });
});

describe("resolveAccessAction", () => {
  let popover: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    popover = document.createElement("div");
    document.body.append(popover);
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function dispatchOn(target: Element): MouseEvent {
    // 直接在 DOM 元素上 dispatch ── event.target 由浏览器派发时填入,
    // resolveAccessAction 内部读 target.closest(...) 即可拿到正确的祖先。
    const event = new MouseEvent("click", { bubbles: true });
    target.dispatchEvent(event);
    return event;
  }

  it("routes clicks on the avatar to SET_WORKSPACE with the entry id", () => {
    // 关键回归 ── avatar (folder 图标本身) 的 click 必须路由到 setWorkspace,
    // 而不是 row action。
    const entry = makeEntry({ id: "folder-1", workspace: false });
    const row = createAccessEntryRow({ entry, notebooks: [], t });
    popover.append(row);

    const setBtn = row.querySelector<HTMLButtonElement>(
      ".agent-thread-card__access-avatar--set-workspace",
    )!;
    const event = dispatchOn(setBtn);
    const resolved = resolveAccessAction(event, popover);
    expect(resolved).toEqual({
      kind: "row",
      action: ACCESS_ACTION.SET_WORKSPACE,
      entryId: "folder-1",
    });
  });

  it("clicking the row name area resolves to null (no action)", () => {
    // 关键 UX 回归 ── row 的 name / avatar 默认区不再回退到 toggle, 而是
    // 返回 null, 避免"误触 row 闪一下"。 用户必须显式点 checkbox / avatar /
    // remove 才会触发状态变化。
    const entry = makeEntry({ id: "folder-1" });
    const row = createAccessEntryRow({ entry, notebooks: [], t });
    popover.append(row);

    const nameWrap = row.querySelector<HTMLElement>(
      ".agent-thread-card__access-name-wrap",
    )!;
    const event = dispatchOn(nameWrap);
    expect(resolveAccessAction(event, popover)).toBeNull();
  });

  it("clicking the workspace folder avatar (no data-action) resolves to null", () => {
    // workspace entry 的 avatar 是纯展示 <span> (folder 图标 + 三角蒙块), 没有
    // data-action ── 点它不应触发任何动作 (workspace 已是主空间, 没有"再设一次")。
    const entry = makeEntry({ id: "folder-1", workspace: true });
    const row = createAccessEntryRow({ entry, notebooks: [], t });
    popover.append(row);

    const avatar = row.querySelector<HTMLElement>(
      ".agent-thread-card__access-avatar--workspace",
    )!;
    const event = dispatchOn(avatar);
    expect(resolveAccessAction(event, popover)).toBeNull();
  });

  it("routes clicks on a notebook avatar to SET_WORKSPACE", () => {
    // notebook 的 avatar 也是 set-workspace 入口 ── 点 notebook 图标即设为主空间。
    const entry = makeEntry({ id: "nb-1", kind: "notebook" });
    const row = createAccessEntryRow({ entry, notebooks: [], t });
    popover.append(row);

    const avatar = row.querySelector<HTMLButtonElement>(
      ".agent-thread-card__access-avatar--set-workspace",
    )!;
    const event = dispatchOn(avatar);
    const resolved = resolveAccessAction(event, popover);
    expect(resolved).toEqual({
      kind: "row",
      action: ACCESS_ACTION.SET_WORKSPACE,
      entryId: "nb-1",
    });
  });

  it("routes checkbox clicks to TOGGLE", () => {
    const entry = makeEntry({ id: "folder-1" });
    const row = createAccessEntryRow({ entry, notebooks: [], t });
    popover.append(row);

    const checkbox = row.querySelector<HTMLButtonElement>(
      ".agent-thread-card__access-checkbox",
    )!;
    const event = dispatchOn(checkbox);
    const resolved = resolveAccessAction(event, popover);
    expect(resolved).toEqual({
      kind: "row",
      action: ACCESS_ACTION.TOGGLE,
      entryId: "folder-1",
    });
  });

  it("routes remove clicks to REMOVE", () => {
    const entry = makeEntry({ id: "folder-1" });
    const row = createAccessEntryRow({ entry, notebooks: [], t });
    popover.append(row);

    const remove = row.querySelector<HTMLButtonElement>(
      ".agent-thread-card__access-remove",
    )!;
    const event = dispatchOn(remove);
    const resolved = resolveAccessAction(event, popover);
    expect(resolved).toEqual({
      kind: "row",
      action: ACCESS_ACTION.REMOVE,
      entryId: "folder-1",
    });
  });

  it("returns null when target is outside the popover", () => {
    // 防止 popover 之外的元素误触发 ── 例如 access 按钮自身被点中时, 不应
    // 被这条 delegation 当成 row action 派发。
    const entry = makeEntry({ id: "folder-1" });
    const row = createAccessEntryRow({ entry, notebooks: [], t });
    document.body.append(row); // 不在 popover 内

    const event = dispatchOn(row);
    const resolved = resolveAccessAction(event, popover);
    expect(resolved).toBeNull();
  });
});