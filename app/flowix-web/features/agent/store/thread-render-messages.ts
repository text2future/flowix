import type { ChatMessage } from "@/types";
import type { AgentTypeKey } from "@/types/agent";
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";
import { useChatStore } from "@features/agent/store/chat-store";

interface SelectRenderableThreadMessagesInput {
  typeKey: AgentTypeKey;
  threadId: string | null | undefined;
}

const EMPTY_MESSAGES: ChatMessage[] = [];

/**
 * Store-layer selector for the message list consumed by AgentThreadCard.
 *
 * AgentConversationStore owns the canonical render list. ChatStore keeps only
 * runtime cursors and an in-flight message buffer; terminal runs may release
 * that buffer without affecting what the card renders. The live fallback is
 * only for uninitialized compatibility paths; it does not merge two sources.
 */
export function selectRenderableThreadMessages({
  typeKey: _typeKey,
  threadId,
}: SelectRenderableThreadMessagesInput): ChatMessage[] {
  if (!threadId) return EMPTY_MESSAGES;

  const messageState =
    useAgentConversationStore.getState().messageStates[threadId];
  if (messageState) return messageState.messages;
  return (
    useChatStore.getState().threadStates[threadId]?.messages ?? EMPTY_MESSAGES
  );
}
