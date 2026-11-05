import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { cloud } from '@platform/tauri/client';
import { isMembershipActive } from '@/lib/membership';
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

export function useMemoListViewPreference() {
  return useUserSettingsStore((state) => state.settings.memoListView);
}

/**
 * 「访问空间」文件树的显示口径：是否展示点开头的隐藏文件夹、是否展示
 * attachments / node_modules 等系统文件夹。两个值都只影响列举显示，不改变
 * 索引、watcher 与访问鉴权。过滤本身在 Rust 侧完成（读 `boot/preference.json`），
 * 前端拿到的是已经筛过的树；值变化时需要让树重新拉一次。
 */
export function useSpaceTreeVisibility() {
  const showHiddenFolders = useUserSettingsStore(
    (state) => state.settings.spaceShowHiddenFolders,
  );
  const showSystemFolders = useUserSettingsStore(
    (state) => state.settings.spaceShowSystemFolders,
  );
  return { showHiddenFolders, showSystemFolders };
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

export async function setThemePreference(theme: UserSettings['theme']): Promise<boolean> {
  if (theme === 'mist') {
    try {
      const state = await cloud.getState();
      if (!state.authenticated) return false;
      const membership = await cloud.refreshMembership();
      if (!isMembershipActive(membership)) return false;
    } catch {
      return false;
    }
  }
  await useUserSettingsStore.getState().updateSettings({ theme });
  return true;
}
