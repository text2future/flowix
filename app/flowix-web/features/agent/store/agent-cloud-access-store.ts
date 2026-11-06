import { create } from 'zustand';
import type { CloudAccessKind } from '@features/agent/config/cloud-access';

/**
 * Per-conversation Cloud access notice.
 *
 * Keyed by the durable thread id so two conversations in different columns do
 * not inherit each other's notice. Not persisted: a fresh launch re-reads the
 * real Cloud session and the first run reports the actual state again.
 */
interface AgentCloudAccessStore {
  entries: Record<string, CloudAccessKind>;
  setAccess: (threadId: string, kind: CloudAccessKind) => void;
  clearAccess: (threadId: string) => void;
  clearAll: () => void;
}

export const useAgentCloudAccessStore = create<AgentCloudAccessStore>()((set) => ({
  entries: {},
  setAccess: (threadId, kind) => set((state) => (
    state.entries[threadId] === kind
      ? state
      : { entries: { ...state.entries, [threadId]: kind } }
  )),
  clearAccess: (threadId) => set((state) => {
    if (!(threadId in state.entries)) return state;
    const entries = { ...state.entries };
    delete entries[threadId];
    return { entries };
  }),
  clearAll: () => set((state) => (
    Object.keys(state.entries).length === 0 ? state : { entries: {} }
  )),
}));

export function selectCloudAccessKind(threadId: string | null | undefined): CloudAccessKind | null {
  if (!threadId) return null;
  return useAgentCloudAccessStore.getState().entries[threadId] ?? null;
}
