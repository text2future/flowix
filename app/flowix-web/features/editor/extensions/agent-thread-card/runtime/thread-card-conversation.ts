import type { AgentTypeKey } from "@/types/agent";
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";
import type { AgentConversationSource } from "@features/agent/store/agent-conversation-store";

export function upsertAgentThreadCardConversationInstance(options: {
  instanceId: string | null;
  agentType: AgentTypeKey;
  title: string;
  threadId: string;
  source: AgentConversationSource;
  role: {
    memoId: string | null;
    name: string | null;
  };
}): {
  instanceId: string;
  created: boolean;
} {
  const { instanceId, agentType, title, threadId, source, role } = options;

  const store = useAgentConversationStore.getState();

  if (!instanceId) {
    const instance = store.createInstance({
      agentType,
      title,
      threadId,
      source,
      role,
    });
    return { instanceId: instance.instanceId, created: true };
  }

  const existing = store.getInstance(instanceId);
  store.upsertInstance(instanceId, {
    agentType,
    ...(existing?.title ? {} : { title }),
    threadId,
    source,
    role,
  });
  return { instanceId, created: false };
}
