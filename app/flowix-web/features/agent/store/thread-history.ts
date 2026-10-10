import { piRowIdentity, reconcilePiTimeline } from "@features/agent/store/pi-message-reconciliation";
import type { ChatMessage, ThreadListItem } from "@/types";
import type { AgentTypeKey } from "@/types/agent";
import { stripSystemBlock } from "@features/agent/message";
import { createAgentToolDisplay } from "@features/agent/tool-display";
import { isEmptyAssistantMessage } from "@features/agent/message";
import {
  attachHistoryCursor,
  getAgentHistoryAdapter,
  readHistoryPageWithCursor,
  type ThreadHistoryPage,
} from "@features/agent/store/agent-history-adapters";
import { completedRunUserMessageId } from "@features/agent/events/message-identity";

/** Layer 4: 单页轮次数. External adapters return complete turns; the
 * resulting message count is intentionally variable. */
export const HISTORY_PAGE_SIZE = 10;

export async function listHistoryThreads(
  type: AgentTypeKey,
): Promise<ThreadListItem[]> {
  return getAgentHistoryAdapter(type).listThreads();
}

export async function findHistoryThreadInfo(
  type: AgentTypeKey,
  threadId: string,
  currentList: ThreadListItem[],
): Promise<ThreadListItem | undefined> {
  return (
    currentList.find((item) => item.threadId === threadId) ??
    (await listHistoryThreads(type)).find((item) => item.threadId === threadId)
  );
}

export async function getHistoryPage(
  type: AgentTypeKey,
  threadId: string,
  limit: number,
  cursor?: string,
): Promise<ThreadHistoryPage> {
  if (cursor) return readHistoryPageWithCursor(type, threadId, cursor, limit, getAgentHistoryAdapter(type));
  const page = await getAgentHistoryAdapter(type).getInitialHistory(threadId, limit);
  return attachHistoryCursor(type, threadId, page);
}

export function filterRenderableHistoryMessages(
  messages: ChatMessage[],
): ChatMessage[] {
  return messages
    .filter((m) => !isEmptyAssistantMessage(m))
    .map((message) => {
      if (message.role !== "user") return message;
      const content = stripSystemBlock(message.content || "");
      return content === message.content ? message : { ...message, content };
    })
    .filter((message) => message.role !== "user" || message.content.trim() !== "");
}

// Cheap content fingerprint used as a Map key for dedup. Two independent
// FNV-1a 32-bit hashes combined give an effectively 64-bit collision space
// while walking each string only once with constant per-character work.
// Replaces JSON.stringify(content) which, on multi-MB assistant responses,
// allocated several MB of UTF-16 strings per message per streaming flush. Collisions
// remain theoretically possible but vanishingly unlikely for chat history;
// the dedup logic treats a collision as "duplicate, skip" which is benign.
function contentFingerprint(content: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  const prime1 = 0x01000193;
  const prime2 = 0x85ebca6b;
  for (let i = 0; i < content.length; i += 1) {
    const c = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, prime1);
    h2 = Math.imul(h2 ^ c, prime2);
  }
  return `${h1 >>> 0}:${h2 >>> 0}`;
}

function userMessageVisibleKey(message: ChatMessage): string | null {
  if (message.role !== "user") return null;
  return `user:visible:${contentFingerprint(stripSystemBlock(message.content || ""))}`;
}

/**
 * Compatibility fallback for provider histories whose user item id differs
 * from the optimistic row id. Prefer ids when available; content matching is
 * only used to detect that the latest cached turn has reached history.
 */
export function historyContainsCachedUser(
  history: ChatMessage[],
  cachedMessages: ChatMessage[],
): boolean {
  const historyUsers = history.filter((message) => message.role === "user");
  const cachedUsers = cachedMessages.filter((message) => message.role === "user");
  const historyUser = historyUsers[historyUsers.length - 1];
  const cachedUser = cachedUsers[cachedUsers.length - 1];
  if (historyUser && cachedUser && historyUser.id === cachedUser.id) return true;
  return (
    !!historyUser &&
    !!cachedUser &&
    userMessageVisibleKey(historyUser) === userMessageVisibleKey(cachedUser)
  );
}

/** True only when the persisted terminal window covers every visible live row. */
export function historyCoversLiveTurn(
  history: ChatMessage[],
  live: ChatMessage[],
): boolean {
  if (!historyContainsCachedUser(history, live)) return false;
  const historyToolIds = new Set(
    history
      .filter((message) => message.role === "tool" && message.toolCallId)
      .map((message) => toolCallIdentityKey(message.toolCallId!)),
  );
  const historyVisibleRows = new Map<string, number>();
  for (const message of history) {
    if (message.role !== "assistant" && message.role !== "reasoning") continue;
    const key = messageContentStableKey(message);
    if (key) historyVisibleRows.set(key, (historyVisibleRows.get(key) ?? 0) + 1);
  }
  for (const message of live) {
    if (message.role === "tool" && message.toolCallId) {
      if (!historyToolIds.has(toolCallIdentityKey(message.toolCallId))) return false;
      continue;
    }
    if (message.role !== "assistant" && message.role !== "reasoning") continue;
    const key = messageContentStableKey(message);
    if (!key) continue;
    const count = historyVisibleRows.get(key) ?? 0;
    if (count === 0) return false;
    historyVisibleRows.set(key, count - 1);
  }
  return true;
}

