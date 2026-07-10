import type { AgentAccessEntry } from "@/lib/types/agent-access";
import { getNotebookIconMarkup } from "@features/memo/components/notebook-icon";
import {
  createAlertIcon,
  createFolderIcon,
  createLaptopIcon,
  createTrashIcon,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-icons";

type NotebookLike = {
  id: string;
  icon?: string | null;
};

export interface CreateAccessEntryRowOptions {
  entry: AgentAccessEntry;
  notebooks: NotebookLike[];
  t: (key: string) => string;
  toggle: (id: string) => Promise<void>;
  removeFolder: (id: string) => Promise<void>;
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

export function createAccessEntryRow({
  entry,
  notebooks,
  t,
  toggle,
  removeFolder,
}: CreateAccessEntryRowOptions): HTMLElement {
  const isNotebook = entry.kind === "notebook";
  const notebook = isNotebook
    ? notebooks.find((item) => item.id === entry.id)
    : null;
  const isWorkspace = Boolean(entry.workspace);
  const row = document.createElement("div");
  row.className = "agent-thread-card__access-row";
  row.title = entry.missing ? t("agent.access.pathMissing") : entry.path;
  if (entry.missing) {
    row.classList.add("agent-thread-card__access-row--disabled");
  }
  row.addEventListener("click", () => {
    if (entry.missing) return;
    void toggle(entry.id);
  });

  const avatar = document.createElement("span");
  avatar.className = "agent-thread-card__access-avatar";
  if (isNotebook) {
    const iconMarkup = getNotebookIconMarkup(notebook?.icon);
    if (iconMarkup) {
      avatar.classList.add("agent-thread-card__access-avatar--icon");
      avatar.innerHTML = iconMarkup;
    } else {
      avatar.textContent = getAccessEntryLetter(entry.name);
    }
  } else if (isWorkspace) {
    avatar.classList.add("agent-thread-card__access-avatar--workspace");
    avatar.append(createLaptopIcon());
  } else {
    avatar.append(createFolderIcon());
  }

  const nameWrap = document.createElement("span");
  nameWrap.className = "agent-thread-card__access-name-wrap";

  const name = document.createElement("span");
  name.className = "agent-thread-card__access-name";
  name.textContent = entry.name;
  nameWrap.append(name);

  if (entry.missing) {
    nameWrap.append(createAlertIcon());
  }
  row.append(avatar, nameWrap);

  if (!isNotebook) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "agent-thread-card__access-remove";
    remove.setAttribute("aria-label", t("agent.access.deleteFolder"));
    remove.append(createTrashIcon());
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void removeFolder(entry.id);
    });
    row.append(remove);
  }

  const checkbox = document.createElement("button");
  checkbox.type = "button";
  checkbox.className = "agent-thread-card__access-checkbox";
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
  checkbox.addEventListener("click", (event) => {
    event.stopPropagation();
    void toggle(entry.id);
  });
  row.append(checkbox);

  return row;
}
