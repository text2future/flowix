import { emptySessionTransaction, type SessionNavigationState } from './session-navigation';
import type { WorkspaceWebRuntime } from './surface-contract';
import type { WorkspaceSurfaceHost } from './surface-contract';

/** Runtime identity is stable across placement changes; it is not a physical host. */
export type WorkspaceSessionRuntimeId = 'primary-runtime' | 'secondary-runtime';
export type WorkspaceSessionId = 'primary-session' | 'secondary-session';

export interface WorkspaceSession {
  id: WorkspaceSessionId;
  /** Stable renderer/lifecycle namespace. It does not own a separate state model. */
  runtime: WorkspaceSessionRuntimeId;
  headerState: Record<string, { addressBarVisible: boolean }>;
  navigation: SessionNavigationState;
  viewStates: Record<string, { webRuntime?: WorkspaceWebRuntime | null; recovery?: import('./session-view-state').SessionViewRecovery }>;
  notebookSwitchesInFlight: number;
}

export interface WorkspacePlacement {
  hosts: Record<WorkspaceSurfaceHost, WorkspaceSessionId>;
  revision: number;
}

export function createWorkspaceSession(id: WorkspaceSessionId, runtime: WorkspaceSessionRuntimeId): WorkspaceSession {
  return { id, runtime, headerState: {}, viewStates: {}, notebookSwitchesInFlight: 0,
    navigation: { current: null, backStack: [], forwardStack: [], transaction: emptySessionTransaction() } };
}

export function initialWorkspaceSessions(): Record<WorkspaceSessionId, WorkspaceSession> {
  return {
    'primary-session': createWorkspaceSession('primary-session', 'primary-runtime'),
    'secondary-session': createWorkspaceSession('secondary-session', 'secondary-runtime'),
  };
}

export const INITIAL_WORKSPACE_SESSIONS = initialWorkspaceSessions();

export function initialWorkspacePlacement(): WorkspacePlacement {
  return { hosts: { 'main-third': 'primary-session', 'browser-column': 'secondary-session' }, revision: 0 };
}
