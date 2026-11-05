export { useWorkspaceSessionStore, getColumnSessionId, getColumnIdForSession, getSessionId } from '../store/workspace-session-store';
export type { WorkspaceSession, WorkspaceSessionReference, WorkspaceSessionId, WorkspaceColumnIndex, WorkspacePlacement } from '../model/workspace-session';
export type { SessionSurfaceTarget } from '../model/session-target';

import { useWorkspaceSessionStore } from '../store/workspace-session-store';
import type { WorkspaceColumnId } from '../model/surface-contract';

/** Stable identity; swapping layout indices never changes a renderer's session. */
export function useColumnSessionId(columnId: WorkspaceColumnId) {
  return columnId;
}

export function useColumnIndex(columnId: WorkspaceColumnId): 0 | 1 {
  return useWorkspaceSessionStore((state) => state.placement[0] === columnId ? 0 : 1);
}

export function columnAtIndex(index: 0 | 1): WorkspaceColumnId {
  return useWorkspaceSessionStore.getState().placement[index];
}
