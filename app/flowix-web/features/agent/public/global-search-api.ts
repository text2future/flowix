import { useMemo } from 'react';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import {
  getConversationRunSummary,
  selectRunningAgentConversations,
  useConversationRunIndex,
} from '@features/agent/store/conversation-run-index';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';

export { AgentIcon } from '@features/agent/components/agent-icon';
export { getConversationRunSummary };
export type { AgentConversationInstance };

export function useRunningAgentConversations() {
  const instances = useAgentSessionStore((state) => state.conversationRegistry.instances);
  const runIndex = useConversationRunIndex(instances);
  const runningInstances = useMemo(
    () => selectRunningAgentConversations({ instances }, runIndex),
    [instances, runIndex],
  );
  return { runningInstances, runIndex };
}

export function prepareAgentConversationSelection(instance: AgentConversationInstance): void {
  if (!instance.threadId) return;
  useAgentSessionStore.getState().setSessionMeta((meta) => ({
    ...meta,
    activeThreadIds: {
      ...meta.activeThreadIds,
      [instance.agentType]: instance.threadId!,
    },
    activeAgentTypeKey: instance.agentType,
  }));
}
