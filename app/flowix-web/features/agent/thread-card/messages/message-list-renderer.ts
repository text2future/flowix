import { createMessageActionStates } from "./message-action-state";
export { isCurrentTurnMessage, isLastMessageInTurnAndAssistant, shouldShowMessageActions } from "./message-action-state";
import { messageRenderKey } from "@features/agent/message/render-identity";
import type { ThreadState } from "@features/agent/store/thread-runtime-state";
import type {
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
  disposeAgentThreadCardMessageTree,
  renderAgentThreadCardBudgetedMarkdown,
} from "@features/agent/thread-card/messages/message-item-renderer";
import {
  createToolGroupElement,
  updateToolGroupElement,
} from "@features/agent/thread-card/messages/tool-group-renderer";
import { createGeneratedImageStrip } from "@features/agent/thread-card/messages/generated-image-strip";
import {
  areAgentRenderItemsEqual,
  groupAgentMessages,
  type AgentRenderItem,
} from "@features/agent/thread-card/messages/tool-grouping";

// Node-owned metadata survives reordering and excludes cloned/foreign DOM rows.
const renderedItemByElement = new WeakMap<HTMLElement, AgentRenderItem>();

export function getRenderedAgentMessages(
  messages: ThreadState["messages"],
): ThreadState["messages"] {
  return messages.filter(shouldRenderAgentMessage);
}

export interface RenderedAgentMessageCache {
  list: HTMLDivElement | null;
  refs: AgentRenderItem[];
}

function agentRenderItemKey(item: AgentRenderItem): string {
  return item.kind === "message"
    ? `message:${messageRenderKey(item.message)}` : `${item.kind}:${item.id}`;
}

