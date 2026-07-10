import type { ThreadState } from "@features/agent/store/chat-store";
import { shouldRenderAgentMessage } from "@features/agent/message";

export function getRenderedAgentMessages(
  messages: ThreadState["messages"],
): ThreadState["messages"] {
  return messages.filter(shouldRenderAgentMessage);
}
