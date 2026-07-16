import { describe, expect, it, vi } from 'vitest';
import { syncUserConfigChange } from './user-config-sync';

describe('syncUserConfigChange', () => {
  it('reloads preferences without refreshing runtime for preference changes', () => {
    const reloadPreferences = vi.fn();
    const refreshAgentRuntime = vi.fn();

    syncUserConfigChange('preference', {
      reloadPreferences,
      refreshAgentRuntime,
    });

    expect(reloadPreferences).toHaveBeenCalledOnce();
    expect(refreshAgentRuntime).not.toHaveBeenCalled();
  });

  it('refreshes the complete agent runtime snapshot for AI config changes', () => {
    const reloadPreferences = vi.fn();
    const refreshAgentRuntime = vi.fn();

    syncUserConfigChange('ai_config', {
      reloadPreferences,
      refreshAgentRuntime,
    });

    expect(refreshAgentRuntime).toHaveBeenCalledOnce();
    expect(reloadPreferences).not.toHaveBeenCalled();
  });
});
