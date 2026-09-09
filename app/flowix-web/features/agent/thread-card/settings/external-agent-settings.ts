import type { AgentTypeKey } from "@/types/agent";
import { getAgentType, isThemeAdaptiveAgentIcon } from "@/lib/agent-types";
import type { AgentRuntimeSettingKind } from "@features/agent/runtime/agent-runtime-spec";
import { createCheckIcon } from "@features/agent/thread-card/agent-thread-card-icons";

export type ExternalAgentEmptyControlKind = AgentRuntimeSettingKind;

/**
 * 空状态控件组上方的 Agent 标识 (仅独立对话 / 全屏会显示, 由 CSS 控制)。
 *
 * 渲染约定与 React 版 <AgentIcon> 一致: 单色图标走 CSS mask 以跟随主题
 * 前景色, 其余品牌图标保留原始配色直接用 <img>。
 */
export function createExternalAgentEmptyIcon(
  typeKey: AgentTypeKey,
): HTMLElement {
  const type = getAgentType(typeKey);

  if (!isThemeAdaptiveAgentIcon(typeKey)) {
    const img = document.createElement("img");
    img.className = "agent-thread-card__empty-agent-icon";
    img.src = type.icon;
    img.alt = "";
    img.draggable = false;
    img.setAttribute("aria-hidden", "true");
    return img;
  }

  const mark = document.createElement("span");
  mark.className =
    "agent-icon agent-icon--masked agent-thread-card__empty-agent-icon";
  mark.style.setProperty("--agent-icon-src", `url("${type.icon}")`);
  mark.setAttribute("aria-hidden", "true");
  return mark;
}

export function createExternalAgentWorkspaceDisplay(
  label: string,
  value: string,
  onClick: (button: HTMLButtonElement) => void,
): HTMLButtonElement {
  const display = document.createElement("button");
  display.type = "button";
  display.className = "agent-thread-card__empty-workspace";
  display.setAttribute("aria-haspopup", "menu");
  display.setAttribute("aria-expanded", "false");
  display.setAttribute("aria-label", `${label}: ${value}`);

  const labelEl = document.createElement("span");
  labelEl.className = "agent-thread-card__empty-workspace-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("span");
  valueEl.className = "agent-thread-card__empty-workspace-value";
  valueEl.textContent = value;
  display.append(labelEl, valueEl, createDropdownChevron());
  display.title = `${label}: ${value}`;
  display.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick(display);
  });
  display.addEventListener("mousedown", (event) => event.stopPropagation());
  return display;
}

/** Compact workspace switcher trigger used by the expanded composer footer. */
export function createExternalAgentWorkspaceControl(
  label: string,
  value: string,
  onClick: (button: HTMLButtonElement) => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "agent-thread-card__composer-workspace";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", `${label}: ${value}`);
  const valueEl = document.createElement("span");
  valueEl.className = "agent-thread-card__composer-workspace-value";
  valueEl.textContent = value;
  button.append(valueEl, createDropdownChevron());
  button.title = `${label}: ${value}`;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick(button);
  });
  button.addEventListener("mousedown", (event) => event.stopPropagation());
  return button;
}

export function createDropdownChevron(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.classList.add("agent-thread-card__empty-control-chevron");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m6 9 6 6 6-6");
  svg.append(path);
  return svg;
}

export function createExternalAgentEmptyControl(
  kind: ExternalAgentEmptyControlKind,
  label: string,
  value: string,
  onClick: (kind: ExternalAgentEmptyControlKind, button: HTMLButtonElement) => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "agent-thread-card__empty-control";
  button.dataset.kind = kind;
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", label);

  const labelEl = document.createElement("span");
  labelEl.className = "agent-thread-card__empty-control-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("span");
  valueEl.className = "agent-thread-card__empty-control-value";
  valueEl.textContent = value;
  button.append(labelEl, valueEl, createDropdownChevron());

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick(kind, button);
  });
  button.addEventListener("mousedown", (event) => event.stopPropagation());
  return button;
}

export function updateExternalAgentEmptyControl(
  button: HTMLButtonElement | null,
  value: string,
): void {
  const valueEl = button?.querySelector<HTMLElement>(
    ".agent-thread-card__empty-control-value",
  );
  if (valueEl) valueEl.textContent = value;
}

export type CodexSettingsItemLayout = "list" | "grid";

export interface CodexSettingsItemOptions {
  layout?: CodexSettingsItemLayout;
  readOnly?: boolean;
  selectedLabel?: string;
}

export function createCodexSettingsItem(
  label: string,
  selected: boolean,
  onSelect: () => void,
  description?: string,
  options?: CodexSettingsItemOptions,
): HTMLElement {
  const layout: CodexSettingsItemLayout = options?.layout ?? "list";
  const isGrid = layout === "grid";
  const readOnly = options?.readOnly === true;
  const item = document.createElement("button");
  item.type = "button";
  item.className = isGrid
    ? "agent-thread-card__codex-settings-item agent-thread-card__codex-settings-item--grid"
    : "agent-thread-card__codex-settings-item";
  if (readOnly) {
    item.classList.add("agent-thread-card__codex-settings-item--readonly");
    item.disabled = true;
  }
  item.setAttribute("role", "menuitemradio");
  item.setAttribute("aria-checked", selected ? "true" : "false");
  if (!readOnly) {
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      onSelect();
    });
  }
  const content = document.createElement("span");
  content.className = isGrid
    ? "agent-thread-card__codex-settings-item-content agent-thread-card__codex-settings-item-content--grid"
    : "agent-thread-card__codex-settings-item-content";
  const text = document.createElement("span");
  text.className = "agent-thread-card__codex-settings-item-label";
  text.textContent = label;
  content.append(text);
  if (description) {
    const descriptionEl = document.createElement("span");
    descriptionEl.className = "agent-thread-card__codex-settings-item-description";
    descriptionEl.textContent = description;
    content.append(descriptionEl);
  }
  item.append(content);
  if (selected) {
    if (options?.selectedLabel) {
      const selectedLabel = document.createElement("span");
      selectedLabel.className = "agent-thread-card__codex-settings-item-selected-label";
      selectedLabel.textContent = options.selectedLabel;
      item.append(selectedLabel);
    } else {
      item.append(createCheckIcon());
    }
  }
  return item;
}
