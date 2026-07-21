import type { AgentEvent, AgentTypeKey } from "@/types/agent";
import type { AgentConversationInstance } from "@features/agent/store/agent-conversation-store";
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";

export function syncConversationInstanceForEvent(event: AgentEvent): void {
  if (event.kind !== "session_resolved" || !event.sessionId) return;
  useAgentConversationStore
    .getState()
    .resolveSessionByThreadId(event.threadId, event.sessionId, event.agentType);
}

/**
 * Ensure a conversation instance exists for `threadId`; return its id.
 *
 * Runtime status is intentionally not mirrored into the instance. Cards read
 * run state from chat thread runtime state or replayed external events.
 */
export function ensureConversationInstanceForThread(
  threadId: string,
  type: AgentTypeKey,
  title: string,
  options?: {
    defaultTitle?: string;
  },
): AgentConversationInstance {
  const instanceStore = useAgentConversationStore.getState();
  const existing = instanceStore.findByThreadId(threadId);
  if (existing) {
    const shouldUpdateTitle =
      title &&
      (!isExternalAgentType(type) ||
        !options?.defaultTitle ||
        title !== options.defaultTitle);
    return instanceStore.upsertInstance(existing.instanceId, {
      agentType: type,
      ...(shouldUpdateTitle ? { title } : {}),
      threadId,
    });
  }
  return instanceStore.createInstance({
    agentType: type,
    title,
    threadId,
    source: { kind: "thread-card" },
    runtimeConfig: buildInitialInstanceRuntimeConfig(type),
  });
}

function isExternalAgentType(type: AgentTypeKey): boolean {
  return type !== "flowix";
}
