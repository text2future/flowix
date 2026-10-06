import { hydrateWorkspaceAgentConversation } from '@features/agent/public/workspace-api';
import { useWorkspaceRestoreStore } from '@features/workspace/store/workspace-restore-store';
import { closeAgentTarget, openAgentTarget } from './workspace-navigation';

export async function selectAndOpenAgentConversation(
  instanceId: string,
  options?: { history?: 'push' | 'skip'; destination?: 'main-third' },
): Promise<void> {
  const normalized = instanceId.trim();
  if (!normalized) return;

  const host = await openAgentTarget(normalized, options);
  useWorkspaceRestoreStore.getState().selectAgentConversation(
    normalized,
    host === 'main-third',
  );
}

export function closeAgentConversationDetail(): void {
  closeAgentTarget();
  useWorkspaceRestoreStore.getState().closeAgentConversationDetail();
}

export function clearRestoredAgentConversation(instanceId: string): void {
  useWorkspaceRestoreStore.getState().clearAgentConversation(instanceId);
}

export async function restoreAgentConversationWorkspace(): Promise<void> {
  const store = useWorkspaceRestoreStore.getState();
  const desiredTarget = store.desiredTarget;
  const instanceId = desiredTarget?.kind === 'agent-conversation'
    ? desiredTarget.instanceId.trim()
    : '';
  if (!instanceId) return;

  try {
    await hydrateWorkspaceAgentConversation(instanceId);
  } catch (error) {
    console.error('Failed to restore agent conversation:', error);
  }

  // The detail owns missing/error presentation and retry. Keep the restored
  // target visible even when this eager lookup did not return an instance.
  await selectAndOpenAgentConversation(instanceId, { history: 'skip' });
}