/** Release live cache only after stable identities and completed content agree.
 * Content-only matching remains a legacy display reconciliation aid, never a
 * persistence confirmation. */
export function historyConfirmsLiveMessages(
  history: ChatMessage[],
  live: ChatMessage[],
): boolean {
  if (live.length === 0) return false;
  const byId = new Map(history.map((message) => [message.id, message]));
  return live.every((message) => {
    const persisted = byId.get(message.id);
    return !!persisted &&
      persisted.role === message.role &&
      persisted.content === message.content &&
      persisted.llmContent === message.llmContent &&
      !persisted.isLoading &&
      (message.role !== "assistant" && message.role !== "reasoning" || persisted.isCompleted === true);
  });
}

function messageContentStableKey(message: ChatMessage): string | null {
  if (message.role === "user") return userMessageVisibleKey(message);
  if (
    message.role === "assistant" ||
    message.role === "reasoning" ||
    message.role === "end"
  ) {
    const content = (message.content || "").replace(/\r\n/g, "\n").trim();
    if (!content) return null;
    return `${message.role}:${contentFingerprint(content)}`;
  }
  if (message.role === "tool" && message.toolCallId) {
    return `tool:${message.toolCallId}:${contentFingerprint(message.content || "")}`;
  }
  return null;
}

function toolCallIdentityKey(toolCallId: string): string {
  const marker = ":tool-call:";
  const markerIndex = toolCallId.lastIndexOf(marker);
  return markerIndex >= 0 ? toolCallId.slice(markerIndex + marker.length) : toolCallId;
}

const messageIdentityKey = piRowIdentity;

export function hydrateToolDisplay(
  message: ChatMessage,
  agentType?: AgentTypeKey,
): ChatMessage {
  if (message.role !== "tool") return message;
  const toolAgentType = message.toolAgentType ?? agentType;
  if (message.toolDisplay && message.toolAgentType === toolAgentType)
    return message;
  let toolDisplay: ReturnType<typeof createAgentToolDisplay> = undefined;
  try {
    toolDisplay = createAgentToolDisplay({
      agentType: toolAgentType,
      toolName: message.toolName,
      input: message.toolInput,
    });
  } catch (err) {
    console.error("Failed to hydrate agent tool display:", err);
  }
  return toolDisplay || toolAgentType
    ? {
        ...message,
        toolAgentType,
        toolDisplay: toolDisplay ?? message.toolDisplay,
      }
    : message;
}

export function hydrateHistoricalMessages(
  messages: ChatMessage[],
  agentType?: AgentTypeKey,
): ChatMessage[] {
  return messages.map((message) => hydrateToolDisplay(message, agentType));
}

/**
 * Replace a projection with a complete provider snapshot. Unlike the normal
 * stale-while-revalidate merge, this deliberately drops rows absent from the
 * snapshot because provider surface replacements (for example DSH compact)
 * are allowed to hide older durable messages.
 */
export function replaceHistoricalMessages(
  messages: ChatMessage[],
  agentType?: AgentTypeKey,
): ChatMessage[] {
  return hydrateHistoricalMessages(filterRenderableHistoryMessages(messages), agentType);
}

function mergeHistoricalToolMessage(
  existing: ChatMessage,
  historical: ChatMessage,
): ChatMessage {
  if (existing.role !== "tool" || historical.role !== "tool") return existing;
  // 历史优先(持久权威): id/content/timestamp/toolName/isLoading 取历史,
  // live 仅补充历史缺失的运行期字段。保留 live canonical identity，
  // 让历史物化时已有的 DOM 行可以原地更新，避免完成瞬间重建。
  return {
    ...historical,
    id: existing.id,
    toolCallId: existing.toolCallId ?? historical.toolCallId,
    parentMessageId: historical.parentMessageId ?? existing.parentMessageId,
    toolData: historical.toolData || existing.toolData,
    toolInput: historical.toolInput ?? existing.toolInput,
    toolDisplay: historical.toolDisplay ?? existing.toolDisplay,
    toolAgentType: historical.toolAgentType ?? existing.toolAgentType,
  };
}

/**
 * Codex history is already an ordered provider transcript. Keep that order
 * and add only rows that exist in the live overlay. Keeping this direction in
 * one helper prevents callers from accidentally swapping history and live.
 */
function mergeCodexHistoryWithLive(
  history: ChatMessage[],
  live: ChatMessage[],
): ChatMessage[] {
  return mergeCodexHistoricalMessages(live, history);
}

