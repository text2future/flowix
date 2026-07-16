export type UserConfigChangeKind = 'preference' | 'ai_config';

interface UserConfigSyncActions {
  reloadPreferences: () => void | Promise<void>;
  refreshAgentRuntime: () => void | Promise<void>;
}

/**
 * Route a persisted user-config change to the in-memory state it invalidates.
 *
 * Tauri windows run separate JavaScript contexts, so each window must update
 * its own stores after receiving the backend broadcast.
 */
export function syncUserConfigChange(
  kind: UserConfigChangeKind,
  actions: UserConfigSyncActions,
): void {
  if (kind === 'preference') {
    void actions.reloadPreferences();
    return;
  }

  // Runtime freshness currently has one timestamp for the complete status
  // snapshot. Refresh the complete snapshot so unrelated agent statuses are
  // not marked fresh after only Flowix was updated.
  void actions.refreshAgentRuntime();
}
