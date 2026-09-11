import { resolveNotebookAgentFiles } from '@/lib/agent-access-defaults';
import { useAgentAccessStore } from '@features/agent/store/agent-access-store';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';

/** Restore a persisted conversation through the Agent-owned session lifecycle. */
export async function hydrateWorkspaceAgentConversation(instanceId: string) {
  return useAgentSessionStore.getState().hydrateInstance(instanceId);
}

/** Resolve resource roots without exposing Agent access configuration stores. */
export function getWorkspaceAgentResourceFolders(notebookId: string | null): string[] {
  const access = useAgentAccessStore.getState();
  return resolveNotebookAgentFiles(
    access.config,
    access.notebookConfigs,
    notebookId,
  )?.folders ?? [];
}

