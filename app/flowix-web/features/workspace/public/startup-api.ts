import { restoreAgentConversationWorkspace as restore } from '@features/workspace/use-cases/agent-conversation-navigation';
import { useWorkspaceRestoreStore } from '@features/workspace/store/workspace-restore-store';
export {
  captureWorkspaceRestoreTarget,
  restoreLegacyFolderListWorkspace,
  restoreExternalDocumentWorkspace,
  restoreMediaWorkspace,
  restoreTableWorkspace,
  restoreCollectionWorkspace,
  restoreFolderCollectionWorkspace,
} from '@features/workspace/use-cases/workspace-navigation';
export type { PersistedWorkspaceTarget } from '@features/workspace/store/workspace-restore-store';

export function setWorkspaceRestoreStatus(status: 'restoring' | 'restored' | 'unavailable'): void {
  useWorkspaceRestoreStore.getState().setRestoreStatus(status);
}

/** Application bootstrap contract; keeps startup imports isolated from the use-case module graph. */
export async function restoreAgentConversationWorkspace(restoreRequestId?: number): Promise<void> {
  await restore(restoreRequestId);
}

/** Compatibility restore for session targets now supported by both runtimes. */
export async function restoreSessionTarget(
  target: Extract<import('../store/workspace-restore-store').PersistedWorkspaceTarget, { kind: 'web' | 'file-browser' | 'plugin-workbench' }>,
  requestId: number,
) {
  const { useWorkColumnStore } = await import('../store/work-column-store');
  if (useWorkColumnStore.getState().navigation.requestId !== requestId) return;
  const { openWorkspaceSurface } = await import('../use-cases/surface-opening');
  if (useWorkColumnStore.getState().navigation.requestId !== requestId) return;
  await openWorkspaceSurface({ host: 'column-1', target, options: { history: 'skip' } });
}
