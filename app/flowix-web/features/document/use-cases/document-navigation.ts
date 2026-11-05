import { navigateWorkspaceSession } from '@features/workspace/public/session-navigation-api';

export type DocumentHistoryDirection = 'back' | 'forward';

/** Deprecated entry point; both sessions use the same navigation transaction. */
export async function navigateDocumentHistory(direction: DocumentHistoryDirection): Promise<boolean> {
  return Boolean(await navigateWorkspaceSession('column-1', direction));
}
