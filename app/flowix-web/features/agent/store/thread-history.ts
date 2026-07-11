import type { ChatMessage, ThreadListItem } from "@/types";
import type { AgentTypeKey } from "@/types/agent";
import { stripSystemBlock } from "@features/agent/message";
import { createAgentToolDisplay } from "@features/agent/tool-display";
import { isEmptyAssistantMessage } from "@features/agent/message";
import {
  getAgentHistoryAdapter,
  type ThreadHistoryPage,
} from "@features/agent/store/agent-history-adapters";

/** Layer 4: 单页大小. 每次加载 10 条, 用户向上翻页时每页同样 10 条. */
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
  beforeSequence: number | null,
  limit: number,
): Promise<ThreadHistoryPage> {
  return getAgentHistoryAdapter(type).getPage(threadId, beforeSequence, limit);
}

export async function getInitialThreadHistory(
  type: AgentTypeKey,
  threadId: string,
  limit: number,
): Promise<ThreadHistoryPage> {
  return getAgentHistoryAdapter(type).getInitialHistory(threadId, limit);
}

export async function getThreadCacheHistory(
  threadId: string,
): Promise<ChatMessage[]> {
  return getAgentHistoryAdapter("flowix").getFullHistory(threadId);
}

export function filterRenderableHistoryMessages(
  messages: ChatMessage[],
): ChatMessage[] {
  return messages.filter((m) => !isEmptyAssistantMessage(m));
}

// Cheap content fingerprint used as a Map key for dedup. Two independent
// FNV-1a 32-bit hashes combined give an effectively 64-bit collision space
// while walking each string only once with constant per-character work.
// Replaces JSON.stringify(content) which, on multi-MB assistant responses,
// allocated several MB of UTF-16 strings per message per rAF frame
// (syncRenderableMessages is invoked on every streaming flush). Collisions
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

function userMessageStableKey(message: ChatMessage): string | null {
  if (message.role !== "user") return null;
  const contentFp = message.content ? contentFingerprint(message.content) : "";
  const llmFp = message.llmContent ? contentFingerprint(message.llmContent) : "";
  return `user:${contentFp}:${llmFp}:${message.systemReminderDirectory ?? ""}:${message.systemReminderDocumentPath ?? ""}`;
}

