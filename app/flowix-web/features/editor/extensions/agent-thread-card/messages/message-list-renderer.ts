import type { ThreadState } from "@features/agent/store/chat-store";
import type { AppLanguage } from "@features/i18n";
import {
  createAgentMessageViewModel,
  shouldRenderAgentMessage,
} from "@features/agent/message";
import {
  fillWithAgentThreadCardMarkdownHtml,
  renderAgentThreadCardMarkdownToHtml,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-markdown";
import { createAgentThreadCardMessageElement } from "@features/editor/extensions/agent-thread-card/messages/message-item-renderer";

export function getRenderedAgentMessages(
  messages: ThreadState["messages"],
): ThreadState["messages"] {
  return messages.filter(shouldRenderAgentMessage);
}

type AgentMessage = ThreadState["messages"][number];

export interface RenderedAgentMessageCache {
  list: HTMLDivElement | null;
  refs: ThreadState["messages"];
}

export interface AgentThreadCardMessageRenderContext {
  language: AppLanguage;
  getReasoningCollapsed: (message: AgentMessage) => boolean;
  setReasoningCollapsed: (messageId: string, collapsed: boolean) => void;
}

export interface AgentThreadCardMessagePatchOptions {
  body: HTMLElement;
  cache: RenderedAgentMessageCache;
  context: AgentThreadCardMessageRenderContext;
  afterRender: () => void;
}

export function patchLastRenderedAgentMessage(
  messages: ThreadState["messages"],
  options: AgentThreadCardMessagePatchOptions,
): ThreadState["messages"] | null {
  const { body, cache, context, afterRender } = options;
  const list = cache.list;
  if (!list || !body.contains(list)) return null;

  const renderedMessages = getRenderedAgentMessages(messages);
  if (
    renderedMessages.length === 0 ||
    renderedMessages.length !== cache.refs.length ||
    list.children.length !== renderedMessages.length
  ) {
    return null;
  }

  for (let i = 0; i < renderedMessages.length - 1; i += 1) {
    if (renderedMessages[i] !== cache.refs[i]) return null;
  }

  const previousLast = cache.refs[renderedMessages.length - 1];
  const nextLast = renderedMessages[renderedMessages.length - 1];
  if (
    previousLast === nextLast ||
    previousLast.id !== nextLast.id ||
    previousLast.role !== nextLast.role
  ) {
    return null;
  }

  const item = list.lastElementChild as HTMLDivElement | null;
  if (!item) return null;

  const messageView = createAgentMessageViewModel(nextLast, context.language);
  if (nextLast.role === "assistant" || nextLast.role === "user") {
    const content = item.querySelector<HTMLElement>(
      ".agent-thread-card__message-content",
    );
    if (!content) return null;
    fillWithAgentThreadCardMarkdownHtml(
      content,
      renderAgentThreadCardMarkdownToHtml(messageView.visibleContent),
    );
  } else if (nextLast.role === "reasoning") {
    const label = item.querySelector<HTMLSpanElement>(
      ".agent-thread-card__message-reasoning-header span",
    );
    const content = item.querySelector<HTMLElement>(
      ".agent-thread-card__message-content",
    );
    if (!label || !content) return null;
    label.textContent = messageView.reasoningLabel;
    item.classList.toggle(
      "agent-thread-card__message--reasoning-collapsed",
      context.getReasoningCollapsed(nextLast),
    );
    fillWithAgentThreadCardMarkdownHtml(
      content,
      renderAgentThreadCardMarkdownToHtml(messageView.visibleContent),
    );
  } else if (nextLast.role === "end") {
    const content = item.querySelector<HTMLElement>(
      ".agent-thread-card__message-content",
    );
    if (!content) return null;
    content.textContent = messageView.visibleContent;
  } else {
    return null;
  }

  afterRender();
  return [...cache.refs.slice(0, -1), nextLast];
}

export function appendRenderedAgentMessagesToTail(
  messages: ThreadState["messages"],
  options: AgentThreadCardMessagePatchOptions,
): ThreadState["messages"] | null {
  const { body, cache, context, afterRender } = options;
  const oldRefs = cache.refs;
  const list = cache.list;
  if (oldRefs.length === 0) return null;
  if (!list || !body.contains(list)) return null;

  const newRendered = getRenderedAgentMessages(messages);
  if (newRendered.length <= oldRefs.length) return null;
  if (list.children.length !== oldRefs.length) return null;

  for (let i = 0; i < oldRefs.length; i += 1) {
    if (newRendered[i] !== oldRefs[i]) return null;
  }

  const appended = newRendered.slice(oldRefs.length);
  let appendedCount = 0;
  for (const message of appended) {
    const rendered = createAgentThreadCardMessageElement({
      message,
      language: context.language,
      getReasoningCollapsed: context.getReasoningCollapsed,
      setReasoningCollapsed: context.setReasoningCollapsed,
    });
    if (!rendered) continue;
    list.append(rendered.element);
    appendedCount += 1;
  }

  if (appendedCount === 0) return null;
  afterRender();
  return newRendered;
}

export function createRenderedAgentMessageList(
  messages: ThreadState["messages"],
  context: AgentThreadCardMessageRenderContext,
): {
  list: HTMLDivElement;
  rememberedMessages: ThreadState["messages"];
} {
  const list = document.createElement("div");
  list.className = "agent-thread-card__messages";
  const rememberedMessages: ThreadState["messages"] = [];

  for (const message of messages) {
    const rendered = createAgentThreadCardMessageElement({
      message,
      language: context.language,
      getReasoningCollapsed: context.getReasoningCollapsed,
      setReasoningCollapsed: context.setReasoningCollapsed,
    });
    if (!rendered) continue;
    if (rendered.shouldRemember) rememberedMessages.push(message);
    list.append(rendered.element);
  }

  return { list, rememberedMessages };
}
