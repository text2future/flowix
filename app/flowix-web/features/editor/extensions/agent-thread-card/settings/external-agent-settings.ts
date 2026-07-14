import type { AgentRuntimeSettingKind } from "@features/agent/runtime/agent-runtime-spec";
import { createCheckIcon } from "@features/editor/extensions/agent-thread-card/agent-thread-card-icons";

export type ExternalAgentEmptyControlKind = AgentRuntimeSettingKind | "files";

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

export function createCodexSettingsItem(
  label: string,
  selected: boolean,
  onSelect: () => void,
): HTMLElement {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "agent-thread-card__codex-settings-item";
  item.setAttribute("role", "menuitemradio");
  item.setAttribute("aria-checked", selected ? "true" : "false");
  item.addEventListener("click", (event) => {
    event.stopPropagation();
    onSelect();
  });
  const text = document.createElement("span");
  text.className = "agent-thread-card__codex-settings-item-label";
  text.textContent = label;
  item.append(text);
  if (selected) item.append(createCheckIcon());
  return item;
}