/** Pi history supplies branch order; live-only rows use their arrival order.
 * Never compare historical sequence numbers with run-local event sequences. */
export function reconcilePiHistory(
  history: ChatMessage[], live: ChatMessage[], hasMore: boolean,
  requestProjection?: readonly ChatMessage[],
): ChatMessage[] {
  return reuseRenderEquivalentMessageReferences(live,
    reconcilePiTimeline(live, history, { kind: "snapshot", coverage: hasMore ? "latest-page" : "full-branch", requestProjection }));
}

function latestUserIndex(messages: readonly ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return index;
  }
  return -1;
}

export function mergeHistoricalMessages(
  existing: ChatMessage[],
  historical: ChatMessage[],
  agentType?: AgentTypeKey,
): ChatMessage[] {
  const hydratedHistorical = hydrateHistoricalMessages(historical, agentType);
  if (existing.length === 0) return hydratedHistorical;
  if (agentType === "pi") return reuseRenderEquivalentMessageReferences(existing, reconcilePiTimeline(existing, hydratedHistorical, { kind: "snapshot", coverage: "page" }));

  // Codex `thread/turns/list(itemsView: "full")` is already an ordered
  // transcript: turn order and the order of every item inside each turn are
  // authoritative. All persisted items in a turn commonly have the same
  // `startedAt`, while optimistic rows use local arrival time. Sorting their
  // union by timestamp can therefore move a command before the user message
  // that caused it. Keep the provider's historical order intact and append
  // only genuinely live-only rows (normally an in-progress tail).
  if (agentType === "codex") {
    return mergeCodexHistoryWithLive(hydratedHistorical, existing);
  }

  let mergedExisting = existing;
  const seenIds = new Set(existing.map(messageIdentityKey));
  const existingToolIndexByCallId = new Map<string, number>();
  const latestExistingUser = latestUserIndex(existing);
  const latestHistoricalUser = latestUserIndex(hydratedHistorical);
  const sameLatestTurn = latestExistingUser >= 0 && latestHistoricalUser >= 0 &&
    messageIdentityKey(existing[latestExistingUser]) ===
      messageIdentityKey(hydratedHistorical[latestHistoricalUser]);
  const existingContentCounts = new Map<string, number>();
  for (const [index, message] of existing.entries()) {
    if (message.role === "tool" && message.toolCallId) {
      existingToolIndexByCallId.set(message.toolCallId, index);
      existingToolIndexByCallId.set(toolCallIdentityKey(message.toolCallId), index);
    }

    const contentKey = sameLatestTurn && index > latestExistingUser &&
      (message.role === "assistant" || message.role === "reasoning")
      ? messageContentStableKey(message) : null;
    if (contentKey) {
      existingContentCounts.set(
        contentKey,
        (existingContentCounts.get(contentKey) ?? 0) + 1,
      );
    }
  }

  const missing: ChatMessage[] = [];
  // 被 historical tool 合并替代的 existing tool 下标 ── 这些 live tool 不再
  // 占 existing 位置, 合并消息(代表历史 tool)放 missing 的历史顺序位置。
  const mergedExistingIndices = new Set<number>();
  for (const [historyIndex, message] of hydratedHistorical.entries()) {
    if (seenIds.has(messageIdentityKey(message))) continue;

    if (message.role === "tool" && message.toolCallId) {
      const existingIndex =
        existingToolIndexByCallId.get(message.toolCallId) ??
        existingToolIndexByCallId.get(toolCallIdentityKey(message.toolCallId));
      if (existingIndex !== undefined) {
        if (mergedExisting === existing) mergedExisting = [...existing];
        // 合并消息代表历史 tool, 放历史顺序位置(missing); existing 的 live
        // tool 标记移除。原先替换 mergedExisting[existingIndex] 把合并消息留
        // 在 live 区(existing 位置, 通常最前), 破坏历史时间序。
        mergedExistingIndices.add(existingIndex);
        missing.push(
          mergeHistoricalToolMessage(mergedExisting[existingIndex], message),
        );
        continue;
      }
    }


    const contentKey = sameLatestTurn && historyIndex > latestHistoricalUser &&
      (message.role === "assistant" || message.role === "reasoning")
      ? messageContentStableKey(message) : null;
    if (contentKey) {
      const count = existingContentCounts.get(contentKey) ?? 0;
      if (count > 0) {
        existingContentCounts.set(contentKey, count - 1);
        continue;
      }
    }

    missing.push(message);
  }

  // 按时间排序(同时戳时历史 order 小在前, 对齐 mergeMessagesForThreadRender)。
  // 原先 [...mergedExisting, ...missing] 不排序, live 区整体在历史前导致顺序
  // 错乱(合并消息卡在 live 区最前)。
  const survivingExisting = mergedExisting.filter(
    (_, index) => !mergedExistingIndices.has(index),
  );
  const ordered = [
    ...missing.map((message, order) => ({ message, order })),
    ...survivingExisting.map((message, order) => ({
      message,
      order: missing.length + order,
    })),
  ];
  return ordered
    .sort(
      (a, b) =>
        messageTime(a.message) - messageTime(b.message) || a.order - b.order,
    )
    .map(({ message }) => message);
}

