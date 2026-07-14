import type { AgentTypeKey } from "@/types/agent";
import { normalizeAgentTypeKey } from "@/lib/agent-types";
import { useChatStore } from "@features/agent/store/chat-store";
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";

export interface AgentThreadCardCleanupAttrs {
  threadId?: unknown;
  instanceId?: unknown;
  typeKey?: unknown;
}

export function terminateAgentThreadCardRuntime(
  attrs: AgentThreadCardCleanupAttrs,
): void {
  const threadId = typeof attrs.threadId === "string" ? attrs.threadId : null;
  const instanceId =
    typeof attrs.instanceId === "string" ? attrs.instanceId : null;
  const typeKey = normalizeAgentTypeKey(
    typeof attrs.typeKey === "string"
      ? (attrs.typeKey as AgentTypeKey)
      : undefined,
  );

  if (threadId) {
    const chatStore = useChatStore.getState();
    chatStore.bindThreadType(threadId, typeKey);
    void chatStore.stopThreadRun(threadId);
  }

  if (instanceId) {
    useAgentConversationStore.getState().removeInstance(instanceId);
  }
}
