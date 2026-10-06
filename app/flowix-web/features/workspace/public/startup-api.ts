import { restoreAgentConversationWorkspace as restore } from '@features/workspace/use-cases/agent-conversation-navigation';
import { useWorkspaceRestoreStore } from '@features/workspace/store/workspace-restore-store';
export {
  captureWorkspaceRestoreTarget,
  restoreDocumentListWorkspace,
  restoreExternalDocumentWorkspace,
  restoreMediaWorkspace,
  restoreTableWorkspace,
} from '@features/workspace/use-cases/workspace-navigation';
export type { PersistedWorkspaceTarget } from '@features/workspace/store/workspace-restore-store';

export function setWorkspaceRestoreStatus(status: 'restoring' | 'restored' | 'unavailable'): void {
  useWorkspaceRestoreStore.getState().setRestoreStatus(status);
}

/** Application bootstrap contract; keeps startup imports isolated from the use-case module graph. */
export async function restoreAgentConversationWorkspace(): Promise<void> {
  await restore();
}
