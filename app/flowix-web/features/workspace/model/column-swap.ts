import type { WorkspaceSession } from './workspace-session';

/** Shared by the UI selector and the execution guard. */
export function canSwapSessions(sessions: Record<string, WorkspaceSession>): boolean {
  return Object.values(sessions).every((session) =>
    session.notebookSwitchesInFlight === 0 && session.navigation.transaction.phase !== 'loading'
    && session.navigation.transaction.phase !== 'preparing');
}
