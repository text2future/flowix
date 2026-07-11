import type { ThreadState } from "@features/agent/store/chat-store";
import type { AppLanguage, I18nKey } from "@features/i18n";
import type { AgentTypeKey } from "@/types/agent";
import { getAgentType } from "@/lib/agent-types";
import {
  appendRenderedAgentMessagesToTail,
  createRenderedAgentMessageList,
  getRenderedAgentMessages,
  patchLastRenderedAgentMessage,
  type AgentThreadCardMessageRenderContext,
} from "@features/editor/extensions/agent-thread-card/messages/message-list-renderer";
import { recordMessageRenderPlan } from "@features/editor/extensions/agent-thread-card/messages/message-render-plan";
import {
  MessageViewportController,
  type MessageRenderScrollOptions,
} from "@features/editor/extensions/agent-thread-card/messages/message-viewport-controller";

type AgentMessage = ThreadState["messages"][number];

export interface ThreadMessageRenderControllerOptions {
  body: HTMLElement;
  loadingIndicator: HTMLDivElement;
  messageViewport: MessageViewportController;
  getLanguage: () => AppLanguage;
  getTypeKey: () => AgentTypeKey;
  t: (key: I18nKey) => string;
  createThreadCacheSkeleton: () => HTMLDivElement;
  createExternalAgentEmptySettings: () => HTMLElement;
}

export interface ThreadMessageRenderInput {
  messages: ThreadState["messages"];
  isLoading: boolean;
  shouldRenderMessages: boolean;
  isThreadCachePresentationHidden: boolean;
  isThreadCacheLoading: boolean;
}

export class ThreadMessageRenderController {
  private readonly body: HTMLElement;
  private readonly loadingIndicator: HTMLDivElement;
  private readonly messageViewport: MessageViewportController;
  private readonly getLanguage: () => AppLanguage;
  private readonly getTypeKey: () => AgentTypeKey;
  private readonly t: (key: I18nKey) => string;
  private readonly createThreadCacheSkeleton: () => HTMLDivElement;
  private readonly createExternalAgentEmptySettings: () => HTMLElement;
  private renderedMessagesList: HTMLDivElement | null = null;
  private renderedMessageRefs: ThreadState["messages"] = [];
  private reasoningCollapsedOverrides = new Map<string, boolean>();

  constructor(options: ThreadMessageRenderControllerOptions) {
    this.body = options.body;
    this.loadingIndicator = options.loadingIndicator;
    this.messageViewport = options.messageViewport;
    this.getLanguage = options.getLanguage;
    this.getTypeKey = options.getTypeKey;
    this.t = options.t;
    this.createThreadCacheSkeleton = options.createThreadCacheSkeleton;
    this.createExternalAgentEmptySettings =
      options.createExternalAgentEmptySettings;
  }

  render(input: ThreadMessageRenderInput): void {
    const scrollState = this.messageViewport.captureRenderScrollState();
    this.renderLoadingIndicator(input.isLoading);

    if (!input.shouldRenderMessages) {
      recordMessageRenderPlan("hidden", input.messages.length);
      this.body.replaceChildren();
      this.resetRenderedMessageCache();
      this.messageViewport.resetForHiddenMessages();
      return;
    }

    this.pruneReasoningCollapsedOverrides(input.messages);

    if (this.canReuseRenderedMessages(input.messages)) {
      recordMessageRenderPlan("noop", input.messages.length);
      return;
    }

    if (
      this.tryPatchLastRenderedMessage(input.messages, {
        isLoading: input.isLoading,
        ...scrollState,
      })
    ) {
      recordMessageRenderPlan("patch-last", input.messages.length);
      return;
    }

    if (
      this.tryAppendMessagesToTail(input.messages, {
        isLoading: input.isLoading,
        ...scrollState,
      })
    ) {
      recordMessageRenderPlan("append-tail", input.messages.length);
      return;
    }

    this.body.replaceChildren();

    if (input.messages.length === 0) {
      this.renderEmptyState(input);
      return;
    }

    recordMessageRenderPlan("replace-all", input.messages.length);
    const { list, rememberedMessages } = createRenderedAgentMessageList(
      input.messages,
      this.createMessageRenderContext(),
    );

    this.body.append(list, this.loadingIndicator);
    this.rememberRenderedMessages(list, rememberedMessages);
    this.applyBodyScrollAfterRender({
      isLoading: input.isLoading,
      ...scrollState,
    });
  }

