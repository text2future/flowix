import { getPropertyIconOption } from "@features/document/properties/property-icons";
import { getNotebookIconMarkup } from "@features/memo/components/notebook-icon";

export interface AgentRoleOption {
  memoId: string;
  name: string;
  filename: string;
  memoIcon?: string | null;
  notebookId: string;
  notebookName: string;
  notebookIcon?: string | null;
}

export function getMemoAgentRoleName(
  properties: Record<string, unknown> | undefined,
): string | null {
  const value = properties?.["agent-role"];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function getMemoIconValue(
  memoIcon: string | null | undefined,
  properties: Record<string, unknown> | undefined,
): string | null {
  const value = properties?.icon;
  if (typeof value === "string" && value.trim()) return value.trim();
  return typeof memoIcon === "string" && memoIcon.trim()
    ? memoIcon.trim()
    : null;
}

function getIconText(value: string): string {
  return Array.from(value.trim())[0] ?? "";
}

export function appendRoleIconContent(
  target: HTMLElement,
  icon: string,
  label: string,
): boolean {
  const memoIcon = icon.trim();
  if (!memoIcon) return false;

  const propertyIcon = getPropertyIconOption(memoIcon);
  if (propertyIcon) {
    const image = document.createElement("img");
    image.src = propertyIcon.src;
    image.alt = "";
    image.draggable = false;
    target.append(image);
    return true;
  }

  const iconMarkup = getNotebookIconMarkup(memoIcon);
  if (iconMarkup) {
    target.classList.add("agent-thread-card__role-icon--svg");
    target.innerHTML = iconMarkup;
    return true;
  }

  target.textContent = getIconText(memoIcon || label);
  return true;
}
