import { retainSessionViewStates } from '../model/session-view-retention';
import { SESSION_HEADER_STATE_LIMIT } from '../model/session-limits';
import { commitSessionTarget, type CommitSessionTargetOptions } from '../model/session-navigation-reducer';
import { record, restoreCanonicalSession, restoreBrowserLayout } from './session-persistence';
import { BROWSER_COLUMN_DEFAULT_SPLIT_RATIO } from '../model/browser-column-layout';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { initialWorkspaceSessions, initialWorkspacePlacement, resolveSessionId, type WorkspacePlacement, type WorkspaceSessionId, type WorkspaceSessionReference } from '../model/workspace-session';

export interface WorkspaceSessionState {
  sessions: ReturnType<typeof initialWorkspaceSessions>;
  placement: WorkspacePlacement;
  browserLayout: { visible: boolean; splitRatio: number };
  commitTarget: (id: WorkspaceSessionId, target: import('../model/session-target').SessionSurfaceTarget, options?: CommitSessionTargetOptions) => boolean;
  updateSession: (id: WorkspaceSessionId, update: (session: import('../model/workspace-session').WorkspaceSession) => import('../model/workspace-session').WorkspaceSession) => void;
  setBrowserLayout: (patch: Partial<WorkspaceSessionState['browserLayout']>) => void;
  /** Exchanges layout indices without replacing either column instance. */
  swapColumnContents: () => void;
  setAddressBarVisible: (id: WorkspaceSessionId, surfaceId: string, visible: boolean) => void;
  reset: () => void;
}

export const useWorkspaceSessionStore = create<WorkspaceSessionState>()(persist((set, get) => ({
  sessions: initialWorkspaceSessions(),
  placement: initialWorkspacePlacement(),
  browserLayout: { visible: false, splitRatio: BROWSER_COLUMN_DEFAULT_SPLIT_RATIO },
  commitTarget: (id, target, options) => {
    const state = get();
    const session = retainSessionViewStates(commitSessionTarget(state.sessions[id], target, options));
    if (session === state.sessions[id]) return false;
    set({ sessions: { ...state.sessions, [id]: session } });
    return true;
  },
  updateSession: (id, update) => {
    const state = get();
    const session = retainSessionViewStates(update(state.sessions[id]));
    if (session !== state.sessions[id]) set({ sessions: { ...state.sessions, [id]: session } });
  },
  setBrowserLayout: (patch) => {
    const state = get();
    const next = { ...state.browserLayout, ...patch };
    if (next.visible !== state.browserLayout.visible || next.splitRatio !== state.browserLayout.splitRatio) set({ browserLayout: next });
  },
  swapColumnContents: () => set((state) => ({ placement: {
    0: state.placement[1],
    1: state.placement[0],
  } })),
  setAddressBarVisible: (sessionId, surfaceId, visible) => {
    set((state) => ({ sessions: { ...state.sessions, [sessionId]: {
      ...state.sessions[sessionId],
      headerState: Object.fromEntries([...Object.entries(state.sessions[sessionId].headerState).filter(([key]) => key !== surfaceId),
        [surfaceId, { addressBarVisible: visible }]].slice(-SESSION_HEADER_STATE_LIMIT)),
    } } }));
  },
  reset: () => set({ sessions: initialWorkspaceSessions(), placement: initialWorkspacePlacement(), browserLayout: { visible: false, splitRatio: BROWSER_COLUMN_DEFAULT_SPLIT_RATIO } }),
}), {
  name: 'flowix.workspace.session-placement',
  version: 6,
  migrate: () => ({}),
  partialize: (state) => ({ sessions: state.sessions, placement: state.placement, browserLayout: state.browserLayout }),
  merge: (persisted, current) => {
    if (!record(persisted)) return current;
    const sessions = { ...current.sessions };
    const savedSessions = record(persisted.sessions) ? persisted.sessions : {};
    const placement = initialWorkspacePlacement();
    if (record(persisted.placement)) {
      const first = persisted.placement[0];
      const second = persisted.placement[1];
      if ((first === 'column-1' || first === 'column-2')
        && (second === 'column-1' || second === 'column-2') && first !== second) {
        placement[0] = first;
        placement[1] = second;
      }
    }
    for (const id of ['column-1', 'column-2'] as const) {
      sessions[id] = restoreCanonicalSession(savedSessions[id], sessions[id]);
    }
    return { ...current, sessions, placement, browserLayout: restoreBrowserLayout(persisted.browserLayout, current.browserLayout) };
  },
}));

/** Column runtime identity is independent of its current layout index. */
export function getColumnSessionId(columnId: 'column-1' | 'column-2'): WorkspaceSessionId {
  return columnId;
}
export function getColumnIdForSession(reference: WorkspaceSessionReference): WorkspaceSessionId {
  return getSessionId(reference);
}

/** Compatibility boundary: capture once before starting asynchronous work. */
export function getSessionId(reference: WorkspaceSessionReference): WorkspaceSessionId {
  return resolveSessionId(useWorkspaceSessionStore.getState(), reference);
}
