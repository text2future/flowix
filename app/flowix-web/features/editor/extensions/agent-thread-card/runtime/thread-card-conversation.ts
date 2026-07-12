import type { AgentTypeKey } from "@/types/agent";
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";
import type {
  AgentConversationInstance,
  AgentConversationSource,
} from "@features/agent/store/agent-conversation-store";

export function upsertAgentThreadCardConversationInstance(options: {
  instanceId: string;
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
  instance: AgentConversationInstance;
} {
  const { instanceId, agentType, title, threadId, source, role } = options;

  const store = useAgentConversationStore.getState();

  const existing = store.getInstance(instanceId);
  const instance = store.upsertInstance(instanceId, {
    agentType,
    ...(existing?.title ? {} : { title }),
    threadId,
    source,
    role,
  });
  return { instanceId, instance };
}
