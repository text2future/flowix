import type { ThreadState } from "@features/agent/store/thread-runtime-state";
import type {
  AgentMessage,
  AgentThreadCardMessageRenderContext,
} from "@features/agent/thread-card/messages/message-render-context";
export type {
  AgentMessage,
  AgentThreadCardMessageRenderContext,
} from "@features/agent/thread-card/messages/message-render-context";
import {
  createAgentMessageViewModel,
  shouldRenderAgentMessage,
} from "@features/agent/message";
import {
  createAgentThreadCardMessageElement,
  attachMessageActions,
  renderAgentThreadCardBudgetedMarkdown,
} from "@features/agent/thread-card/messages/message-item-renderer";
import {
  createToolGroupElement,
  updateToolGroupElement,
} from "@features/agent/thread-card/messages/tool-group-renderer";
import {
  areAgentRenderItemsEqual,
  groupAgentMessages,
  type AgentRenderItem,
} from "@features/agent/thread-card/messages/tool-grouping";

export function getRenderedAgentMessages(
  messages: ThreadState["messages"],
): ThreadState["messages"] {
  return messages.filter(shouldRenderAgentMessage);
}

export interface RenderedAgentMessageCache {
  list: HTMLDivElement | null;
  refs: AgentRenderItem[];
}

export function getRenderedAgentItems(
  messages: ThreadState["messages"],
  isLoading = false,
): AgentRenderItem[] {
  return groupAgentMessages(messages, isLoading).filter(
    (item) => item.kind === "tool-group" || shouldRenderAgentMessage(item.message),
  );
}

/**
 * Returns whether a message belongs to the turn currently being submitted.
 *
 * Codex rows are grouped by their provider turn id when one is available.
 * Other agents do not expose that id, so their latest user row is the turn
 * boundary and all following rows belong to that turn until another user row
 * is appended.
 */
export function isCurrentTurnMessage(
  message: AgentMessage,
  messages: ThreadState["messages"],
): boolean {
  const index = messages.indexOf(message);
  if (index < 0) return false;

  let latestUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      latestUserIndex = i;
      break;
    }
  }

  // A live stream can briefly contain provider rows before its user row is
  // projected. In that state there is no historical boundary to preserve;
  // use the newest known Codex turn id when possible and otherwise treat the
  // available rows as the current turn.
  if (latestUserIndex < 0) {
    if (!message.codexTurnId) return true;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].codexTurnId) {
        return messages[i].codexTurnId === message.codexTurnId;
      }
    }
    return true;
  }

  if (index < latestUserIndex) return false;

  const latestUser = messages[latestUserIndex];
  let currentTurnId = latestUser.codexTurnId;
  if (!currentTurnId) {
    // The optimistic user row may not have adopted the provider id yet. A
    // later Codex row in the same user-delimited segment can still establish
    // the current turn id.
    for (let i = messages.length - 1; i >= latestUserIndex; i -= 1) {
      if (messages[i].codexTurnId) {
        currentTurnId = messages[i].codexTurnId;
        break;
      }
    }
  }

  // Missing ids on reasoning/tool rows are expected in the projected Codex
  // state. The user boundary still keeps those rows in the current turn.
  if (currentTurnId && message.codexTurnId) {
    return currentTurnId === message.codexTurnId;
  }
  return true;
}

export function isLastMessageInTurnAndAssistant(
  messages: ThreadState["messages"],
  index: number,
): boolean {
  const message = messages[index];
  if (message.role !== "assistant") return false;

  // A later user row always starts another turn, regardless of whether its
  // provider metadata has arrived yet.
  for (let i = index + 1; i < messages.length; i += 1) {
    const laterMessage = messages[i];
    if (laterMessage.role === "user") break;

    // Codex turn ids are authoritative when both rows provide one. Rows
    // without an id are tolerated inside the user-delimited turn because
    // reasoning/tool rows may omit the id. Any such later row still means
    // that this assistant is not the final message of the turn.
    if (
      message.codexTurnId &&
      laterMessage.codexTurnId &&
      laterMessage.codexTurnId !== message.codexTurnId
    ) {
      break;
    }
    return false;
  }
  return message.isCompleted !== false;
}

export function shouldShowMessageActions(
  message: AgentMessage,
  messages: ThreadState["messages"],
  isLoading: boolean,
): boolean {
  const index = messages.indexOf(message);
  return (
    isLastMessageInTurnAndAssistant(messages, index) &&
    !(isLoading && isCurrentTurnMessage(message, messages))
  );
}

