import { sanitizePropertiesConfig } from '@features/properties/property-preset-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { preferences } from '@platform/tauri/client';

// 把 Tauri client 的 preferences IPC 拦截掉, 避免触发真实 IPC。
vi.mock('@platform/tauri/client', () => ({
  preferences: {
    get: vi.fn(async () => ({})),
    patch: vi.fn(async () => undefined),
    getPropertyPresets: vi.fn(async () => ({ systemFields: [], fields: [], deletedFields: [] })),
    replacePropertyPresets: vi.fn(async () => undefined),
  },
}));

// 必须在 mock 之后 import store, 让它拿到 mock 过的 client。
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { DEFAULT_USER_SETTINGS, type PropertyFieldConfig, type UserSettings } from '@/lib/constants';

const mockedPreferences = vi.mocked(preferences);

describe('user-settings-store · region loadInitial', () => {
  it('defaults to the file tree while preserving an explicitly saved list view', async () => {
    mockedPreferences.get.mockResolvedValueOnce({
      language: 'zh-CN',
    } as unknown as UserSettings);

    await useUserSettingsStore.getState().loadInitial();

    expect(useUserSettingsStore.getState().settings.memoListView).toBe('folders');

    mockedPreferences.get.mockResolvedValueOnce({
      ...DEFAULT_USER_SETTINGS,
      language: 'zh-CN',
      memoListView: 'detailed',
    });

    await useUserSettingsStore.getState().loadInitial();

    expect(useUserSettingsStore.getState().settings.memoListView).toBe('detailed');
  });

  it('normalizes the legacy cards list view to detailed cards', async () => {
    mockedPreferences.get.mockResolvedValueOnce({
      ...DEFAULT_USER_SETTINGS,
      language: 'zh-CN',
      memoListView: 'cards' as UserSettings['memoListView'],
    });

    await useUserSettingsStore.getState().loadInitial();

    expect(useUserSettingsStore.getState().settings.memoListView).toBe('detailed');
  });

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
          firstLineIndent: 0,
          documentWidth: 800,
        },
        theme: 'system',
        language: 'zh-CN',
        region: 'mainland',
        memoListView: 'detailed',
        autoOpenCreatedNotesInBrowser: true,
        recentAgentConversationsLimit: 6,
        spaceShowHiddenFolders: true,
        spaceShowSystemFolders: true,
        shortcuts: {},
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
          firstLineIndent: 0,
          documentWidth: 800,
        },
        theme: 'system',
        language: 'zh-CN',
        region: 'mainland',
        memoListView: 'detailed',
        autoOpenCreatedNotesInBrowser: true,
        recentAgentConversationsLimit: 6,
        spaceShowHiddenFolders: true,
        spaceShowSystemFolders: true,
        shortcuts: {},
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
  it('drops built-in collisions, keeps supported URL presets, and assigns stable IDs', async () => {
    const fields = [
      { key: 'name', name: '旧别名', type: 'Text' },
      { key: 'priority', name: '旧别名', type: 'Number' },
      { key: 'PRIORITY', name: '旧重复别名', type: 'Text' },
      { key: 'legacy-url', name: '旧链接', type: 'URL' },
    ] as unknown as PropertyFieldConfig[];

    const sanitized = sanitizePropertiesConfig({ fields }).fields;
    expect(sanitized.map(({ key, type }) => [key, type])).toEqual([['priority', 'Number'], ['legacy-url', 'URL']]);
    expect(sanitized.every((field) => /^fld_[0-9a-f]{32}$/.test(field.id ?? ''))).toBe(true);
  });

  it('migrates legacy List, Tags and noteTag preset types to their canonical types', async () => {
    const fields = [
      { key: 'labels', name: '旧标签别名', type: 'List' },
      { key: 'note-tags', name: '旧笔记标签类型', type: 'Tags' },
      { key: 'topics', type: 'noteTag' },
    ] as unknown as PropertyFieldConfig[];

    const sanitized = sanitizePropertiesConfig({ fields }).fields;
    expect(sanitized.map(({ key, type }) => [key, type])).toEqual([
      ['labels', 'MultiSelect'], ['note-tags', 'Tag'], ['topics', 'Tag'],
    ]);
    expect(sanitized.every((field) => /^fld_[0-9a-f]{32}$/.test(field.id ?? ''))).toBe(true);
  });
});

