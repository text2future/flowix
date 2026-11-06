import { useCallback } from 'react';
import { usePropertyPresetStore } from '@features/properties/property-preset-store';
import { useUserSettings } from '@features/preferences/hooks/use-user-settings';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
export { useApplyFontSettings } from '@features/preferences/hooks/use-apply-font-settings';

export interface AppPreferencesViewModelOptions {
  /**
   * 是否在启动时顺带预加载属性预设。
   *
   * 主窗口默认预载 (笔记树/属性面板马上要用); 偏好设置窗默认不预载——只有
   * 「属性」页需要它, 由该页挂载时按需加载, 省掉设置窗启动期一次多余的 IPC。
   */
  propertyPresets?: boolean;
}

export function useAppPreferencesViewModel({
  propertyPresets = true,
}: AppPreferencesViewModelOptions = {}) {
  const language = useUserSettings((settings) => settings.language);
  const format = useUserSettings((settings) => settings.format);
  const shortcutOverrides = useUserSettings((settings) => settings.shortcuts);
  const loadPreferences = useUserSettingsStore((state) => state.loadInitial);
  const loadPresets = usePropertyPresetStore((state) => state.load);
  const loadInitial = useCallback(async () => {
    if (!propertyPresets) {
      await loadPreferences();
      return;
    }
    await Promise.all([loadPreferences(), loadPresets()]);
  }, [loadPreferences, loadPresets, propertyPresets]);
  const flushPending = useUserSettingsStore((state) => state.flushPending);
  return { language, format, shortcutOverrides, loadInitial, flushPending };
}

export function useAppUpdatePreferences() {
  const enabled = useUserSettings((settings) => settings.productUpdates.enabled);
  const loading = useUserSettingsStore((state) => state.isLoading);
  return { enabled, loading };
}
