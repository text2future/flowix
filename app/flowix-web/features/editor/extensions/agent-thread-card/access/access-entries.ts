import type { AgentAccessEntry } from "@/lib/types/agent-access";
import { getNotebookIconMarkup } from "@features/memo/components/notebook-icon";
import {
  createAlertIcon,
  createFolderIcon,
  createTrashIcon,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-icons";

type NotebookLike = {
  id: string;
  icon?: string | null;
};

/**
 * 行内交互通过 `data-action` 属性声明 ── 由 popover 上的单一 click 监听器
 * 统一派发 (event delegation)。 这样不用在每个 button 上挂 stopPropagation
 * 三层 (pointerdown/mousedown/click), 也避免事件冒泡到外层误触发 NodeSelection
 * 或弹窗关闭逻辑。 action 与 entry.id 都在 DOM 上, 跟 React 风格一致 ──
 * 视图层只声明意图, 控制器层做路由。
 */
export const ACCESS_ACTION = {
  TOGGLE: "toggle",
  SET_WORKSPACE: "set-workspace",
  REMOVE: "remove",
  ADD_FOLDER: "add-folder",
} as const;

export type AccessAction = (typeof ACCESS_ACTION)[keyof typeof ACCESS_ACTION];

/**
 * popover click delegation 的路由结果。 分两种 shape:
 * - `row` kind: 携带 entryId, 用于 per-row 动作 (toggle / set-workspace / remove)
 * - `top` kind: 顶部级动作 (加 folder), 没有 entryId 概念
 */
export type ResolvedAccessAction =
  | { kind: "row"; entryId: string; action: Exclude<AccessAction, typeof ACCESS_ACTION.ADD_FOLDER> }
  | { kind: "top"; action: typeof ACCESS_ACTION.ADD_FOLDER };

export interface CreateAccessEntryRowOptions {
  entry: AgentAccessEntry;
  notebooks: NotebookLike[];
  t: (key: string) => string;
}

function getAccessEntryLetter(
  name: string | undefined | null,
  fallback: string = "N",
): string {
  const trimmed = name?.trim();
  if (!trimmed) return fallback;
  const first = trimmed.charAt(0);
  return /[A-Za-z0-9]/.test(first) ? first.toUpperCase() : fallback;
}

export function createAccessSectionLabel(label: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "agent-thread-card__access-section-label";
  el.textContent = label;
  return el;
}

export function createAccessDivider(): HTMLElement {
  const el = document.createElement("hr");
  el.className = "agent-thread-card__access-divider";
  return el;
}

/**
 * 构造一条 entry row ── checkbox / avatar / trash 三个交互点通过
 * `data-action` 标识, 由 popover 层 click delegation 路由。
 *
 * 这里不再挂任何 listener ── 让 popover 顶层一个 handler 就够, 避免每个
 * button 都 stopPropagation pointerdown/mousedown/click 三层, 也避免
 * 子元素 listener 顺序依赖。
 */
export function createAccessEntryRow({
  entry,
  notebooks,
  t,
}: CreateAccessEntryRowOptions): HTMLElement {
  const isNotebook = entry.kind === "notebook";
  const isWorkspace = Boolean(entry.workspace);
  const notebook = isNotebook
    ? notebooks.find((item) => item.id === entry.id)
    : null;

  const row = document.createElement("div");
  row.className = "agent-thread-card__access-row";
  row.dataset.entryId = entry.id;
  row.title = entry.missing ? t("agent.access.pathMissing") : entry.path;
  if (entry.missing) {
    row.classList.add("agent-thread-card__access-row--disabled");
  }

  const checkbox = document.createElement("button");
  checkbox.type = "button";
  checkbox.className = "agent-thread-card__access-checkbox";
  checkbox.dataset.action = ACCESS_ACTION.TOGGLE;
  checkbox.dataset.entryId = entry.id;
  checkbox.setAttribute("role", "checkbox");
  checkbox.setAttribute("aria-checked", entry.enabled ? "true" : "false");
  checkbox.setAttribute(
    "aria-label",
    entry.enabled
      ? t("agent.access.toggle.on")
      : t("agent.access.toggle.off"),
  );
  checkbox.disabled = !!entry.missing;
  checkbox.classList.toggle(
    "agent-thread-card__access-checkbox--checked",
    entry.enabled,
  );
  if (entry.enabled) {
    const mark = document.createElement("span");
    mark.className =
      "flowix-hand-check agent-thread-card__access-checkbox-mark";
    mark.setAttribute("aria-hidden", "true");
    checkbox.append(mark);
  }
  row.append(checkbox);

  // avatar 本身就是点击入口: 可设为 workspace 的 entry (非 workspace + 非 missing)
  // 渲染成 <button>, 点 avatar 直接 setWorkspace ── 不再 hover 出 star 按钮覆盖,
  // 交互入口即图标本身 (folder 与 notebook 同此设计)。 workspace entry 渲染原图标
  // + 右下角三角蒙块, 不可点击 (已是主空间)。 missing entry 不可点击 (路径不存在,
  // setWorkspace 会被 store 因 missing 拒绝)。
  const canSetWorkspace = !isWorkspace && !entry.missing;
  const avatar: HTMLElement = canSetWorkspace
    ? document.createElement("button")
    : document.createElement("span");
  avatar.className = "agent-thread-card__access-avatar";
  if (canSetWorkspace) {
    const avatarButton = avatar as HTMLButtonElement;
    avatarButton.type = "button";
    avatar.classList.add("agent-thread-card__access-avatar--set-workspace");
    avatar.dataset.action = ACCESS_ACTION.SET_WORKSPACE;
    avatar.dataset.entryId = entry.id;
    avatarButton.setAttribute("aria-label", t("agent.access.setWorkspace"));
    avatarButton.title = t("agent.access.setWorkspace");
  } else if (isWorkspace) {
    avatar.classList.add("agent-thread-card__access-avatar--workspace");
  }

  if (isNotebook) {
    const iconMarkup = getNotebookIconMarkup(notebook?.icon);
    if (iconMarkup) {
      avatar.classList.add("agent-thread-card__access-avatar--icon");
      avatar.innerHTML = iconMarkup;
    } else {
      avatar.textContent = getAccessEntryLetter(entry.name);
    }
  } else {
    avatar.append(createFolderIcon());
  }

  if (isWorkspace) {
    // workspace entry (folder 或 notebook) 右下角叠三角蒙块作为 "主空间" 角标。
    const workspaceMark = document.createElement("span");
    workspaceMark.className = "agent-thread-card__access-workspace-mark";
    workspaceMark.setAttribute("aria-hidden", "true");
    avatar.append(workspaceMark);
  }
  row.append(avatar);

  const nameWrap = document.createElement("span");
  nameWrap.className = "agent-thread-card__access-name-wrap";
  const name = document.createElement("span");
  name.className = "agent-thread-card__access-name";
  name.textContent = entry.name;
  nameWrap.append(name);
  if (entry.missing) {
    nameWrap.append(createAlertIcon());
  }
  row.append(nameWrap);

  if (!isNotebook) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "agent-thread-card__access-remove";
    remove.dataset.action = ACCESS_ACTION.REMOVE;
    remove.dataset.entryId = entry.id;
    remove.setAttribute("aria-label", t("agent.access.deleteFolder"));
    remove.append(createTrashIcon());
    row.append(remove);
  }

  return row;
}

