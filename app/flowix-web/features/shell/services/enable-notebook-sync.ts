import { getCloudSyncAccess } from '@/lib/cloud-account';
import { cloud } from '@platform/tauri/client';

/** Resolve access before changing the notebook; callers decide how to present blockers. */
export async function enableNotebookSync(
  notebookId: string,
  isCurrent: () => boolean = () => true,
): Promise<'enabled' | 'login' | 'storage' | 'cancelled'> {
  let access = await cloud.getStorageAccess();
  if (!isCurrent()) return 'cancelled';
  if (access.target === 'official' && !access.canUpload) {
    let state = await cloud.getState();
    if (!isCurrent()) return 'cancelled';
    if (!state.authenticated) return 'login';
    if (getCloudSyncAccess(state).restriction === 'verifying') {
      await cloud.refreshMembership();
      if (!isCurrent()) return 'cancelled';
      state = await cloud.getState();
      if (!isCurrent() || !state.authenticated) return 'cancelled';
      access = await cloud.getStorageAccess();
      if (!isCurrent()) return 'cancelled';
    }
  }
  if (!access.canUpload) return 'storage';
  await cloud.setNotebookEnabled(notebookId, true);
  return isCurrent() ? 'enabled' : 'cancelled';
}
