import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';

export function recordProductUpdateCheck(): Promise<void> {
  return useUserSettingsStore.getState().updateSettings({
    productUpdates: { lastCheckedAt: Date.now() },
  });
}
