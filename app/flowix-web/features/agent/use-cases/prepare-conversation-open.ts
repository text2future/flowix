import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';

/**
 * Prepare a conversation that arrived from a read model (file-tree row, list
 * page, search hit) for opening in a column.
 *
 * Two invariants keep the columns independent of each other:
 *
 * 1. The registry stays authoritative. A snapshot may only complete missing
 *    facts, so opening a row never downgrades the instance another column is
 *    already rendering (`ensureInstance` keeps the identity when nothing is
 *    missing).
 * 2. Only the runtime slot moves, and only when it actually changes. Which
 *    column *displays* which conversation is owned by that column's navigation
 *    target (`useActiveAgentConversationInstanceId` reads the targets, not this
 *    slot), so activation here cannot repaint the other column.
 */
export function prepareConversationForOpen(instance: AgentConversationInstance): void {
  const store = useAgentSessionStore.getState();
  const authoritative = store.ensureInstance(instance);
  if (authoritative.threadId) {
    store.setActiveAgentThread(authoritative.agentType, authoritative.threadId);
  }
}
