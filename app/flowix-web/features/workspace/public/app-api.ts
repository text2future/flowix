import { useWorkspaceRestoreStore } from '@features/workspace/store/workspace-restore-store';
export {
  replaceActiveMemoPath,
} from '@features/workspace/use-cases/workspace-navigation';
export {
  removeBrowserColumnTabsByMemoId,
  replaceBrowserColumnMemoPath,
  openBrowserColumnMemoById,
} from '@features/workspace/use-cases/browser-column-navigation';

export function syncAppAgentConversationRestore(instanceId: string | null): void {
  const restore = useWorkspaceRestoreStore.getState();
  if (instanceId) restore.selectAgentConversation(instanceId);
  else restore.closeAgentConversationDetail();
}
