import { useWorkspaceRestoreStore } from '@features/workspace/store/workspace-restore-store';
export { ensureFileDisplayTrackingStarted } from '@features/workspace/use-cases/file-display-tracking';
export {
  removeBrowserColumnTabsByPath,
  openBrowserColumnNotebookNote,
} from '@features/workspace/use-cases/browser-column-navigation';
export { applyNotebookPathMove } from '@features/workspace/use-cases/notebook-path-move';

export function syncAppAgentConversationRestore(instanceId: string | null): void {
  const restore = useWorkspaceRestoreStore.getState();
  if (instanceId) restore.selectAgentConversation(instanceId);
  else restore.closeAgentConversationDetail();
}
