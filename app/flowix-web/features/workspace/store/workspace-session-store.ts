import { commitSessionTarget, type CommitSessionTargetOptions } from '../model/session-navigation-reducer';
import { migrateLegacySessionData, record, restoreCanonicalSession, restoreBrowserLayout } from './session-persistence';
import { BROWSER_COLUMN_DEFAULT_SPLIT_RATIO } from '../model/browser-column-layout';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { initialWorkspaceSessions, initialWorkspacePlacement, type WorkspacePlacement, type WorkspaceSessionId } from '../model/workspace-session';
import type { WorkspaceSurfaceHost } from '../model/surface-contract';

export interface WorkspaceSessionState extends WorkspacePlacement {
  sessions: ReturnType<typeof initialWorkspaceSessions>;
  browserLayout: { visible: boolean; splitRatio: number };
  commitTarget: (id: WorkspaceSessionId, target: import('../model/session-target').SessionSurfaceTarget, options?: CommitSessionTargetOptions) => boolean;
  updateSession: (id: WorkspaceSessionId, update: (session: import('../model/workspace-session').WorkspaceSession) => import('../model/workspace-session').WorkspaceSession) => void;
  setBrowserLayout: (patch: Partial<WorkspaceSessionState['browserLayout']>) => void;
  setAddressBarVisible: (sessionId: WorkspaceSessionId, surfaceId: string, visible: boolean) => void;
  swap: (expectedRevision?: number) => boolean;
  reset: () => void;
}

/**
 * Placement alone changes during a swap. Runtime IDs, navigation histories,
 * Header state, editor sessions, and pending resources retain their ownership.
 * Persisted placement reconnects the same runtime adapters during restoration.
 */
export const useWorkspaceSessionStore = create<WorkspaceSessionState>()(persist((set, get) => ({
  ...initialWorkspacePlacement(),
  ...migrateLegacySessionData(),
  commitTarget: (id, target, options) => {
    const state = get();
    const session = commitSessionTarget(state.sessions[id], target, options);
    if (session === state.sessions[id]) return false;
    set({ sessions: { ...state.sessions, [id]: session } });
    return true;
  },
  updateSession: (id, update) => {
    const state = get();
    const session = update(state.sessions[id]);
    if (session !== state.sessions[id]) set({ sessions: { ...state.sessions, [id]: session } });
  },
  setBrowserLayout: (patch) => {
    const state = get();
    const next = { ...state.browserLayout, ...patch };
    if (next.visible !== state.browserLayout.visible || next.splitRatio !== state.browserLayout.splitRatio) set({ browserLayout: next });
  },
  setAddressBarVisible: (sessionId, surfaceId, visible) => set((state) => ({
    sessions: { ...state.sessions, [sessionId]: {
      ...state.sessions[sessionId],
      headerState: Object.fromEntries([...Object.entries(state.sessions[sessionId].headerState).filter(([key]) => key !== surfaceId),
        [surfaceId, { addressBarVisible: visible }]].slice(-200)),
    } },
  })),
  swap: (expectedRevision) => {
    const state = get();
    if (expectedRevision !== undefined && state.revision !== expectedRevision) return false;
    set({
      hosts: { 'main-third': state.hosts['browser-column'], 'browser-column': state.hosts['main-third'] },
      revision: state.revision + 1,
    });
    return true;
  },
  reset: () => set((state) => ({ ...initialWorkspacePlacement(), sessions: initialWorkspaceSessions(), browserLayout: { visible: false, splitRatio: BROWSER_COLUMN_DEFAULT_SPLIT_RATIO }, revision: state.revision + 1 })),
}), {
  name: 'flowix.workspace.session-placement',
  version: 2,
  migrate: (persisted) => persisted,
  partialize: (state) => ({ hosts: state.hosts, sessions: state.sessions, browserLayout: state.browserLayout }),
  merge: (persisted, current) => {
    if (!record(persisted)) return current;
    const sessions = { ...current.sessions };
    const savedSessions = record(persisted.sessions) ? persisted.sessions : {};
    for (const id of ['primary-session', 'secondary-session'] as const) {
      sessions[id] = restoreCanonicalSession(savedSessions[id], sessions[id]);
    }
    const hosts = record(persisted.hosts) ? persisted.hosts : {};
    const a = hosts['main-third'];
    const b = hosts['browser-column'];
    const valid = (a === 'primary-session' || a === 'secondary-session')
      && (b === 'primary-session' || b === 'secondary-session') && a !== b;
    return { ...current, sessions,
      browserLayout: restoreBrowserLayout(persisted.browserLayout, current.browserLayout),
      hosts: valid ? { 'main-third': a, 'browser-column': b } : current.hosts };
  },
}));

export function getSessionRuntimeAtHost(host: WorkspaceSurfaceHost): WorkspaceSurfaceHost {
  const state = useWorkspaceSessionStore.getState();
  return state.sessions[state.hosts[host]].runtime === 'primary-runtime' ? 'main-third' : 'browser-column';
}

export function getHostForSessionRuntime(runtime: WorkspaceSurfaceHost): WorkspaceSurfaceHost {
  return getSessionRuntimeAtHost('main-third') === runtime ? 'main-third' : 'browser-column';
}

export function getSessionAtHost(host: WorkspaceSurfaceHost): WorkspaceSessionId {
  return useWorkspaceSessionStore.getState().hosts[host];
}
