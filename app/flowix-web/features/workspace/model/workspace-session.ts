import { emptySessionTransaction, type SessionNavigationState } from './session-navigation';
import type { WorkspaceWebRuntime } from './surface-contract';

/** Stable column instances move between zero-based layout positions. */
export type WorkspaceColumnIndex = 0 | 1;
export type WorkspaceColumnId = 'column-1' | 'column-2';
export type WorkspaceSessionId = WorkspaceColumnId;
/** Column references are accepted only at the compatibility/navigation boundary. */
export type WorkspaceSessionReference = WorkspaceSessionId | WorkspaceColumnIndex;
export type WorkspacePlacement = Record<WorkspaceColumnIndex, WorkspaceSessionId>;
export const initialWorkspacePlacement = (): WorkspacePlacement => ({
  0: 'column-1', 1: 'column-2',
});
export interface SessionPlacementState {
  sessions: Record<WorkspaceSessionId, WorkspaceSession>;
  placement: WorkspacePlacement;
}
export function resolveSessionId(state: SessionPlacementState, reference: WorkspaceSessionReference): WorkspaceSessionId {
  return reference === 0 || reference === 1 ? state.placement[reference] : reference;
}
export function sessionFor(state: SessionPlacementState, reference: WorkspaceSessionReference): WorkspaceSession {
  return state.sessions[resolveSessionId(state, reference)];
}

export interface WorkspaceSession {
  id: WorkspaceSessionId;
  headerState: Record<string, { addressBarVisible: boolean }>;
  navigation: SessionNavigationState;
  viewStates: Record<string, { webRuntime?: WorkspaceWebRuntime | null; recovery?: import('./session-view-state').SessionViewRecovery }>;
  notebookSwitchesInFlight: number;
}

export function createWorkspaceSession(id: WorkspaceSessionId): WorkspaceSession {
  return { id, headerState: {}, viewStates: {}, notebookSwitchesInFlight: 0,
    navigation: { current: null, backStack: [], forwardStack: [], transaction: emptySessionTransaction() } };
}

export function initialWorkspaceSessions(): Record<WorkspaceSessionId, WorkspaceSession> {
  return {
    'column-1': createWorkspaceSession('column-1'),
    'column-2': createWorkspaceSession('column-2'),
  };
}
