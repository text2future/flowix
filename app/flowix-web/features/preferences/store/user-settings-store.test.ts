import { beforeEach, describe, expect, it, vi } from 'vitest';
import { preferences } from '@platform/tauri/client';

// 把 Tauri client 的 preferences IPC 拦截掉, 避免触发真实 IPC。
vi.mock('@platform/tauri/client', () => ({
  preferences: {
    get: vi.fn(async () => ({})),
    patch: vi.fn(async () => undefined),
  },
}));

// 必须在 mock 之后 import store, 让它拿到 mock 过的 client。
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { DEFAULT_USER_SETTINGS, type PropertyFieldConfig } from '@/lib/constants';

const mockedPreferences = vi.mocked(preferences);

describe('user-settings-store · region loadInitial', () => {
  it('persists the notebook folder view', async () => {
    await useUserSettingsStore.getState().updateSettings({ memoListView: 'folders' });
    const after = useUserSettingsStore.getState().settings;
    expect(after.memoListView).toBe('folders');
    expect(after.memoListView).toBe('folders');
  });

  it('keeps persisted mainland region when loading settings', async () => {
    mockedPreferences.get.mockResolvedValueOnce({
      ...DEFAULT_USER_SETTINGS,
      language: 'zh-CN',
      region: 'mainland',
    });
    useUserSettingsStore.setState({
      settings: {
        personalize: {
          customInstruction: '',
          responseLength: 'standard',
          preferredLanguage: 'Simplified Chinese',
          selectedTags: [],
        },
        format: {
          fontFamily: 'serif',
          fontId: 'serif',
          fontSize: 15,
          lineHeight: 1.6,
          documentWidth: 800,
        },
        theme: 'system',
        language: 'zh-CN',
        region: 'mainland',
        memoListView: 'detailed',
        autoOpenCreatedNotesInBrowser: true,
        shortcuts: {},
        properties: { fields: [] },
        agents: { enabledByType: {} },
        productUpdates: { enabled: true, lastCheckedAt: 0 },
      },
      isLoading: true,
    });

    await useUserSettingsStore.getState().loadInitial();

    expect(useUserSettingsStore.getState().settings.region).toBe('mainland');
  });
});

describe('user-settings-store · legacy quickPhrases migration', () => {
  beforeEach(() => {
    useUserSettingsStore.setState({
      settings: {
        personalize: {
          customInstruction: '',
          responseLength: 'standard',
          preferredLanguage: 'Simplified Chinese',
          selectedTags: [],
        },
        format: {
          fontFamily: 'serif',
          fontId: 'serif',
          fontSize: 15,
          lineHeight: 1.6,
          documentWidth: 800,
        },
        theme: 'system',
        language: 'zh-CN',
        region: 'mainland',
        memoListView: 'detailed',
        autoOpenCreatedNotesInBrowser: true,
        shortcuts: {},
        properties: { fields: [] },
        agents: { enabledByType: {} },
        productUpdates: { enabled: true, lastCheckedAt: 0 },
      },
      isLoading: false,
    });
  });

  it('持久化数据里的 quickPhrases 在 loadInitial 后被静默丢弃, 不抛错', async () => {
    mockedPreferences.get.mockResolvedValueOnce({
      ...DEFAULT_USER_SETTINGS,
      // @ts-expect-error -- 故意保留老字段, 验证迁移兜底
      agents: { enabledByType: {}, quickPhrases: [{ id: 'old', title: '老', prompt: 'p' }] },
    });
    await useUserSettingsStore.getState().loadInitial();
    expect(useUserSettingsStore.getState().settings.agents).toEqual({
      enabledByType: {},
    });
  });
});

describe('user-settings-store · property preset sanitization', () => {
  it('drops legacy names, built-in key collisions, and removed URL fields', async () => {
    const fields = [
      { key: 'name', name: '旧别名', type: 'Text' },
      { key: 'priority', name: '旧别名', type: 'Number' },
      { key: 'PRIORITY', name: '旧重复别名', type: 'Text' },
      { key: 'legacy-url', name: '旧链接', type: 'URL' },
    ] as unknown as PropertyFieldConfig[];

    await useUserSettingsStore.getState().updateSettings({ properties: { fields } });

    expect(useUserSettingsStore.getState().settings.properties.fields).toEqual([
      { key: 'priority', type: 'Number', options: undefined },
    ]);
  });

  it('migrates the removed List preset type to MultiSelect', async () => {
    const fields = [
      { key: 'labels', name: '旧标签别名', type: 'List' },
    ] as unknown as PropertyFieldConfig[];

    await useUserSettingsStore.getState().updateSettings({ properties: { fields } });

    expect(useUserSettingsStore.getState().settings.properties.fields).toEqual([
      { key: 'labels', type: 'MultiSelect', options: undefined },
    ]);
  });
});