function mergeCodexHistoricalMessages(
  existing: ChatMessage[],
  historical: ChatMessage[],
): ChatMessage[] {
  const scopedUserKey = (message: ChatMessage) => {
    if (!message.codexTurnId) return null;
    const key = userMessageVisibleKey(message);
    return key ? `${message.codexTurnId}:${key}` : null;
  };
  const scopedContentKey = (message: ChatMessage) => {
    if (!message.codexTurnId) return null;
    const key = messageContentStableKey(message);
    return key ? `${message.codexTurnId}:${key}` : null;
  };
  const historyIds = new Set(historical.map(messageIdentityKey));
  const historyToolIds = new Set(
    historical
      .filter((message) => message.role === "tool" && message.toolCallId)
      .flatMap((message) => [
        message.toolCallId!,
        toolCallIdentityKey(message.toolCallId!),
      ]),
  );
  const historyUserCounts = new Map<string, number>();
  const historyContentCounts = new Map<string, number>();
  for (const message of historical) {
    const userKey = scopedUserKey(message);
    if (userKey) {
      historyUserCounts.set(userKey, (historyUserCounts.get(userKey) ?? 0) + 1);
    }
    const contentKey = scopedContentKey(message);
    if (contentKey) {
      historyContentCounts.set(
        contentKey,
        (historyContentCounts.get(contentKey) ?? 0) + 1,
      );
    }
  }

  const liveOnly = existing.filter((message) => {
    if (historyIds.has(messageIdentityKey(message))) return false;
    if (
      message.role === "tool" &&
      message.toolCallId &&
      (historyToolIds.has(message.toolCallId) ||
        historyToolIds.has(toolCallIdentityKey(message.toolCallId)))
    ) {
      return false;
    }

    const userKey = scopedUserKey(message);
    if (userKey) {
      const count = historyUserCounts.get(userKey) ?? 0;
      if (count > 0) {
        historyUserCounts.set(userKey, count - 1);
        return false;
      }
    }

    const contentKey = scopedContentKey(message);
    if (contentKey) {
      const count = historyContentCounts.get(contentKey) ?? 0;
      if (count > 0) {
        historyContentCounts.set(contentKey, count - 1);
        return false;
      }
    }
    return true;
  });

  return reuseRenderEquivalentMessageReferences(existing, [
    ...historical,
    ...liveOnly,
  ]);
}

