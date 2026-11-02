export {
  getWorkspaceSessionNavigation, navigateWorkspaceSession, navigateWorkspaceHost,
  subscribeWorkspaceSessionNavigation,
} from '../use-cases/session-navigation';
export type { SessionNavigationState, SessionNavigationEntry } from '../model/session-navigation';

import { useCallback, useSyncExternalStore } from 'react';
import { getWorkspaceSessionNavigation, navigateWorkspaceSession, subscribeWorkspaceSessionNavigation } from '../use-cases/session-navigation';
import type { WorkspaceSessionId } from '../model/workspace-session';

export function useWorkspaceSessionNavigation(sessionId: WorkspaceSessionId) {
  const availability = useSyncExternalStore(subscribeWorkspaceSessionNavigation, () => {
    const state = getWorkspaceSessionNavigation(sessionId);
    return (state.backStack.length ? 1 : 0) | (state.forwardStack.length ? 2 : 0);
  });
  const back = useCallback(() => navigateWorkspaceSession(sessionId, 'back'), [sessionId]);
  const forward = useCallback(() => navigateWorkspaceSession(sessionId, 'forward'), [sessionId]);
  return { canNavigateBack: Boolean(availability & 1), canNavigateForward: Boolean(availability & 2), back, forward };
}