function syncMessageActions(
  messages: ThreadState["messages"],
  list: HTMLDivElement,
  context: AgentThreadCardMessageRenderContext,
): void {
  const renderItems = getRenderedAgentItems(messages, context.isLoading);
  for (let index = 0; index < renderItems.length; index += 1) {
    const renderItem = renderItems[index];
    if (renderItem.kind !== "message") continue;
    const message = renderItem.message;
    const item = list.children[index] as HTMLDivElement | undefined;
    if (!item || message.role !== "assistant") continue;

    // During a live turn only the current turn is provisional. Completed
    // historical turns keep their actions available.
    const shouldShow = shouldShowMessageActions(
      message,
      messages,
      context.isLoading,
    );
    const actions = item.querySelector<HTMLElement>(
      ".agent-thread-card__message-actions",
    );
    if (shouldShow && !actions) {
      attachMessageActions(
        item,
        message,
        createAgentMessageViewModel(message, context.language),
        context.language,
        true,
        context.onForkMessage,
      );
    } else if (!shouldShow && actions) {
      actions.remove();
    }
  }
}

export interface AgentThreadCardMessagePatchOptions {
  body: HTMLElement;
  cache: RenderedAgentMessageCache;
  context: AgentThreadCardMessageRenderContext;
  afterRender: () => void;
  /**
   * 绕过末条引用相等短路 ── run 结束下降沿(isLoading true->false)时末条引用未变,
   * 但仍需 forceFinalize 全量 re-parse 修正流式期间块切分。仅 controller 在
   * loadingJustEnded + canReuse 时传 true。
   */
  force?: boolean;
}

function isSameToolGroup(
  left: AgentRenderItem | undefined,
  right: AgentRenderItem | undefined,
): boolean {
  return Boolean(
    left?.kind === "tool-group" &&
      right?.kind === "tool-group" &&
      left.id === right.id,
  );
}

function updateChangedToolGroups(
  nextItems: AgentRenderItem[],
  previousItems: AgentRenderItem[],
  list: HTMLDivElement,
  context: AgentThreadCardMessageRenderContext,
): boolean | null {
  if (nextItems.length < previousItems.length) return null;
  if (list.children.length < previousItems.length) return null;

  let changed = false;
  for (let index = 0; index < previousItems.length; index += 1) {
    const previous = previousItems[index];
    const next = nextItems[index];
    if (areAgentRenderItemsEqual(previous, next)) continue;
    if (!isSameToolGroup(previous, next)) return null;
    changed = true;
  }

  if (!changed) return false;

  for (let index = 0; index < previousItems.length; index += 1) {
    const previous = previousItems[index];
    const next = nextItems[index];
    if (areAgentRenderItemsEqual(previous, next) || !isSameToolGroup(previous, next)) {
      continue;
    }
    const nextGroup = next.kind === "tool-group" ? next : null;
    const element = list.children[index] as HTMLElement | undefined;
    if (
      !element ||
      !nextGroup ||
      !updateToolGroupElement(element, { group: nextGroup, context })
    ) {
      return null;
    }
  }
  return true;
}

export function updateRenderedAgentToolGroups(
  messages: ThreadState["messages"],
  options: AgentThreadCardMessagePatchOptions,
): AgentRenderItem[] | null {
  const { body, cache, context, afterRender } = options;
  const list = cache.list;
  if (!list || !body.contains(list)) return null;

  const nextItems = getRenderedAgentItems(messages, context.isLoading);
  if (
    nextItems.length !== cache.refs.length ||
    list.children.length !== cache.refs.length
  ) {
    return null;
  }

  if (!updateChangedToolGroups(nextItems, cache.refs, list, context)) {
    return null;
  }
  afterRender();
  return nextItems;
}