function messageTime(message: ChatMessage): number {
  const timestamp = Date.parse(message.timestamp);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Completion reconciliation receives freshly allocated history objects.  A
 * persisted event's timestamp/source metadata may legitimately differ from
 * the optimistic live row even when its rendered representation is identical.
 * Reusing that live object is important: the message renderer treats a new
 * reference outside the final row as a structural list change and otherwise
 * rebuilds the whole conversation.
 *
 * Keep this deliberately narrower than `areMessagesEquivalent`: it compares
 * only values consumed by the message item renderer.  The one exception is an
 * `end` row without explicit content, whose timestamp is its visible text.
 */
function areMessagesRenderEquivalent(
  left: ChatMessage,
  right: ChatMessage,
): boolean {
  if (left === right) return true;
  if (left.id !== right.id || left.role !== right.role) return false;

  return JSON.stringify({
    content: left.content,
    messageType: left.messageType,
    notice: left.notice,
    errorDetails: left.errorDetails,
    isLoading: left.isLoading ?? false,
    toolCallId: left.toolCallId,
    parentMessageId: left.parentMessageId,
    toolName: left.toolName,
    toolAgentType: left.toolAgentType,
    toolData: left.toolData,
    toolInput: left.toolInput,
    toolDisplay: left.toolDisplay,
    toolCalls: left.toolCalls,
    reasoning: left.reasoning,
    isCompleted: left.isCompleted ?? false,
    isCollapsed: left.isCollapsed ?? false,
    turnDurationMs: left.turnDurationMs,
    endTimestamp:
      left.role === "end" && !left.content ? left.timestamp : undefined,
  }) === JSON.stringify({
    content: right.content,
    messageType: right.messageType,
    notice: right.notice,
    errorDetails: right.errorDetails,
    isLoading: right.isLoading ?? false,
    toolCallId: right.toolCallId,
    parentMessageId: right.parentMessageId,
    toolName: right.toolName,
    toolAgentType: right.toolAgentType,
    toolData: right.toolData,
    toolInput: right.toolInput,
    toolDisplay: right.toolDisplay,
    toolCalls: right.toolCalls,
    reasoning: right.reasoning,
    isCompleted: right.isCompleted ?? false,
    isCollapsed: right.isCollapsed ?? false,
    turnDurationMs: right.turnDurationMs,
    endTimestamp:
      right.role === "end" && !right.content ? right.timestamp : undefined,
  });
}

/**
 * Reconcile the persisted representation without invalidating DOM for rows
 * whose visible form did not change.  Canonical external message ids make the
 * lookup exact for Codex and the other external runtimes.
 */
function reuseRenderEquivalentMessageReferences(
  existing: ChatMessage[],
  next: ChatMessage[],
): ChatMessage[] {
  const existingByIdentity = new Map(
    existing.map((message) => [messageIdentityKey(message), message]),
  );
  const reconciled = next.map((message) => {
    const current = existingByIdentity.get(messageIdentityKey(message));
    return current && areMessagesRenderEquivalent(current, message)
      ? current
      : current && current.renderKey
        ? { ...message, renderKey: current.renderKey }
        : message;
  });

  // Preserve the array too when the complete rendered sequence is unchanged.
  // This suppresses the Zustand subscriber notification for harmless history
  // metadata convergence after a completed turn.
  return reconciled.length === existing.length &&
    reconciled.every((message, index) => message === existing[index])
    ? existing
    : reconciled;
}

/**
 * Codex's live stream is authoritative for an item that already exists in
 * the current projection. History can briefly expose an older or differently
 * normalized snapshot for the same provider item while persistence catches
 * up. Keep the live row wholesale in that case, including its content.
 */
function preferLiveMessageReferencesById(
  existing: ChatMessage[],
  next: ChatMessage[],
): ChatMessage[] {
  const existingById = new Map(existing.map((message) => [message.id, message]));
  const reconciled = next.map((message) => existingById.get(message.id) ?? message);

  return reconciled.length === existing.length &&
    reconciled.every((message, index) => message === existing[index])
    ? existing
    : reconciled;
}

/**
 * Compare the render-relevant message shape while ignoring object identity.
 * History adapters return fresh objects, so replacing an equivalent message
 * array would otherwise cause a needless conversation re-render after every
 * completed run.
 */
export function areMessagesEquivalent(
  left: ChatMessage[],
  right: ChatMessage[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  return left.every((message, index) => {
    const other = right[index];
    return JSON.stringify({
      id: message.id,
      messageId: message.messageId,
      piBlockIndex: message.piBlockIndex,
      renderKey: message.renderKey,
      role: message.role,
      content: message.content,
      messageType: message.messageType,
      notice: message.notice,
      errorDetails: message.errorDetails,
      isLoading: message.isLoading ?? false,
      toolCallId: message.toolCallId,
      parentMessageId: message.parentMessageId,
      toolName: message.toolName,
      toolAgentType: message.toolAgentType,
      toolData: message.toolData,
      toolInput: message.toolInput,
      toolDisplay: message.toolDisplay,
      toolCalls: message.toolCalls,
      reasoning: message.reasoning,
      isCompleted: message.isCompleted ?? false,
      isCollapsed: message.isCollapsed ?? false,
      turnDurationMs: message.turnDurationMs,
    }) === JSON.stringify({
      id: other.id,
      messageId: other.messageId,
      piBlockIndex: other.piBlockIndex,
      renderKey: other.renderKey,
      role: other.role,
      content: other.content,
      messageType: other.messageType,
      notice: other.notice,
      errorDetails: other.errorDetails,
      isLoading: other.isLoading ?? false,
      toolCallId: other.toolCallId,
      parentMessageId: other.parentMessageId,
      toolName: other.toolName,
      toolAgentType: other.toolAgentType,
      toolData: other.toolData,
      toolInput: other.toolInput,
      toolDisplay: other.toolDisplay,
      toolCalls: other.toolCalls,
      reasoning: other.reasoning,
      isCompleted: other.isCompleted ?? false,
      isCollapsed: other.isCollapsed ?? false,
      turnDurationMs: other.turnDurationMs,
    });
  });
}

/**
 * Replace the just-completed live run with its persisted representation.
 * The run boundary is its user row: the Codex turn id once the provider
 * userMessage item has adopted the optimistic row, the stable run-scoped
 * user id before that, and a visible-content match as the final fallback.
 * Older pages already loaded by the user stay intact while partial
 * assistant/tool rows from the live stream are removed instead of being
 * appended beside the final history rows.
 */
export function replaceCompletedRunWithHistory(
  existing: ChatMessage[],
  historical: ChatMessage[],
  runId: string,
  agentType?: AgentTypeKey,
  turnId?: string,
): ChatMessage[] {
  const history = hydrateHistoricalMessages(historical, agentType);
  if (history.length === 0) return existing;
  if (agentType === "pi") return reuseRenderEquivalentMessageReferences(existing, reconcilePiTimeline(existing, history, { kind: "snapshot", coverage: "page" }));
  const anchorId = completedRunUserMessageId(agentType, runId);
  const lastIndex = (
    messages: ChatMessage[],
    predicate: (message: ChatMessage) => boolean,
  ): number => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (predicate(messages[index])) return index;
    }
    return -1;
  };
  const turnUserAnchor = (messages: ChatMessage[]): number =>
    turnId
      ? lastIndex(
          messages,
          (message) =>
            message.role === "user" && message.codexTurnId === turnId,
        )
      : -1;
  const existingAnchor = Math.max(
    turnUserAnchor(existing),
    existing.findIndex((message) => message.id === anchorId),
  );
  let historyAnchor = Math.max(
    turnUserAnchor(history),
    history.findIndex((message) => message.id === anchorId),
  );
  // Codex owns history item ids (`item-*`), while Flowix uses a stable
  // run-scoped id for the optimistic user row. Match the visible user
  // message when those provider/product ids differ so live-only tool rows
  // survive completion reconciliation.
  if (historyAnchor < 0 && existingAnchor >= 0) {
    const existingUser = existing[existingAnchor];
    const existingUserKey = existingUser && userMessageVisibleKey(existingUser);
    if (existingUserKey) {
      historyAnchor = lastIndex(
        history,
        (message) => userMessageVisibleKey(message) === existingUserKey,
      );
    }
  }
  if (existingAnchor >= 0 && historyAnchor >= 0) {
    const runHistory = history.slice(historyAnchor);
    const runExisting = existing.slice(existingAnchor);
    // History may contain a reconstructed tool row for the same call. Merge
    // it with the live row first so completion reconciliation cannot discard
    // the display metadata that was already used during streaming.
    const existingToolsByCallId = new Map<string, ChatMessage>();
    for (const message of existing.slice(existingAnchor)) {
      if (message.role !== "tool" || !message.toolCallId) continue;
      existingToolsByCallId.set(toolCallIdentityKey(message.toolCallId), message);
    }
    const reconciledHistory = runHistory.map((message) => {
      if (message.role !== "tool" || !message.toolCallId) return message;
      const existingTool = existingToolsByCallId.get(
        toolCallIdentityKey(message.toolCallId),
      );
      return existingTool
        ? mergeHistoricalToolMessage(existingTool, message)
        : message;
    });
    // `turn/completed` can race the App Server's history materialization. In
    // that window thread/turns/list may already contain the user/assistant
    // items but not the just-completed tool item. Do not let that partial
    // snapshot erase a tool row that was already received live. The next
    // history load will merge the authoritative item by call id.
    const historyToolIds = new Set(
      reconciledHistory
        .filter((message) => message.role === "tool" && message.toolCallId)
        .map((message) => toolCallIdentityKey(message.toolCallId!)),
    );
    const missingLiveTools = existing
      .slice(existingAnchor)
      .filter(
        (message) =>
          message.role === "tool" &&
          message.toolCallId &&
          !historyToolIds.has(toolCallIdentityKey(message.toolCallId)),
      );
    // The completion snapshot can also race the final assistant item. Keep a
    // live assistant/reasoning tail when the provider history has fewer rows
    // of that role in this run. Without this, a turn that already rendered its
    // final answer can be replaced by a snapshot containing only the user and
    // tool items, making the answer disappear until a later history reload.
    const runExistingAssistantMessages = runExisting
      .filter((message) => message.role === "assistant" || message.role === "reasoning");
    const historyAssistantMessages = reconciledHistory.filter(
      (message) => message.role === "assistant" || message.role === "reasoning",
    );
    const missingLiveAssistantMessages =
      historyAssistantMessages.length < runExistingAssistantMessages.length
        ? runExistingAssistantMessages.slice(historyAssistantMessages.length)
        : [];
    // Reinsert live-only tools at their original position in the run.  The
    // completion snapshot can race rollout persistence, but appending these
    // rows made a tool that was between two assistant items jump to the end
    // of the conversation on the next render/re-entry.
    const historyIndexById = new Map(
      reconciledHistory.map((message, index) => [message.id, index]),
    );
    const toolPosition = new Map(
      missingLiveTools.map((tool) => [
        tool.id,
        runExisting.findIndex((message) => message.id === tool.id),
      ]),
    );
    const reconciledRun = [...reconciledHistory];
    for (const tool of missingLiveTools) {
      const existingPosition = toolPosition.get(tool.id) ?? -1;
      let insertAt = reconciledRun.length;
      if (existingPosition >= 0) {
        // Find the next existing message that is present in the persisted
        // snapshot and insert immediately before it.
        for (let i = existingPosition + 1; i < runExisting.length; i += 1) {
          const nextExisting = runExisting[i];
          let nextIndex = historyIndexById.get(nextExisting.id);
          // A streaming assistant is commonly replaced by a new persisted
          // assistant id at completion. Align it by role in that case; the
          // run order is already known, so this does not make equal-content
          // messages from different turns collide.
          if (nextIndex === undefined) {
            let roleOrdinal = 0;
            for (let j = 0; j <= i; j += 1) {
              if (runExisting[j].role === nextExisting.role) roleOrdinal += 1;
            }
            const matching = reconciledRun
              .map((message, index) => ({ message, index }))
              .filter(({ message }) => message.role === nextExisting.role);
            nextIndex = matching[roleOrdinal - 1]?.index;
          }
          if (nextIndex !== undefined) {
            insertAt = nextIndex;
            break;
          }
        }
      }
      reconciledRun.splice(insertAt, 0, tool);
      for (const [id, index] of historyIndexById) {
        if (index >= insertAt) historyIndexById.set(id, index + 1);
      }
    }
    for (const assistant of missingLiveAssistantMessages) {
      const existingPosition = runExisting.indexOf(assistant);
      let insertAt = reconciledRun.length;
      if (existingPosition >= 0) {
        for (let i = existingPosition + 1; i < runExisting.length; i += 1) {
          const nextExisting = runExisting[i];
          const nextIndex = reconciledRun.findIndex(
            (message) =>
              message.role === nextExisting.role &&
              message.content === nextExisting.content,
          );
          if (nextIndex >= 0) {
            insertAt = nextIndex;
            break;
          }
        }
      }
      reconciledRun.splice(insertAt, 0, assistant);
    }
    const next = [...existing.slice(0, existingAnchor), ...reconciledRun];
    return agentType === "codex"
      ? preferLiveMessageReferencesById(existing, next)
      : reuseRenderEquivalentMessageReferences(existing, next);
  }

  // Other runtimes may not yet expose run-scoped user ids. An exact overlap
  // still gives a safe page boundary; otherwise retain the normal merge path.
  const historyIndexById = new Map(
    history.map((message, index) => [messageIdentityKey(message), index]),
  );
  const existingOverlap = existing.findIndex((message) =>
    historyIndexById.has(messageIdentityKey(message)),
  );
  if (existingOverlap >= 0) {
    const historyOverlap = historyIndexById.get(
      messageIdentityKey(existing[existingOverlap]),
    ) ?? 0;
    return reuseRenderEquivalentMessageReferences(
      existing,
      [...existing.slice(0, existingOverlap), ...history.slice(historyOverlap)],
    );
  }
  return reuseRenderEquivalentMessageReferences(
    existing,
    mergeHistoricalMessages(existing, history, agentType),
  );
}

