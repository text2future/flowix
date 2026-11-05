/** Legacy shapes are read projections or explicit command inputs, never writable state. */
export type * from '../model/legacy-document-history';
export type { SessionNavigationEntry } from '../model/session-navigation';
export { SESSION_HISTORY_LIMIT } from '../model/session-limits';
export { fromDocumentHistory, toDocumentHistory } from '../store/session-legacy-projections';
import { createStoreView } from '@shared/create-store-view';
import { getColumnSessionId, useWorkspaceSessionStore, type WorkspaceSessionState } from '../store/workspace-session-store';
import { sessionFor } from '../model/workspace-session';
import { projectDocumentStack } from '../store/session-legacy-projections';
import type { DocumentHistoryEntry } from '../model/legacy-document-history';
import type { SessionNavigationState } from '../model/session-navigation';

export function createDocumentHistoryView<T extends { backStack: DocumentHistoryEntry[]; forwardStack: DocumentHistoryEntry[] }>(actions: T) {
  return createStoreView<T, WorkspaceSessionState>(useWorkspaceSessionStore, (root, previous) => ({ ...(previous ?? actions),
    backStack: projectDocumentStack(sessionFor(root, 'column-1').navigation.backStack),
    forwardStack: projectDocumentStack(sessionFor(root, 'column-1').navigation.forwardStack),
  }));
}
export function updateDocumentHistory(update: (navigation: SessionNavigationState) => SessionNavigationState) {
  useWorkspaceSessionStore.getState().updateSession(getColumnSessionId('column-1'), (session) => {
    const navigation = update(session.navigation);
    return navigation === session.navigation ? session : { ...session, navigation };
  });
}
