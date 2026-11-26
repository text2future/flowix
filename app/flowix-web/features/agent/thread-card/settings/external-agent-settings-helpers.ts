import cursorOutlineSvg from "@/assets/cursor-outline.svg?raw";
import folderOutlineSvg from "@/assets/folder-outline.svg?raw";
import shieldAlertOutlineSvg from "@/assets/shield-alert-outline.svg?raw";
import shieldCheckOutlineSvg from "@/assets/shield-check-outline.svg?raw";
import type { AgentPermissionMode } from "@/types/agent";
import type { AgentModelOption } from "@features/agent/thread-card/settings/model-picker/model-picker-types";

export function createComposerWorkspaceIcon(): SVGSVGElement | null {
  const template = document.createElement("template");
  template.innerHTML = folderOutlineSvg.trim();
  const icon = template.content.firstElementChild as SVGSVGElement | null;
  if (!icon) return null;
  icon.classList.add("agent-composer__workspace-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  return icon;
}

export function createPermissionModeIcon(
  mode: AgentPermissionMode,
): SVGSVGElement | null {
  const svgSource =
    mode === "danger-full-access"
      ? shieldAlertOutlineSvg
      : mode === "workspace-write"
        ? shieldCheckOutlineSvg
        : mode === "read-only"
          ? cursorOutlineSvg
          : null;
  if (!svgSource) return null;
  const template = document.createElement("template");
  template.innerHTML = svgSource.trim();
  const icon = template.content.firstElementChild as SVGSVGElement | null;
  if (!icon) return null;
  icon.classList.add("agent-thread-card__permission-mode-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  if (mode === "danger-full-access") {
    icon.classList.add("agent-thread-card__permission-mode-icon--warning");
  }
  return icon;
}

export function modelProviderIcon(iconUrl?: string, eager = false): HTMLImageElement | undefined {
  if (!iconUrl) return undefined;
  try {
    if (new URL(iconUrl).protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  const image = document.createElement("img");
  image.className = "agent-thread-card__model-provider-icon";
  image.src = iconUrl;
  image.alt = "";
  image.loading = eager ? "eager" : "lazy";
  image.referrerPolicy = "no-referrer";
  image.onerror = () => { if (eager) image.style.visibility = "hidden"; else image.remove(); };
  return image;
}

export function sameModelOptions(
  left: readonly AgentModelOption[],
  right: readonly AgentModelOption[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((model, index) => {
    const candidate = right[index];
    return model.source === candidate.source
      && model.id === candidate.id
      && model.label === candidate.label
      && model.description === candidate.description
      && model.subtitle === candidate.subtitle
      && JSON.stringify(model.tags) === JSON.stringify(candidate.tags)
      && model.creditMultiplier === candidate.creditMultiplier
      && Boolean(model.recommended) === Boolean(candidate.recommended)
      && model.iconUrl === candidate.iconUrl
      && model.providerId === candidate.providerId
      && model.providerName === candidate.providerName
      && JSON.stringify(model.reasoningConfig) === JSON.stringify(candidate.reasoningConfig)
      && JSON.stringify(model.reasoningEfforts) === JSON.stringify(candidate.reasoningEfforts);
  });
}