/**
 * Merge persisted/history messages with the in-memory live thread state for
 * rendering. Live messages are allowed to repeat the same visible user content
 * across turns; only already-hydrated historical counterparts at the same or an
 * earlier timestamp are suppressed.
 */
export interface MergeMessagesForThreadRenderOptions {
  history: ChatMessage[];
  live: ChatMessage[];
  agentType?: AgentTypeKey;
}

export function mergeMessagesForThreadRender({
  history,
  live,
  agentType,
}: MergeMessagesForThreadRenderOptions): ChatMessage[] {
  if (history.length === 0) return live;
  if (live.length === 0) return history;

  const hydratedHistory = hydrateHistoricalMessages(history, agentType);
  const hydratedLive = hydrateHistoricalMessages(live, agentType);
  // The same Codex ordering contract applies to render-time overlays as to
  // initial/completion history reconciliation. Keeping this branch here
  // prevents a later caller from accidentally reintroducing timestamp order
  // after `mergeHistoricalMessages` already preserved provider order.
  if (agentType === "codex") {
    return mergeCodexHistoryWithLive(hydratedHistory, hydratedLive);
  }
  if (agentType === "pi") return reuseRenderEquivalentMessageReferences(hydratedLive, reconcilePiTimeline(hydratedLive, hydratedHistory, { kind: "snapshot", coverage: "page" }));
  const latestHistoryUser = latestUserIndex(hydratedHistory);
  const latestLiveUser = latestUserIndex(hydratedLive);
  const sameLatestTurn = latestHistoryUser >= 0 && latestLiveUser >= 0 &&
    messageIdentityKey(hydratedHistory[latestHistoryUser]) ===
      messageIdentityKey(hydratedLive[latestLiveUser]);
  const seenIds = new Set(hydratedHistory.map(messageIdentityKey));
  const historicalContentCounts = new Map<string, number>();
  const latestHistoricalTimeByContent = new Map<string, number>();

  for (const [index, message] of hydratedHistory.entries()) {
    const key = sameLatestTurn && index > latestHistoryUser &&
      (message.role === "assistant" || message.role === "reasoning")
      ? messageContentStableKey(message) : null;
    if (!key) continue;
    historicalContentCounts.set(key, (historicalContentCounts.get(key) ?? 0) + 1);
    latestHistoricalTimeByContent.set(
      key,
      Math.max(latestHistoricalTimeByContent.get(key) ?? 0, messageTime(message)),
    );
  }

  const merged = hydratedHistory.map((message, index) => ({
    message,
    order: index,
  }));
  let order = history.length;

  for (const [index, message] of hydratedLive.entries()) {
    if (seenIds.has(messageIdentityKey(message))) continue;

    const key = sameLatestTurn && index > latestLiveUser &&
      (message.role === "assistant" || message.role === "reasoning")
      ? messageContentStableKey(message) : null;
    if (key) {
      const historicalCount = historicalContentCounts.get(key) ?? 0;
      const latestHistoricalTime = latestHistoricalTimeByContent.get(key) ?? 0;
      if (historicalCount > 0 && messageTime(message) <= latestHistoricalTime) {
        historicalContentCounts.set(key, historicalCount - 1);
        continue;
      }
    }

    merged.push({ message, order });
    seenIds.add(messageIdentityKey(message));
    order += 1;
  }

  return merged
    .sort((a, b) => messageTime(a.message) - messageTime(b.message) || a.order - b.order)
    .map(({ message }) => message);
}