export function patchLastRenderedAgentMessage(
  messages: ThreadState["messages"],
  options: AgentThreadCardMessagePatchOptions,
): AgentRenderItem[] | null {
  const { body, cache, context, afterRender } = options;
  const list = cache.list;
  if (!list || !body.contains(list)) return null;

  const renderItems = getRenderedAgentItems(messages, context.isLoading);
  if (
    renderItems.length === 0 ||
    renderItems.length !== cache.refs.length ||
    list.children.length !== renderItems.length
  ) {
    return null;
  }

  for (let i = 0; i < renderItems.length - 1; i += 1) {
    if (!areAgentRenderItemsEqual(renderItems[i], cache.refs[i])) return null;
  }

  const previousLast = cache.refs[renderItems.length - 1];
  const nextLast = renderItems[renderItems.length - 1];
  if (previousLast.kind !== "message" || nextLast.kind !== "message") {
    return null;
  }
  const previousLastMessage = previousLast.message;
  const nextLastMessage = nextLast.message;
  if (
    !options.force &&
    (previousLastMessage === nextLastMessage ||
      previousLastMessage.id !== nextLastMessage.id ||
      previousLastMessage.role !== nextLastMessage.role)
  ) {
    return null;
  }

  const item = list.lastElementChild as HTMLDivElement | null;
  if (!item) return null;

  const message = nextLastMessage;
  const messageView = createAgentMessageViewModel(message, context.language);
  if (message.role === "assistant" || message.role === "user") {
    const content = item.querySelector<HTMLElement>(
      ".agent-thread-card__message-content",
    );
    if (!content) return null;
    renderAgentThreadCardBudgetedMarkdown({
      message,
      role: message.role,
      visibleContent: messageView.visibleContent,
      content,
      toggleParent: item,
      context,
      isStreaming: context.isStreaming(message),
    });
  } else if (message.role === "reasoning") {
    const label = item.querySelector<HTMLSpanElement>(
      ".agent-thread-card__message-reasoning-header span",
    );
    const content = item.querySelector<HTMLElement>(
      ".agent-thread-card__message-content",
    );
    if (!label || !content) return null;
    label.textContent = messageView.reasoningLabel;
    const collapsed = context.getReasoningCollapsed(message);
    item.classList.toggle(
      "agent-thread-card__message--reasoning-collapsed",
      collapsed,
    );
    const body = item.querySelector<HTMLElement>(
      ".agent-thread-card__message-reasoning-body",
    );
    if (!body) return null;
    if (!collapsed) {
      renderAgentThreadCardBudgetedMarkdown({
        message,
        role: "reasoning",
        visibleContent: messageView.visibleContent,
        content,
        toggleParent: body,
        context,
        isStreaming: context.isStreaming(message),
      });
    }
  } else if (message.role === "end") {
    const content = item.querySelector<HTMLElement>(
      ".agent-thread-card__message-content",
    );
    if (!content) return null;
    content.textContent = messageView.visibleContent;
  } else {
    return null;
  }

  syncMessageActions(messages, list, context);
  afterRender();
  return [...cache.refs.slice(0, -1), nextLast];
}

export function appendRenderedAgentMessagesToTail(
  messages: ThreadState["messages"],
  options: AgentThreadCardMessagePatchOptions,
): AgentRenderItem[] | null {
  const { body, cache, context, afterRender } = options;
  const oldRefs = cache.refs;
  const list = cache.list;
  if (oldRefs.length === 0) return null;
  if (!list || !body.contains(list)) return null;

  const newRendered = getRenderedAgentItems(messages, context.isLoading);
  if (newRendered.length <= oldRefs.length) return null;
  if (list.children.length !== oldRefs.length) return null;

  const updatedToolGroups = updateChangedToolGroups(
    newRendered,
    oldRefs,
    list,
    context,
  );
  if (updatedToolGroups === null) return null;

  const appended = newRendered.slice(oldRefs.length);
  let appendedCount = 0;
  for (const renderItem of appended) {
    const rendered = renderItem.kind === "tool-group"
      ? { element: createToolGroupElement({ group: renderItem, context }), shouldRemember: false }
      : createAgentThreadCardMessageElement({
          message: renderItem.message,
          language: context.language,
          getReasoningCollapsed: context.getReasoningCollapsed,
          setReasoningCollapsed: context.setReasoningCollapsed,
          getDisplayExpanded: context.getDisplayExpanded,
          setDisplayExpanded: context.setDisplayExpanded,
          isStreaming: context.isStreaming(renderItem.message),
          showActions: shouldShowMessageActions(
            renderItem.message,
            messages,
            context.isLoading,
          ),
          canFork: isLastMessageInTurnAndAssistant(
            messages,
            messages.indexOf(renderItem.message),
          ),
          onForkMessage: context.onForkMessage,
        });
    if (!rendered) continue;
    list.append(rendered.element);
    appendedCount += 1;
  }

  if (appendedCount === 0) return null;
  syncMessageActions(messages, list, context);
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

  const renderItems = getRenderedAgentItems(messages, context.isLoading);
  for (let index = 0; index < renderItems.length; index += 1) {
    const renderItem = renderItems[index];
    const rendered = renderItem.kind === "tool-group"
      ? { element: createToolGroupElement({ group: renderItem, context }), shouldRemember: false }
      : createAgentThreadCardMessageElement({
          message: renderItem.message,
          language: context.language,
          getReasoningCollapsed: context.getReasoningCollapsed,
          setReasoningCollapsed: context.setReasoningCollapsed,
          getDisplayExpanded: context.getDisplayExpanded,
          setDisplayExpanded: context.setDisplayExpanded,
          isStreaming: context.isStreaming(renderItem.message),
          showActions: shouldShowMessageActions(
            renderItem.message,
            messages,
            context.isLoading,
          ),
          canFork: isLastMessageInTurnAndAssistant(
            messages,
            messages.indexOf(renderItem.message),
          ),
          onForkMessage: context.onForkMessage,
        });
    if (!rendered) continue;
    if (rendered.shouldRemember && renderItem.kind === "message") {
      rememberedMessages.push(renderItem.message);
    }
    list.append(rendered.element);
  }

  syncMessageActions(messages, list, context);

  return { list, rememberedMessages };
}
