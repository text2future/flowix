import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import type { AgentTypeKey } from '@/types/agent';
import type { UserSettings } from '@/lib/constants';

export function getCurrentAppLanguage() {
  return useUserSettingsStore.getState().settings.language;
}

export function useAppLanguage() {
  return useUserSettingsStore((state) => state.settings.language);
}

export function useAppTheme() {
  return useUserSettingsStore((state) => state.settings.theme);
}

export function isAgentTypeEnabled(typeKey: AgentTypeKey): boolean {
  return useUserSettingsStore.getState().settings.agents.enabledByType[typeKey] ?? true;
}

export function useEditorTypography() {
  const fontSize = useUserSettingsStore((state) => state.settings.format.fontSize);
  const lineHeight = useUserSettingsStore((state) => state.settings.format.lineHeight);
  return { fontSize, lineHeight };
}

export function usePropertyFieldPreferences() {
  const fields = useUserSettingsStore((state) => state.settings.properties.fields);
  const updateSettings = useUserSettingsStore((state) => state.updateSettings);
  return {
    fields,
    saveFields: (nextFields: typeof fields) => updateSettings({ properties: { fields: nextFields } }),
  };
}

export function useAgentVisibilityPreferences() {
  const enabledByType = useUserSettingsStore((state) => state.settings.agents.enabledByType);
  const updateSettings = useUserSettingsStore((state) => state.updateSettings);
  return {
    enabledByType,
    setEnabled: (typeKey: AgentTypeKey, enabled: boolean) => updateSettings({
      agents: { enabledByType: { ...enabledByType, [typeKey]: enabled } },
    }),
  };
}

export function useMemoNavigationPreferences() {
  return useUserSettingsStore((state) => state.settings.personalize.showConversationEntry);
}

export function useMemoListViewPreference() {
  return useUserSettingsStore((state) => state.settings.memoListView);
}

export function setMemoListViewPreference(
  view: UserSettings['memoListView'],
): Promise<void> {
  return useUserSettingsStore.getState().updateSettings({ memoListView: view });
}

export function subscribeAppLanguage(listener: () => void): () => void {
  return useUserSettingsStore.subscribe((state, previous) => {
    if (state.settings.language !== previous.settings.language) listener();
  });
}

export function subscribeEditorRuntimePreferences(listener: () => void): () => void {
  return useUserSettingsStore.subscribe((state, previous) => {
    if (state.settings.agents !== previous.settings.agents
      || state.settings.language !== previous.settings.language) listener();
  });
}

export function getThemePreference(): UserSettings['theme'] {
  return useUserSettingsStore.getState().settings.theme;
}

export function setThemePreference(theme: UserSettings['theme']): Promise<void> {
  return useUserSettingsStore.getState().updateSettings({ theme });
}