export function mergeLiveMessagesIntoRenderableMessages(
  existingMessages: ChatMessage[],
  liveMessages: ChatMessage[],
  agentType?: AgentTypeKey,
): ChatMessage[] {
  if (liveMessages.length === 0) return existingMessages;
  const live = hydrateHistoricalMessages(liveMessages, agentType);
  if (existingMessages.length === 0) return live;
  if (agentType === "pi") return reuseRenderEquivalentMessageReferences(existingMessages, reconcilePiTimeline(existingMessages, live, { kind: "live-projection" }));

  const liveById = new Map(
    live.map((message) => [messageIdentityKey(message), message]),
  );
  let changed = false;
  const updatedExisting = existingMessages.map((message) => {
    const liveMessage = liveById.get(messageIdentityKey(message));
    if (!liveMessage || liveMessage === message) return message;
    changed = true;
    return liveMessage;
  });
  const merged = mergeMessagesForThreadRender({
    history: updatedExisting,
    live,
    agentType,
  });
  if (
    !changed &&
    merged.length === existingMessages.length &&
    merged.every((message, index) => message === existingMessages[index])
  ) {
    return existingMessages;
  }
  return merged;
}

/**
 * 流式 fast path: 若 `renderable` 与 `current` 仅最后一条消息的内容不同
 * (同 id 同 role, 前 N-1 条引用全等), 直接返回替换末条后的新数组, 跳过
 * [`mergeLiveMessagesIntoRenderableMessages`] 的全量 fingerprint + sort
 * (O(N·L) -> O(N) 引用比较)。流式 text_delta / reasoning_delta 每次只追加
 * 末条内容, 前 N-1 条引用不变, 命中率极高。
 *
 * - 返回 `current` 本身: 无任何变化, 让上层相等短路。
 * - 返回新数组: 末条已 swap。
 * - 返回 `null`: 未命中 (长度不同 / 中间有变化 / 末条非 assistant·reasoning·end),
 *   调用方走原 merge。
 *
 * 仅对末条 assistant / reasoning / end 启用: 这些角色的 [`hydrateToolDisplay`]
 * 是 no-op, 直接复用 live 引用不会丢失 toolDisplay; tool / user 末条仍需走原
 * merge 做 hydrate 与去重。顺序不变是流式追加的前提 ── applyTextChunk 只追加
 * 内容不重排, 故跳过 sort 安全。
 */