function userMessageVisibleKey(message: ChatMessage): string | null {
  if (message.role !== "user") return null;
  return `user:visible:${contentFingerprint(stripSystemBlock(message.content || ""))}`;
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

function mergeHistoricalToolMessage(
  existing: ChatMessage,
  historical: ChatMessage,
): ChatMessage {
  if (existing.role !== "tool" || historical.role !== "tool") return existing;
  return {
    ...existing,
    content: existing.content || historical.content,
    toolData: existing.toolData || historical.toolData,
    toolName: existing.toolName || historical.toolName,
    toolInput: existing.toolInput ?? historical.toolInput,
    toolDisplay: existing.toolDisplay ?? historical.toolDisplay,
    toolAgentType: existing.toolAgentType ?? historical.toolAgentType,
    isLoading:
      existing.isLoading === true && historical.isLoading === false
        ? false
        : existing.isLoading,
  };
}

export function mergeHistoricalMessages(
  existing: ChatMessage[],
  historical: ChatMessage[],
  agentType?: AgentTypeKey,
): ChatMessage[] {
  const hydratedHistorical = hydrateHistoricalMessages(historical, agentType);
  if (existing.length === 0) return hydratedHistorical;

  let mergedExisting = existing;
  const seenIds = new Set(existing.map((message) => message.id));
  const existingToolIndexByCallId = new Map<string, number>();
  const existingUserCounts = new Map<string, number>();
  const existingVisibleUserCounts = new Map<string, number>();
  const existingContentCounts = new Map<string, number>();
  for (const [index, message] of existing.entries()) {
    if (message.role === "tool" && message.toolCallId) {
      existingToolIndexByCallId.set(message.toolCallId, index);
    }

    const key = userMessageStableKey(message);
    if (key) {
      existingUserCounts.set(key, (existingUserCounts.get(key) ?? 0) + 1);
    }

    const visibleKey = userMessageVisibleKey(message);
    if (visibleKey) {
      existingVisibleUserCounts.set(
        visibleKey,
        (existingVisibleUserCounts.get(visibleKey) ?? 0) + 1,
      );
    }

    const contentKey = messageContentStableKey(message);
    if (contentKey) {
      existingContentCounts.set(
        contentKey,
        (existingContentCounts.get(contentKey) ?? 0) + 1,
      );
    }
  }

  const missing: ChatMessage[] = [];
  for (const message of hydratedHistorical) {
    if (seenIds.has(message.id)) continue;

    if (message.role === "tool" && message.toolCallId) {
      const existingIndex = existingToolIndexByCallId.get(message.toolCallId);
      if (existingIndex !== undefined) {
        if (mergedExisting === existing) mergedExisting = [...existing];
        mergedExisting[existingIndex] = mergeHistoricalToolMessage(
          mergedExisting[existingIndex],
          message,
        );
        continue;
      }
    }

    const key = userMessageStableKey(message);
    if (key) {
      const count = existingUserCounts.get(key) ?? 0;
      if (count > 0) {
        existingUserCounts.set(key, count - 1);
        const visibleKey = userMessageVisibleKey(message);
        if (visibleKey) {
          const visibleCount = existingVisibleUserCounts.get(visibleKey) ?? 0;
          if (visibleCount > 0) {
            existingVisibleUserCounts.set(visibleKey, visibleCount - 1);
            const contentKey = messageContentStableKey(message);
            if (contentKey) {
              const contentCount = existingContentCounts.get(contentKey) ?? 0;
              if (contentCount > 0)
                existingContentCounts.set(contentKey, contentCount - 1);
            }
          }
        }
        continue;
      }
    }

    const visibleKey = userMessageVisibleKey(message);
    if (visibleKey) {
      const count = existingVisibleUserCounts.get(visibleKey) ?? 0;
      if (count > 0) {
        existingVisibleUserCounts.set(visibleKey, count - 1);
        const contentKey = messageContentStableKey(message);
        if (contentKey) {
          const contentCount = existingContentCounts.get(contentKey) ?? 0;
          if (contentCount > 0)
            existingContentCounts.set(contentKey, contentCount - 1);
        }
        continue;
      }
    }

    const contentKey = messageContentStableKey(message);
    if (contentKey) {
      const count = existingContentCounts.get(contentKey) ?? 0;
      if (count > 0) {
        existingContentCounts.set(contentKey, count - 1);
        continue;
      }
    }

    missing.push(message);
  }

  return [...mergedExisting, ...missing];
}

function messageTime(message: ChatMessage): number {
  const timestamp = Date.parse(message.timestamp);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Merge persisted/history messages with the in-memory live thread state for
 * rendering. Live messages are allowed to repeat the same visible user content
 * across turns; only already-hydrated historical counterparts at the same or an
 * earlier timestamp are suppressed.
 */
export function mergeMessagesForThreadRender(
  historyMessages: ChatMessage[],
  liveMessages: ChatMessage[],
  agentType?: AgentTypeKey,
): ChatMessage[] {
  if (historyMessages.length === 0) return liveMessages;
  if (liveMessages.length === 0) return historyMessages;

  const history = hydrateHistoricalMessages(historyMessages, agentType);
  const live = hydrateHistoricalMessages(liveMessages, agentType);
  const seenIds = new Set(history.map((message) => message.id));
  const historicalContentCounts = new Map<string, number>();
  const latestHistoricalTimeByContent = new Map<string, number>();

  for (const message of history) {
    const key = messageContentStableKey(message);
    if (!key) continue;
    historicalContentCounts.set(key, (historicalContentCounts.get(key) ?? 0) + 1);
    latestHistoricalTimeByContent.set(
      key,
      Math.max(latestHistoricalTimeByContent.get(key) ?? 0, messageTime(message)),
    );
  }

  const merged = history.map((message, index) => ({
    message,
    order: index,
  }));
  let order = history.length;

  for (const message of live) {
    if (seenIds.has(message.id)) continue;

    const key = messageContentStableKey(message);
    if (key) {
      const historicalCount = historicalContentCounts.get(key) ?? 0;
      const latestHistoricalTime = latestHistoricalTimeByContent.get(key) ?? 0;
      if (historicalCount > 0 && messageTime(message) <= latestHistoricalTime) {
        historicalContentCounts.set(key, historicalCount - 1);
        continue;
      }
    }

    merged.push({ message, order });
    seenIds.add(message.id);
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

  const liveById = new Map(live.map((message) => [message.id, message]));
  let changed = false;
  const updatedExisting = existingMessages.map((message) => {
    const liveMessage = liveById.get(message.id);
    if (!liveMessage || liveMessage === message) return message;
    changed = true;
    return liveMessage;
  });
  const merged = mergeMessagesForThreadRender(updatedExisting, live, agentType);
  if (
    !changed &&
    merged.length === existingMessages.length &&
    merged.every((message, index) => message === existingMessages[index])
  ) {
    return existingMessages;
  }
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
  const seenIds = new Set(existing.map((m) => m.id));
  const fresh = hydratedOlder.filter((m) => !seenIds.has(m.id));
  if (fresh.length === 0) return existing;
  return [...fresh, ...existing];
}