  private renderEmptyState(input: ThreadMessageRenderInput): void {
    recordMessageRenderPlan("replace-empty", input.messages.length);
    this.resetRenderedMessageCache();

    if (input.isThreadCachePresentationHidden) {
      this.body.append(this.createThreadCacheSkeleton(), this.loadingIndicator);
      this.messageViewport.resetForEmptyMessages();
      return;
    }

    const typeKey = this.getTypeKey();
    const empty =
      (typeKey === "codex" || typeKey === "claude" || typeKey === "hermes") &&
      !input.isThreadCacheLoading
        ? this.createExternalAgentEmptySettings()
        : document.createElement("div");
    if (!empty.classList.contains("agent-thread-card__empty")) {
      empty.className = "agent-thread-card__empty";
      empty.textContent = input.isThreadCacheLoading
        ? this.t("editor.threadCard.loadingThreadCache")
        : this.t("editor.threadCard.empty");
    }
    this.body.append(empty, this.loadingIndicator);
    this.messageViewport.resetForEmptyMessages();
  }

  private renderLoadingIndicator(isLoading: boolean): void {
    const loadingText = this.loadingIndicator.querySelector<HTMLSpanElement>(
      ".agent-thread-card__loading-text",
    );
    const loadingDot = this.loadingIndicator.querySelector<HTMLSpanElement>(
      ".agent-thread-card__loading-dot",
    );
    if (loadingText) {
      loadingText.textContent = getAgentType(this.getTypeKey()).capabilities
        .supportsTextStreaming
        ? this.t("editor.threadCard.thinking")
        : this.t("editor.threadCard.running");
      loadingText.hidden = !isLoading;
    }
    if (loadingDot) loadingDot.hidden = !isLoading;
  }

  private resetRenderedMessageCache(): void {
    this.renderedMessagesList = null;
    this.renderedMessageRefs = [];
  }

  private rememberRenderedMessages(
    list: HTMLDivElement,
    messages: ThreadState["messages"],
  ): void {
    this.renderedMessagesList = list;
    this.renderedMessageRefs = messages;
  }

  private pruneReasoningCollapsedOverrides(
    messages: ThreadState["messages"],
  ): void {
    if (this.reasoningCollapsedOverrides.size === 0) return;

    const visibleReasoningIds = new Set(
      messages
        .filter((message) => message.role === "reasoning")
        .map((message) => message.id),
    );

    for (const id of this.reasoningCollapsedOverrides.keys()) {
      if (!visibleReasoningIds.has(id)) {
        this.reasoningCollapsedOverrides.delete(id);
      }
    }
  }

  private getReasoningCollapsed(message: AgentMessage): boolean {
    return (
      this.reasoningCollapsedOverrides.get(message.id) ?? !!message.isCompleted
    );
  }

  private createMessageRenderContext(): AgentThreadCardMessageRenderContext {
    return {
      language: this.getLanguage(),
      getReasoningCollapsed: (message) => this.getReasoningCollapsed(message),
      setReasoningCollapsed: (messageId, collapsed) => {
        this.reasoningCollapsedOverrides.set(messageId, collapsed);
      },
    };
  }

  private canReuseRenderedMessages(messages: ThreadState["messages"]): boolean {
    const list = this.renderedMessagesList;
    if (!list || !this.body.contains(list)) return false;
    const renderedMessages = getRenderedAgentMessages(messages);
    if (
      renderedMessages.length !== this.renderedMessageRefs.length ||
      list.children.length !== renderedMessages.length
    ) {
      return false;
    }
    for (let i = 0; i < renderedMessages.length; i += 1) {
      if (renderedMessages[i] !== this.renderedMessageRefs[i]) return false;
    }
    return true;
  }

  private tryPatchLastRenderedMessage(
    messages: ThreadState["messages"],
    options: MessageRenderScrollOptions,
  ): boolean {
    const nextRefs = patchLastRenderedAgentMessage(messages, {
      body: this.body,
      cache: {
        list: this.renderedMessagesList,
        refs: this.renderedMessageRefs,
      },
      context: this.createMessageRenderContext(),
      afterRender: () => this.applyBodyScrollAfterRender(options),
    });
    if (!nextRefs) return false;
    this.renderedMessageRefs = nextRefs;
    return true;
  }

  private tryAppendMessagesToTail(
    messages: ThreadState["messages"],
    options: MessageRenderScrollOptions,
  ): boolean {
    const nextRefs = appendRenderedAgentMessagesToTail(messages, {
      body: this.body,
      cache: {
        list: this.renderedMessagesList,
        refs: this.renderedMessageRefs,
      },
      context: this.createMessageRenderContext(),
      afterRender: () => this.applyBodyScrollAfterRender(options),
    });
    if (!nextRefs) return false;
    this.renderedMessageRefs = nextRefs;
    return true;
  }

  private applyBodyScrollAfterRender(options: MessageRenderScrollOptions): void {
    this.messageViewport.applyAfterRender(options);
  }
}
