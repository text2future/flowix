import type { ThreadState } from "@features/agent/store/chat-store";
import { stripSystemBlock } from "@features/agent/message";

function getUserHistoryContent(
  message: ThreadState["messages"][number],
): string | null {
  if (message.role !== "user") return null;
  const content = stripSystemBlock(message.content || "");
  return content.trim() ? content : null;
}

export function getAgentThreadCardUserHistoryMessages(
  state: ThreadState | undefined,
): string[] {
  if (!state) return [];
  return getAgentThreadCardUserHistoryMessagesFromMessages(state.messages);
}

export function getAgentThreadCardUserHistoryMessagesFromMessages(
  messages: ThreadState["messages"],
): string[] {
  const out: string[] = [];
  for (const message of messages) {
    const content = getUserHistoryContent(message);
    if (!content) continue;
    out.push(content);
  }
  return out;
}
