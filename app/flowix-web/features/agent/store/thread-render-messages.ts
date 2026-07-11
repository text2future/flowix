import type { ChatMessage } from "@/types";
import type { AgentTypeKey } from "@/types/agent";
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";

interface SelectRenderableThreadMessagesInput {
  typeKey: AgentTypeKey;
  threadId: string | null | undefined;
}

const EMPTY_MESSAGES: ChatMessage[] = [];

/**
 * Store-layer selector for the message list consumed by AgentThreadCard.
 *
 * AgentConversationStore owns the canonical render list. ChatStore keeps
 * runtime cursors and transient stream state, but AgentThreadCard must not read
 * ChatStore messages as a display fallback.
 */
export function selectRenderableThreadMessages({
  typeKey: _typeKey,
  threadId,
}: SelectRenderableThreadMessagesInput): ChatMessage[] {
  if (!threadId) return EMPTY_MESSAGES;

  const messageState =
    useAgentConversationStore.getState().messageStates[threadId];
  return messageState?.messages ?? EMPTY_MESSAGES;
}