describe('shutdown preference flush', () => {
  it('awaits writes already dispatched by the debounce timer', async () => {
    await useUserSettingsStore.getState().flushPending();
    const currentSettings = useUserSettingsStore.getState().settings;
    useUserSettingsStore.setState({
      settings: { ...currentSettings, memoListView: 'detailed' },
    });
    vi.useFakeTimers();
    let finish!: () => void;
    mockedPreferences.patch.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve();
    }));
    try {
      await useUserSettingsStore.getState().updateSettings({ memoListView: 'folders' });
      await vi.advanceTimersByTimeAsync(200);
      let settled = false;
      const flushing = useUserSettingsStore.getState().flushPending().then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      finish(); await flushing;
      expect(settled).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

describe('paragraph first-line indentation preferences', () => {
  beforeEach(async () => {
    await useUserSettingsStore.getState().flushPending();
    mockedPreferences.patch.mockReset().mockResolvedValue(undefined);
    useUserSettingsStore.setState({ settings: DEFAULT_USER_SETTINGS, isLoading: false });
  });

  afterEach(async () => {
    await useUserSettingsStore.getState().flushPending();
  });

  it('loads older format preferences without changing paragraph indentation', async () => {
    const { firstLineIndent: _firstLineIndent, ...legacyFormat } = DEFAULT_USER_SETTINGS.format;
    mockedPreferences.get.mockResolvedValueOnce({
      ...DEFAULT_USER_SETTINGS,
      format: legacyFormat,
    } as UserSettings);

    await useUserSettingsStore.getState().loadInitial();

    expect(useUserSettingsStore.getState().settings.format.firstLineIndent).toBe(0);
  });

  it('persists the choice and restores it after reloading preferences', async () => {
    let saved = structuredClone(DEFAULT_USER_SETTINGS);
    mockedPreferences.patch.mockImplementationOnce(async (patch) => {
      saved = { ...saved, format: { ...saved.format, ...(patch.format as object) } };
    });

    await useUserSettingsStore.getState().updateSettings({ format: { firstLineIndent: 2 } });
    await useUserSettingsStore.getState().flushPending();

    expect(mockedPreferences.patch).toHaveBeenCalledWith({ format: { firstLineIndent: 2 } });
    useUserSettingsStore.setState({ settings: DEFAULT_USER_SETTINGS });
    mockedPreferences.get.mockResolvedValueOnce(saved);
    await useUserSettingsStore.getState().loadInitial();

    expect(useUserSettingsStore.getState().settings.format).toEqual({
      ...DEFAULT_USER_SETTINGS.format,
      firstLineIndent: 2,
    });

    await useUserSettingsStore.getState().updateSettings({ format: { fontSize: 18 } });
    expect(useUserSettingsStore.getState().settings.format.firstLineIndent).toBe(2);

    await useUserSettingsStore.getState().updateSettings({ format: { firstLineIndent: 0 } });
    expect(useUserSettingsStore.getState().settings.format.firstLineIndent).toBe(0);
  });

  it.each([null, -2, 1, 4, '2'])('falls back to no indent for unsupported saved value %s', async (value) => {
    mockedPreferences.get.mockResolvedValueOnce({
      ...DEFAULT_USER_SETTINGS,
      format: { ...DEFAULT_USER_SETTINGS.format, firstLineIndent: value },
    } as unknown as UserSettings);

    await useUserSettingsStore.getState().loadInitial();

    expect(useUserSettingsStore.getState().settings.format.firstLineIndent).toBe(0);
  });
});
