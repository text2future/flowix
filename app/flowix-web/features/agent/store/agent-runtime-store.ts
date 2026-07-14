import { create } from 'zustand';
import { agent, type AgentRuntimeAvailability } from '@platform/tauri/client';
import type { AgentTypeKey } from '@/types/agent';

const RUNTIME_STATUS_TTL_MS = 120_000;

type RuntimeStatusByType = Partial<Record<AgentTypeKey, AgentRuntimeAvailability>>;

let inFlightRefresh: Promise<void> | null = null;

export interface AgentRuntimeState {
  statusByType: RuntimeStatusByType;
  isChecking: boolean;
  lastCheckedAt: number | null;
  refresh: (options?: { force?: boolean; type?: AgentTypeKey }) => Promise<void>;
  refreshIfStale: () => Promise<void>;
  refreshFlowix: () => Promise<void>;
}

function isFresh(lastCheckedAt: number | null): boolean {
  return lastCheckedAt !== null && Date.now() - lastCheckedAt < RUNTIME_STATUS_TTL_MS;
}

export const useAgentRuntimeStore = create<AgentRuntimeState>((set, get) => ({
  statusByType: {},
  isChecking: false,
  lastCheckedAt: null,

  refresh: async (options) => {
    const { force = false, type } = options ?? {};
    if (!force && isFresh(get().lastCheckedAt)) return;

    if (inFlightRefresh) {
      await inFlightRefresh;
      if (!force && isFresh(get().lastCheckedAt)) return;
    }

    set({ isChecking: true });
    const refreshTask = (async () => {
      const status = await agent.runtimeStatus();
      set((current) => {
        const nextStatus: RuntimeStatusByType = type
          ? { ...current.statusByType, [type]: status[type] }
          : status;
        return {
          statusByType: nextStatus,
          lastCheckedAt: Date.now(),
          isChecking: false,
        };
      });
    })();

    inFlightRefresh = refreshTask;
    try {
      await refreshTask;
    } catch (err) {
      console.warn('[agent-runtime-store] Failed to refresh runtime status:', err);
      set({ isChecking: false });
    } finally {
      if (inFlightRefresh === refreshTask) {
        inFlightRefresh = null;
      }
    }
  },

  refreshIfStale: async () => {
    await get().refresh();
  },

  refreshFlowix: async () => {
    await get().refresh({ force: true, type: 'flowix' });
  },
}));
