import { useChatStore } from "@features/agent/store/chat-store";
import type { AgentTypeKey } from "@/types/agent";
import {
  getAgentType,
  normalizeAgentTypeKey,
} from "@/lib/agent-types";
import type { I18nKey } from "@features/i18n";
import { focusWithoutScroll } from "@features/editor/extensions/agent-thread-card/agent-thread-card-dom";

export interface AgentThreadCardTitleEditControllerOptions {
  titleEl: HTMLElement;
  getAttrTitle: () => string | null;
  getAttrTypeKey: () => string | null;
  getInstanceTitle: () => string | undefined;
  getThreadId: () => string | null;
  getInstanceId: () => string | null;
  getTypeKey: () => AgentTypeKey;
  updateAttrs: (attrs: Record<string, unknown>) => void;
  t: (key: I18nKey) => string;
}

export class AgentThreadCardTitleEditController {
  private readonly titleEl: HTMLElement;
  private readonly getAttrTitle: () => string | null;
  private readonly getAttrTypeKey: () => string | null;
  private readonly getInstanceTitle: () => string | undefined;
  private readonly getThreadId: () => string | null;
  private readonly getInstanceId: () => string | null;
  private readonly getTypeKey: () => AgentTypeKey;
  private readonly updateAttrs: (attrs: Record<string, unknown>) => void;
  private readonly t: (key: I18nKey) => string;
  private titleInput: HTMLInputElement | null = null;
  private titleBeforeEdit: string | null = null;

  constructor(options: AgentThreadCardTitleEditControllerOptions) {
    this.titleEl = options.titleEl;
    this.getAttrTitle = options.getAttrTitle;
    this.getAttrTypeKey = options.getAttrTypeKey;
    this.getInstanceTitle = options.getInstanceTitle;
    this.getThreadId = options.getThreadId;
    this.getInstanceId = options.getInstanceId;
    this.getTypeKey = options.getTypeKey;
    this.updateAttrs = options.updateAttrs;
    this.t = options.t;
  }

  get activeInput(): HTMLInputElement | null {
    return this.titleInput;
  }

  getTitle(): string {
    const attrTitle = (this.getAttrTitle() ?? "").trim();
    const attrTypeKey = normalizeAgentTypeKey(this.getAttrTypeKey());
    const instanceTitle = this.getInstanceTitle();
    if (
      instanceTitle &&
      !(attrTitle && this.isDefaultExternalTitle(instanceTitle, attrTypeKey))
    ) {
      return instanceTitle;
    }

    const threadId = this.getThreadId();
    if (threadId) {
      const state = useChatStore.getState();
      const listTitle = state.threadLists[attrTypeKey]?.find(
        (item) => item.threadId === threadId,
      )?.title;
      if (
        listTitle &&
        !(attrTitle && this.isDefaultExternalTitle(listTitle, attrTypeKey))
      ) {
        return listTitle;
      }
      if (state.activeThreadIds[attrTypeKey] === threadId) {
        const activeTitle = state.currentThreadTitles[attrTypeKey];
        if (
          activeTitle &&
          !(attrTitle && this.isDefaultExternalTitle(activeTitle, attrTypeKey))
        ) {
          return activeTitle;
        }
      }
    }

    return attrTitle;
  }

  syncTitleText(): void {
    if (this.titleInput) return;
    this.titleEl.textContent = this.getTitle();
  }

  startEdit(): void {
    if (this.titleInput) return;

    const currentTitle = this.getTitle();
    this.titleBeforeEdit = currentTitle;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "agent-thread-card__title-input";
    input.value = currentTitle;
    input.setAttribute("aria-label", "重命名对话");
    input.addEventListener("mousedown", (event) => event.stopPropagation());
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        void this.commitEdit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.cancelEdit();
      }
    });
    input.addEventListener("blur", () => {
      void this.commitEdit();
    });

    this.titleInput = input;
    this.titleEl.replaceChildren(input);
    focusWithoutScroll(input);
    input.select();
  }

  cancelEdit(): void {
    const previousTitle = this.titleBeforeEdit ?? this.getTitle();
    this.titleInput = null;
    this.titleBeforeEdit = null;
    this.titleEl.textContent = previousTitle;
  }

  private async commitEdit(): Promise<void> {
    const input = this.titleInput;
    if (!input) return;

    const previousTitle = this.titleBeforeEdit ?? this.getTitle();
    const nextTitle = input.value.replace(/\s+/g, " ").trim();
    this.titleInput = null;
    this.titleBeforeEdit = null;

    if (!nextTitle || nextTitle === previousTitle) {
      this.titleEl.textContent = previousTitle;
      return;
    }

    const threadId = this.getThreadId();
    const instanceId = this.getInstanceId();
    if (!threadId && !instanceId) {
      this.titleEl.textContent = previousTitle;
      return;
    }

    this.titleEl.textContent = nextTitle;
    this.updateAttrs({ title: nextTitle });

    await useChatStore.getState().renameAgentConversation({
      instanceId,
      threadId,
      title: nextTitle,
      typeKey: this.getTypeKey(),
    });
  }

  private isDefaultExternalTitle(title: string, typeKey: AgentTypeKey): boolean {
    const normalized = title.replace(/\s+/g, " ").trim().toLowerCase();
    if (!normalized) return false;
    if (typeKey === "codex") {
      return normalized === this.t("agent.codexSession.title").toLowerCase();
    }
    if (typeKey === "claude") {
      return normalized === this.t("agent.claudeSession.title").toLowerCase();
    }
    return normalized === `${getAgentType(typeKey).name} session`.toLowerCase();
  }
}
