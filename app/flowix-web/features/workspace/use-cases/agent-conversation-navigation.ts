import { hydrateWorkspaceAgentConversation } from '@features/agent/public/workspace-api';
import { useWorkspaceRestoreStore } from '@features/workspace/store/workspace-restore-store';
import { closeAgentTarget, openAgentTarget } from './workspace-navigation';

export async function selectAndOpenAgentConversation(
  instanceId: string,
  options?: { history?: 'push' | 'skip' },
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
  const restore = useWorkspaceRestoreStore.getState().agentConversation;
  const instanceId = restore.selectedInstanceId?.trim() ?? '';
  if (!instanceId) return;

  const instance = await hydrateWorkspaceAgentConversation(instanceId);
  if (!instance) {
    useWorkspaceRestoreStore.getState().clearAgentConversation(instanceId);
    return;
  }

  // Selection belongs to the conversations list, while the detail is a
  // separate work-column target. Reopen it independently of the current
  // middle-column filter so switching lists does not lose the detail.
  if (restore.detailOpen) {
    await selectAndOpenAgentConversation(instanceId, { history: 'skip' });
  }
}
