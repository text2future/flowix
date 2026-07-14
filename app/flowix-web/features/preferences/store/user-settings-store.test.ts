import { beforeEach, describe, expect, it, vi } from 'vitest';
import { preferences } from '@platform/tauri/client';

// 把 Tauri client 的 preferences.set 拦截掉, 避免触发真实 IPC。
vi.mock('@platform/tauri/client', () => ({
  preferences: {
    get: vi.fn(async () => ({})),
    set: vi.fn(async () => undefined),
  },
}));

// 必须在 mock 之后 import store, 让它拿到 mock 过的 client。
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import {
  DEFAULT_USER_SETTINGS,
  MAX_QUICK_PHRASE_PROMPT_LENGTH,
  MAX_QUICK_PHRASE_TITLE_LENGTH,
  type QuickPhrase,
} from '@/lib/constants';

const mockedPreferences = vi.mocked(preferences);

describe('user-settings-store · agents.quickPhrases sanitize', () => {
  beforeEach(() => {
    // 每个用例前重置 store, 避免跨用例污染。
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
        memoCardVariant: 'detailed',
        shortcuts: {},
        properties: { fields: [] },
        agents: {
          enabledByType: {},
          customLocationEnabledByType: {},
          customLocations: {},
          quickPhrases: [],
        },
        productUpdates: { enabled: true, lastCheckedAt: 0 },
      },
      isLoading: false,
    });
  });

  it('接受双字段都填齐的常用语', async () => {
    const phrase: QuickPhrase = {
      id: 'id-1',
      title: '会议纪要',
      prompt: '把这次讨论要点整理成可执行项',
    };
    await useUserSettingsStore
      .getState()
      .updateSettings({ agents: { quickPhrases: [phrase] } });
    expect(useUserSettingsStore.getState().settings.agents.quickPhrases).toEqual([
      phrase,
    ]);
  });

  it('丢弃 title 为空的整条', async () => {
    await useUserSettingsStore.getState().updateSettings({
      agents: {
        quickPhrases: [
          { id: 'a', title: '  ', prompt: 'prompt-a' },
          { id: 'b', title: '有效', prompt: 'prompt-b' },
        ],
      },
    });
    const kept = useUserSettingsStore.getState().settings.agents.quickPhrases;
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe('b');
  });

  it('丢弃 prompt 为空的整条', async () => {
    await useUserSettingsStore.getState().updateSettings({
      agents: {
        quickPhrases: [
          { id: 'a', title: '标题', prompt: '' },
          { id: 'b', title: '标题', prompt: '   ' },
        ],
      },
    });
    expect(
      useUserSettingsStore.getState().settings.agents.quickPhrases,
    ).toHaveLength(0);
  });

  it('把超长 prompt 截断到 100 字内', async () => {
    const long = '字'.repeat(MAX_QUICK_PHRASE_PROMPT_LENGTH + 50);
    await useUserSettingsStore.getState().updateSettings({
      agents: {
        quickPhrases: [{ id: 'long', title: '长 prompt', prompt: long }],
      },
    });
    const kept = useUserSettingsStore.getState().settings.agents.quickPhrases;
    expect(kept).toHaveLength(1);
    expect(kept[0].prompt.length).toBe(MAX_QUICK_PHRASE_PROMPT_LENGTH);
  });

  it('把超长 title 截断到 MAX_QUICK_PHRASE_TITLE_LENGTH 内', async () => {
    const longTitle = 't'.repeat(MAX_QUICK_PHRASE_TITLE_LENGTH + 10);
    await useUserSettingsStore.getState().updateSettings({
      agents: {
        quickPhrases: [{ id: 't', title: longTitle, prompt: 'p' }],
      },
    });
    const kept = useUserSettingsStore.getState().settings.agents.quickPhrases;
    expect(kept[0].title.length).toBe(MAX_QUICK_PHRASE_TITLE_LENGTH);
  });

  it('缺 id 时自动补 UUID, 不会抛错', async () => {
    await useUserSettingsStore.getState().updateSettings({
      agents: {
        quickPhrases: [
          // @ts-expect-error -- 故意缺 id, 测容错
          { title: 'no-id', prompt: 'p' },
        ],
      },
    });
    const kept = useUserSettingsStore.getState().settings.agents.quickPhrases;
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toMatch(/.+/);
  });

  it('同 id 重复只保留第一条', async () => {
    await useUserSettingsStore.getState().updateSettings({
      agents: {
        quickPhrases: [
          { id: 'dup', title: 'first', prompt: 'p1' },
          { id: 'dup', title: 'second', prompt: 'p2' },
        ],
      },
    });
    const kept = useUserSettingsStore.getState().settings.agents.quickPhrases;
    expect(kept).toHaveLength(1);
    expect(kept[0].title).toBe('first');
  });

  it('非数组输入 (undefined / 字符串) 安全兜底为空数组', async () => {
    await useUserSettingsStore.getState().updateSettings({
      // @ts-expect-error -- 故意传错类型
      agents: { quickPhrases: 'oops' },
    });
    expect(
      useUserSettingsStore.getState().settings.agents.quickPhrases,
    ).toEqual([]);
  });

  it('trim 前后空白', async () => {
    await useUserSettingsStore.getState().updateSettings({
      agents: {
        quickPhrases: [
          { id: 't', title: '  会议纪要  ', prompt: '  prompt  ' },
        ],
      },
    });
    const kept = useUserSettingsStore.getState().settings.agents.quickPhrases;
    expect(kept[0].title).toBe('会议纪要');
    expect(kept[0].prompt).toBe('prompt');
  });

  it('mergeSettings 缺 quickPhrases patch 时保留旧值', async () => {
    // 先写入一条
    await useUserSettingsStore.getState().updateSettings({
      agents: {
        quickPhrases: [{ id: 'keep', title: '保留', prompt: 'p' }],
      },
    });
    // 再 patch 一个完全不相关的字段
    await useUserSettingsStore.getState().updateSettings({
      memoCardVariant: 'compact',
    });
    const kept = useUserSettingsStore.getState().settings.agents.quickPhrases;
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe('keep');
  });

  it('保存并清理第三方 Agent 自定义位置', async () => {
    await useUserSettingsStore.getState().updateSettings({
      agents: {
        customLocationEnabledByType: { codex: true },
        customLocations: { codex: '  /opt/custom/bin  ' },
      },
    });

    expect(
      useUserSettingsStore.getState().settings.agents.customLocationEnabledByType.codex,
    ).toBe(true);
    expect(useUserSettingsStore.getState().settings.agents.customLocations.codex).toBe(
      '/opt/custom/bin',
    );
  });

  it('JSON 序列化往返不丢 quickPhrases ── 与后端 Rust schema 保持一致', async () => {
    const phrases: QuickPhrase[] = [
      { id: 'p1', title: '会议纪要', prompt: '整理这次讨论的要点' },
      { id: 'p2', title: '代码评审', prompt: 'review 这段改动' },
    ];
    await useUserSettingsStore.getState().updateSettings({
      agents: { quickPhrases: phrases },
    });
    const persisted = JSON.parse(
      JSON.stringify(useUserSettingsStore.getState().settings),
    );
    // 顶层 camelCase + agents.quickPhrases 完整保留
    expect(persisted.agents.quickPhrases).toEqual(phrases);
    // 反序列化回 UserSettings 形态, 仍能跑通 sanitize
    const reloaded = await useUserSettingsStore.getState().updateSettings({
      agents: { quickPhrases: persisted.agents.quickPhrases },
    });
    expect(reloaded).toBeUndefined();
    expect(useUserSettingsStore.getState().settings.agents.quickPhrases).toEqual(
      phrases,
    );
  });
});
describe('user-settings-store 路 region loadInitial', () => {
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
        memoCardVariant: 'detailed',
        shortcuts: {},
        properties: { fields: [] },
        agents: {
          enabledByType: {},
          customLocationEnabledByType: {},
          customLocations: {},
          quickPhrases: [],
        },
        productUpdates: { enabled: true, lastCheckedAt: 0 },
      },
      isLoading: true,
    });

    await useUserSettingsStore.getState().loadInitial();

    expect(useUserSettingsStore.getState().settings.region).toBe('mainland');
  });
});
