import type { SessionSurfaceTarget } from './session-target';
import type { WorkspaceSurfaceOpenTarget } from './surface-target';

export interface SessionNavigationEntry {
  /** Stable within the runtime's retained history. */
  id: string;
  target: WorkspaceSurfaceOpenTarget;
  title: string;
  icon: string | null;
  openedAt: number;
}

export interface SessionNavigationState {
  current: SessionCurrentEntry | null;
  backStack: SessionNavigationEntry[];
  forwardStack: SessionNavigationEntry[];
  transaction: SessionNavigationTransaction;
}

export type SessionCurrentEntry = Omit<SessionNavigationEntry, 'target'> & {
  target: SessionSurfaceTarget;
};
export type SessionNavigationPhase = 'idle' | 'preparing' | 'loading' | 'committed' | 'failed';
export interface SessionNavigationFailure {
  code: 'navigation-failed' | 'navigation-stale';
  message: string;
  requestId: number;
  retryToken: string | null;
}
export interface SessionNavigationTransaction {
  phase: SessionNavigationPhase;
  showBlockingLoading: boolean;
  requestId: number;
  pendingTarget: SessionSurfaceTarget | null;
  previousTarget: SessionSurfaceTarget | null;
  failure: SessionNavigationFailure | null;
  retryToken: string | null;
  entryId?: string;
}

export function emptySessionTransaction(): SessionNavigationTransaction {
  return { phase: 'idle', showBlockingLoading: false, requestId: 0, pendingTarget: null,
    previousTarget: null, failure: null, retryToken: null };
}

export { SESSION_HISTORY_LIMIT } from './session-limits';
