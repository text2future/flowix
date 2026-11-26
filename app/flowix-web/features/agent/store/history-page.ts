import type { ChatMessage, ThreadListItem } from "@/types";
import type { AgentTypeKey } from "@/types/agent";
import { stripSystemBlock, isEmptyAssistantMessage } from "@features/agent/message";
import { attachHistoryCursor, getAgentHistoryAdapter, readHistoryPageWithCursor, type ThreadHistoryPage } from "@features/agent/store/agent-history-adapters";

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

