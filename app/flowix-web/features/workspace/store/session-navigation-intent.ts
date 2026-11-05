import type { WorkspaceSessionId } from '../model/workspace-session';
import { useWorkspaceSessionStore } from './workspace-session-store';

export interface SessionNavigationIntent { sessionId: WorkspaceSessionId; requestId: number }

/** Preparation is part of navigation: save barriers must not leave a swappable gap. */
export function reserveSessionNavigationIntent(sessionId: WorkspaceSessionId, entryId?: string): SessionNavigationIntent {
  const store = useWorkspaceSessionStore.getState();
  const requestId = store.sessions[sessionId].navigation.transaction.requestId + 1;
  store.updateSession(sessionId, (session) => ({ ...session, navigation: { ...session.navigation,
    transaction: { ...session.navigation.transaction, phase: 'preparing', requestId, entryId,
      showBlockingLoading: false, pendingTarget: null, failure: null, retryToken: null },
  } }));
  return { sessionId, requestId };
}
export function isSessionNavigationIntentCurrent(intent: SessionNavigationIntent): boolean {
  return useWorkspaceSessionStore.getState().sessions[intent.sessionId].navigation.transaction.requestId === intent.requestId;
}
/** Only settle an unconsumed preparation; a later loader or newer request owns its own state. */
export function releaseSessionNavigationIntent(intent: SessionNavigationIntent): void {
  useWorkspaceSessionStore.getState().updateSession(intent.sessionId, (session) => {
    const navigation = session.navigation;
    if (navigation.transaction.requestId !== intent.requestId || navigation.transaction.phase !== 'preparing') return session;
    return { ...session, navigation: { ...navigation, transaction: { ...navigation.transaction,
      phase: navigation.current ? 'committed' : 'idle', entryId: undefined,
    } } };
  });
}
