import { useUserSettings } from '@features/preferences/hooks/use-user-settings';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
export { useApplyFontSettings } from '@features/preferences/hooks/use-apply-font-settings';

export function useAppPreferencesViewModel() {
  const language = useUserSettings((settings) => settings.language);
  const format = useUserSettings((settings) => settings.format);
  const shortcutOverrides = useUserSettings((settings) => settings.shortcuts);
  const loadInitial = useUserSettingsStore((state) => state.loadInitial);
  const flushPending = useUserSettingsStore((state) => state.flushPending);
  return { language, format, shortcutOverrides, loadInitial, flushPending };
}

export function useAppUpdatePreferences() {
  const enabled = useUserSettings((settings) => settings.productUpdates.enabled);
  const loading = useUserSettingsStore((state) => state.isLoading);
  return { enabled, loading };
}
