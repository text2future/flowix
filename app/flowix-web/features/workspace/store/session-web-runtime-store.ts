import { createPrimaryWebRuntimeFacade } from './session-compatibility';

/** Deprecated selector/action facade. Web state is owned by WorkspaceSession.viewStates. */
export const useSessionWebRuntimeStore = createPrimaryWebRuntimeFacade((set) => ({
  runtimes: {},
  setRuntime: (viewId, runtime) => set((state) => ({
    runtimes: Object.fromEntries([...Object.entries(state.runtimes).filter(([key]) => key !== viewId),
      [viewId, runtime] as const].slice(-100)),
  })),
}));