/**
 * 从 click event 找出最近的 [data-action] 元素 ── popover 的 click handler
 * 用它来路由。 找不到 [data-action] 返回 null: row 的 name 区 / workspace
 * avatar (纯展示 span) 不响应 click, 用户必须显式点 checkbox / avatar
 * (set-workspace) / remove 才会触发动作。
 */
export function resolveAccessAction(
  event: MouseEvent,
  popover: HTMLElement,
): ResolvedAccessAction | null {
  const target = event.target as Element | null;
  if (!target) return null;
  const actionable = target.closest<HTMLElement>("[data-action]");
  if (!actionable || !popover.contains(actionable)) return null;
  const action = actionable.dataset.action;

  // 加 folder 是顶部级动作, 没有 entryId 概念, 走单独的 top shape。
  if (action === ACCESS_ACTION.ADD_FOLDER) {
    return { kind: "top", action: ACCESS_ACTION.ADD_FOLDER };
  }

  // 其它 action 都关联到具体 entry, 要求 dataset.entryId 非空。
  if (
    action === ACCESS_ACTION.TOGGLE ||
    action === ACCESS_ACTION.SET_WORKSPACE ||
    action === ACCESS_ACTION.REMOVE
  ) {
    const entryId = actionable.dataset.entryId;
    if (!entryId) return null;
    return { kind: "row", action, entryId };
  }

  return null;
}