export function trySwapLastLiveMessage(
  current: ChatMessage[],
  renderable: ChatMessage[],
): ChatMessage[] | null {
  const len = renderable.length;
  if (len === 0 || len !== current.length) return null;

  // 找第一个引用不同的位置; 全等则返回 current 让上层短路
  let firstDiff = -1;
  for (let i = 0; i < len; i += 1) {
    if (renderable[i] !== current[i]) {
      firstDiff = i;
      break;
    }
  }
  if (firstDiff === -1) return current;
  // 唯一差异必须在末条; 中间有变化 (新增 / 重排 / 历史回放) 走原 merge
  if (firstDiff !== len - 1) return null;

  const currentLast = current[len - 1];
  const renderableLast = renderable[len - 1];
  const role = renderableLast.role;
  if (role !== "assistant" && role !== "reasoning" && role !== "end") return null;
  if (renderableLast.id !== currentLast.id || currentLast.role !== role) {
    return null;
  }

  const merged = current.slice();
  merged[len - 1] = renderableLast;
  return merged;
}

export function prependHistoricalMessages(
  existing: ChatMessage[],
  older: ChatMessage[],
  agentType?: AgentTypeKey,
): ChatMessage[] {
  if (older.length === 0) return existing;
  const hydratedOlder = hydrateHistoricalMessages(older, agentType);
  if (existing.length === 0) return hydratedOlder;
  const seenIds = new Set(existing.map(messageIdentityKey));
  const fresh = hydratedOlder.filter((m) => !seenIds.has(messageIdentityKey(m)));
  if (fresh.length === 0) return existing;
  return [...fresh, ...existing];
}
