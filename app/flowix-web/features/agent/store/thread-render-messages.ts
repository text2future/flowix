import type { ChatMessage } from "@/types";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";

const EMPTY_MESSAGES: ChatMessage[] = [];

/** Thread cards render only the projection owned by their product thread id. */
export function selectRenderableThreadMessages(threadId: string | null | undefined): ChatMessage[] {
  return threadId
    ? useAgentSessionStore.getState().threadProjections[threadId]?.messages ?? EMPTY_MESSAGES
    : EMPTY_MESSAGES;
}
