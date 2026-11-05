import { sessionFor } from '../model/workspace-session';
import { EMPTY_WORK_COLUMN_TARGET, type WorkColumnTarget } from './work-column-target';
import { useWorkspaceSessionStore } from './workspace-session-store';
import type { SessionNavigationState } from '../model/session-navigation';
import type { WorkspaceSession, WorkspaceSessionReference } from '../model/workspace-session';

/** Column-facing compatibility boundary. Resolve stable session IDs before async work. */
export function columnSession(id: WorkspaceSessionReference): WorkspaceSession {
  return sessionFor(useWorkspaceSessionStore.getState(), id);
}

export function columnNavigation(id: WorkspaceSessionReference): SessionNavigationState {
  return columnSession(id).navigation;
}

/** The target a column currently shows; `empty` until something is committed. */
export function columnTarget(id: WorkspaceSessionReference): WorkColumnTarget {
  return columnNavigation(id).current?.target ?? EMPTY_WORK_COLUMN_TARGET;
}

export function columnRequestId(id: WorkspaceSessionReference): number {
  return columnNavigation(id).transaction.requestId;
}

export function useColumnNavigation<T>(id: WorkspaceSessionReference, selector: (navigation: SessionNavigationState) => T): T {
  return useWorkspaceSessionStore((root) => selector(sessionFor(root, id).navigation));
}

export function useColumnTarget(id: WorkspaceSessionReference): WorkColumnTarget {
  return useWorkspaceSessionStore((root) => sessionFor(root, id).navigation.current?.target ?? EMPTY_WORK_COLUMN_TARGET);
}