export function getRenderedAgentItems(
  messages: ThreadState["messages"],
  isLoading = false,
): AgentRenderItem[] {
  const seen = new Set<string>();
  return groupAgentMessages(messages, isLoading).filter((item) => {
    if (item.kind === "message" && !shouldRenderAgentMessage(item.message)) return false;
    const key = agentRenderItemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withMessageActions(messages: ThreadState["messages"], context: AgentThreadCardMessageRenderContext): AgentThreadCardMessageRenderContext {
  return context.messageActions ? context : { ...context,
    messageActions: createMessageActionStates(messages, context.isLoading),
  };
}

/**
 * 同步 assistant 行的操作按钮 (复制 / fork)。
 *
 * `fromIndex` 让流式 patch 只处理真正可能变化的行 ── patch-last 只有末条会变,
 * append 也只有"上一条末行 + 新追加行"会变 (末行失去 last-in-turn, 新行获得)。
 * 之前每帧都对全表做一次 `querySelector`, 1000 条会话约 300 次查询/帧。
 */
function syncMessageActions(
  messages: ThreadState["messages"],
  list: HTMLDivElement,
  context: AgentThreadCardMessageRenderContext,
  fromIndex = 0,
): void {
  const renderItems = context.renderItems ?? getRenderedAgentItems(messages, context.isLoading);
  const actionsByMessage = context.messageActions ?? createMessageActionStates(messages, context.isLoading);
  for (let index = Math.max(0, fromIndex); index < renderItems.length; index += 1) {
    const renderItem = renderItems[index];
    if (renderItem.kind !== "message") continue;
    const message = renderItem.message;
    const item = list.children[index] as HTMLDivElement | undefined;
    if (!item || message.role !== "assistant") continue;

    // During a live turn only the current turn is provisional. Completed
    // historical turns keep their actions available.
    const shouldShow = actionsByMessage.get(message)?.showActions === true;
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
      disposeAgentThreadCardMessageTree(actions);
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
    renderedItemByElement.set(element, next);
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

  const nextItems = context.renderItems ?? getRenderedAgentItems(messages, context.isLoading);
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

  const renderItems = context.renderItems ?? getRenderedAgentItems(messages, context.isLoading);
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
      messageRenderKey(previousLastMessage) !== messageRenderKey(nextLastMessage) ||
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
    if (!content?.parentElement) return null;
    renderAgentThreadCardBudgetedMarkdown({
      message,
      role: message.role,
      visibleContent: messageView.visibleContent,
      content,
      // The toggle is a sibling of the content for both user bubbles and
      // assistant messages.
      toggleParent: content.parentElement,
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

  syncMessageActions(messages, list, context, renderItems.length - 1);
  renderedItemByElement.set(item, nextLast);
  afterRender();
  return [...cache.refs.slice(0, -1), nextLast];
}

export function appendRenderedAgentMessagesToTail(
  messages: ThreadState["messages"],
  options: AgentThreadCardMessagePatchOptions,
): AgentRenderItem[] | null {
  const { body, cache, afterRender } = options;
  const context = withMessageActions(messages, options.context);
  const oldRefs = cache.refs;
  const list = cache.list;
  if (oldRefs.length === 0) return null;
  if (!list || !body.contains(list)) return null;

  const newRendered = context.renderItems ?? getRenderedAgentItems(messages, context.isLoading);
  if (newRendered.length <= oldRefs.length) return null;
  if (list.children.length !== oldRefs.length) return null;

  const updatedToolGroups = updateChangedToolGroups(
    newRendered,
    oldRefs,
    list,
    context,
  );
  if (updatedToolGroups === null) return null;

  // The previous tail is no longer streaming once another row is appended.
  // Its message reference can remain unchanged, so reusing the row alone
  // would skip Markdown finalization and Shiki highlighting permanently.
  const previousTail = newRendered[oldRefs.length - 1];
  if (previousTail.kind === "message") {
    const message = previousTail.message;
    if (
      (message.role === "assistant" || message.role === "user" ||
        (message.role === "reasoning" && !context.getReasoningCollapsed(message))) &&
      !context.isStreaming(message)
    ) {
      const item = list.children[oldRefs.length - 1];
      const content = item.querySelector<HTMLElement>(".agent-thread-card__message-content");
      if (content?.parentElement) {
        renderAgentThreadCardBudgetedMarkdown({
          message,
          role: message.role,
          visibleContent: createAgentMessageViewModel(message, context.language).visibleContent,
          content,
          toggleParent: content.parentElement,
          context,
          isStreaming: false,
        });
      }
    }
  }

  const appended = newRendered.slice(oldRefs.length);
  let appendedCount = 0;
  for (const renderItem of appended) {
    const rendered = createAgentRenderItem(renderItem, messages, context);
    if (!rendered?.element) continue;
    list.append(rendered.element);
    appendedCount += 1;
  }

  if (appendedCount === 0) return null;
  // The previous tail stopped being the last row of its turn; every row before
  // it keeps its action state.
  syncMessageActions(messages, list, context, oldRefs.length - 1);
  afterRender();
  return newRendered;
}

export function createAgentRenderItem(
  renderItem: AgentRenderItem, messages: ThreadState["messages"],
  context: AgentThreadCardMessageRenderContext,
) {
  const actions = renderItem.kind === "message"
    ? (context.messageActions ?? createMessageActionStates(messages, context.isLoading)).get(renderItem.message)
    : undefined;
  const rendered = renderItem.kind === "tool-group"
      ? { element: createToolGroupElement({ group: renderItem, context }), shouldRemember: false }
      : renderItem.kind === "generated-images"
        ? {
            element: createGeneratedImageStrip({
              id: renderItem.id,
              images: renderItem.images,
              language: context.language,
              getImageSpacePath: context.getImageSpacePath,
            }),
            shouldRemember: false,
          }
      : createAgentThreadCardMessageElement({
          message: renderItem.message,
          language: context.language,
          getReasoningCollapsed: context.getReasoningCollapsed,
          setReasoningCollapsed: context.setReasoningCollapsed,
          getDisplayExpanded: context.getDisplayExpanded,
          setDisplayExpanded: context.setDisplayExpanded,
          isStreaming: context.isStreaming(renderItem.message),
          showActions: actions?.showActions,
          canFork: actions?.canFork,
          onForkMessage: context.onForkMessage,
        });
  if (rendered?.element) renderedItemByElement.set(rendered.element, renderItem);
  return rendered;
}

/** Reconcile existing DOM by stable identity. Unchanged rows, tool groups and
 * image strips stay mounted when an older turn is corrected or reordered. */
export function reconcileRenderedAgentMessages(
  messages: ThreadState["messages"], cache: RenderedAgentMessageCache,
  context: AgentThreadCardMessageRenderContext,
  preserveViewport?: HTMLElement,
): AgentRenderItem[] | null {
  context = withMessageActions(messages, context);
  const list = cache.list;
  if (!list) return null;
  const previous = new Map<string, { item: AgentRenderItem; element: HTMLElement }>();
  for (const child of Array.from(list.children)) {
    const element = child as HTMLElement;
    const item = renderedItemByElement.get(element);
    if (item) previous.set(agentRenderItemKey(item), { item, element });
  }
  const next = context.renderItems ?? getRenderedAgentItems(messages, context.isLoading);
  const elements: HTMLElement[] = [];
  for (const item of next) {
    const retained = previous.get(agentRenderItemKey(item));
    if (retained && areAgentRenderItemsEqual(retained.item, item)) {
      elements.push(retained.element);
    } else {
      const rendered = createAgentRenderItem(item, messages, context);
      if (rendered?.element) elements.push(rendered.element);
    }
  }
  // Measure only on structural reconciliation while the reader is detached.
  // Streaming tail updates retain their existing fast path without layout reads.
  const kept = new Set(elements);
  const viewportTop = preserveViewport?.getBoundingClientRect().top ?? 0;
  const anchor = preserveViewport ? Array.from(list.children).find((child) =>
    kept.has(child as HTMLElement) && child.getBoundingClientRect().bottom > viewportTop) : undefined;
  const anchorTop = anchor?.getBoundingClientRect().top;

  for (const child of Array.from(list.children)) {
    if (kept.has(child as HTMLElement)) continue;
    disposeAgentThreadCardMessageTree(child as HTMLElement);
    child.remove();
  }
  // Batch new rows off-DOM. Avoid repeatedly indexing a live HTMLCollection
  // while prepending a page, and leave retained rows attached throughout.
  let cursor = list.firstElementChild;
  const pending = document.createDocumentFragment();
  for (const element of elements) {
    if (element === cursor) {
      if (pending.childNodes.length) list.insertBefore(pending, cursor);
      cursor = cursor.nextElementSibling;
    } else if (element.parentElement === list) {
      if (pending.childNodes.length) list.insertBefore(pending, cursor);
      list.insertBefore(element, cursor);
    } else {
      pending.append(element);
    }
  }
  if (pending.childNodes.length) list.insertBefore(pending, cursor);
  syncMessageActions(messages, list, context);
  if (preserveViewport && anchor && anchorTop !== undefined) {
    const delta = anchor.getBoundingClientRect().top - anchorTop;
    if (Math.abs(delta) > 0.5) preserveViewport.scrollTop += delta;
  }
  return next;
}

export function createRenderedAgentMessageList(
  messages: ThreadState["messages"],
  context: AgentThreadCardMessageRenderContext,
): {
  list: HTMLDivElement;
  rememberedMessages: ThreadState["messages"];
} {
  context = withMessageActions(messages, context);
  const list = document.createElement("div");
  list.className = "agent-thread-card__messages";
  const rememberedMessages: ThreadState["messages"] = [];

  const renderItems = context.renderItems ?? getRenderedAgentItems(messages, context.isLoading);
  for (let index = 0; index < renderItems.length; index += 1) {
    const renderItem = renderItems[index];
    const rendered = createAgentRenderItem(renderItem, messages, context);
    if (!rendered?.element) continue;
    if (rendered.shouldRemember && renderItem.kind === "message") {
      rememberedMessages.push(renderItem.message);
    }
    list.append(rendered.element);
  }

  syncMessageActions(messages, list, context);

  return { list, rememberedMessages };
}
