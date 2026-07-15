import { create } from 'zustand';
import { cli, type CliLinkStatus } from '@platform/tauri/client';

const CLI_STATUS_TTL_MS = 120_000;

let inFlightRefresh: Promise<void> | null = null;

interface CliLinkStatusState {
  status: CliLinkStatus | null;
  isChecking: boolean;
  isInstalling: boolean;
  error: string | null;
  lastCheckedAt: number | null;
  refresh: (options?: { force?: boolean }) => Promise<void>;
  refreshIfStale: () => Promise<void>;
  installPath: () => Promise<void>;
}

function isFresh(lastCheckedAt: number | null): boolean {
  return lastCheckedAt !== null && Date.now() - lastCheckedAt < CLI_STATUS_TTL_MS;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useCliLinkStatusStore = create<CliLinkStatusState>((set, get) => ({
  status: null,
  isChecking: false,
  isInstalling: false,
  error: null,
  lastCheckedAt: null,

  refresh: async (options) => {
    const { force = false } = options ?? {};
    if (!force && isFresh(get().lastCheckedAt)) return;

    if (inFlightRefresh) {
      try {
        await inFlightRefresh;
      } catch {
        // The owner refresh call records the error in the store.
      }
      if (!force && isFresh(get().lastCheckedAt)) return;
    }

    set({ isChecking: true, error: null });
    const refreshTask = (async () => {
      const status = await cli.linkStatus();
      set({
        status,
        lastCheckedAt: Date.now(),
        isChecking: false,
        error: null,
      });
    })();

    inFlightRefresh = refreshTask;
    try {
      await refreshTask;
    } catch (error) {
      set({ isChecking: false, error: errorMessage(error) });
    } finally {
      if (inFlightRefresh === refreshTask) {
        inFlightRefresh = null;
      }
    }
  },

  refreshIfStale: async () => {
    await get().refresh();
  },

  installPath: async () => {
    set({ isInstalling: true, error: null });
    try {
      const status = await cli.installPath();
      set({
        status,
        lastCheckedAt: Date.now(),
        isInstalling: false,
        error: null,
      });
    } catch (error) {
      set({ isInstalling: false, error: errorMessage(error) });
    }
  },
}));
