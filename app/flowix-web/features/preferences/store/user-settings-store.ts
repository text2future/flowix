import { create } from 'zustand';
import { preferences as tauriPreferences } from '@platform/tauri/client';
import {
  DEFAULT_USER_SETTINGS,
  type AgentsConfig,
  FONT_FAMILY_OPTIONS,
  MAX_QUICK_PHRASE_PROMPT_LENGTH,
  MAX_QUICK_PHRASE_TITLE_LENGTH,
  type PersonalizeConfig,
  type FormatConfig,
  type MemoCardVariant,
  type ProductUpdatesConfig,
  type PropertiesConfig,
  type QuickPhrase,
  type UserSettings,
} from '@/lib/constants';
import { sanitizeTheme, type ThemeId } from '@features/theme';
import type { ShortcutOverrides } from '@features/shortcuts';
import {
  detectSystemLanguage,
  detectRegion,
  sanitizeAppLanguage,
  sanitizeRegion,
  useRegionStore,
  type AppLanguage,
} from '@features/i18n';

const LEGACY_SERIF_FONT_FAMILY =
  "'Noto Serif CJK SC', 'Songti SC', 'SimSun', 'Times New Roman', serif, Georgia";

function normalizeFontFamily(fontFamily: string): string {
  if (fontFamily === LEGACY_SERIF_FONT_FAMILY) {
    return FONT_FAMILY_OPTIONS.find((font) => font.label === 'Serif')?.value ?? fontFamily;
  }
  return fontFamily;
}

function normalizeFontId(fontId: string | undefined, fontFamily: string): string | undefined {
  if (fontId && FONT_FAMILY_OPTIONS.some((font) => font.id === fontId)) {
    return fontId;
  }
  return FONT_FAMILY_OPTIONS.find((font) => font.value === fontFamily)?.id;
}

function normalizeActiveFontFamily(fontFamily: string): string {
  const normalized = normalizeFontFamily(fontFamily || FONT_FAMILY_OPTIONS[0].value);
  return FONT_FAMILY_OPTIONS.some((font) => font.value === normalized)
    ? normalized
    : FONT_FAMILY_OPTIONS[0].value;
}

function normalizeResponseLength(responseLength: string): string {
  const legacyMap: Record<string, string> = {
    简洁: 'concise',
    标准: 'standard',
    详细: 'detailed',
  };
  const normalized = legacyMap[responseLength] ?? responseLength;
  return ['concise', 'standard', 'detailed'].includes(normalized)
    ? normalized
    : DEFAULT_USER_SETTINGS.personalize.responseLength;
}

function normalizePreferredLanguage(preferredLanguage: string): string {
  const legacyMap: Record<string, string> = {
    简体中文: 'Simplified Chinese',
  };
  const normalized = legacyMap[preferredLanguage] ?? preferredLanguage;
  return ['Simplified Chinese', 'English'].includes(normalized)
    ? normalized
    : DEFAULT_USER_SETTINGS.personalize.preferredLanguage;
}

function normalizeMemoCardVariant(value: unknown): MemoCardVariant {
  return value === 'compact' || value === 'detailed'
    ? value
    : DEFAULT_USER_SETTINGS.memoCardVariant;
}

/**
 * 偏好设置全局单例 store。
 *
 * 为什么不用 useState: 同一个 React 树里 useUserSettings 被多次调用
 * (app.tsx 顶层 + PreferencesView + AccountSection 等), 每个 hook 调用
 * 都是独立的 useState, updateSettings 只更新本实例的 state, 其他实例
 * 看不到 — 导致"刚改的值在另一处读不到、刷新后丢失"的诡异 bug。
 *
 * 用 zustand 单例后, 任何订阅者拿到的都是同一份 state, 写入立即通知
 * 所有订阅者。 后端 IPC 仍走 ~/.flowix/boot/preference.json, 这里只是前端
 * 状态层的统一源。
 */

// sanitizeTheme / VALID_THEME_IDS 统一收敛在 lib/theme/sanitize.ts, 这里不再重复。

function mergeSettings(base: UserSettings, updates: UserSettingsUpdate): UserSettings {
  const theme = updates.theme !== undefined
    ? sanitizeTheme(updates.theme, base.theme)
    : base.theme;
  const personalize = { ...base.personalize, ...(updates.personalize ?? {}) };
  return {
    personalize: {
      ...personalize,
      responseLength: normalizeResponseLength(personalize.responseLength),
      preferredLanguage: normalizePreferredLanguage(personalize.preferredLanguage),
    },
    format: { ...base.format, ...(updates.format ?? {}) },
    theme,
    language: sanitizeAppLanguage(updates.language ?? base.language),
    // region 不接受 patch, 只在 loadInitial 时由系统检测写入, 后续走 base。
    region: base.region,
    memoCardVariant: normalizeMemoCardVariant(updates.memoCardVariant ?? base.memoCardVariant),
    shortcuts: { ...base.shortcuts, ...(updates.shortcuts ?? {}) },
    properties: {
      ...base.properties,
      ...(updates.properties ?? {}),
    },
    agents: {
      enabledByType: {
        ...base.agents.enabledByType,
        ...(updates.agents?.enabledByType ?? {}),
      },
      // quickPhrases 整体替换 —— 与 properties.fields 同款, 避免外部传入时
      // 仅 patch 部分项导致 sanitize 后顺序错乱。
      quickPhrases: updates.agents?.quickPhrases ?? base.agents.quickPhrases,
    },
    productUpdates: {
      ...base.productUpdates,
      ...(updates.productUpdates ?? {}),
    },
  };
}

function sanitizePropertiesConfig(properties: PropertiesConfig | undefined): PropertiesConfig {
  const fields = Array.isArray(properties?.fields) ? properties.fields : [];
  const deduped = new Map<string, PropertiesConfig['fields'][number]>();

  fields.forEach((field) => {
    const key = String(field?.key ?? '').trim();
    const name = String(field?.name ?? '').trim();
    const type = field?.type;
    if (!key || !name) return;
    if (!['Text', 'Number', 'Date', 'URL', 'Icon', 'Select', 'MultiSelect'].includes(type)) return;
    deduped.set(key, {
      key,
      name,
      type,
      options: Array.isArray(field.options)
        ? field.options.map((option) => String(option).trim()).filter(Boolean)
        : undefined,
    });
  });

  return { fields: [...deduped.values()] };
}

function sanitizeAgentsConfig(agents: AgentsConfig | undefined): AgentsConfig {
  const enabledByType =
    agents?.enabledByType && typeof agents.enabledByType === 'object'
      ? agents.enabledByType
      : {};
  const rawPhrases = Array.isArray(agents?.quickPhrases) ? agents!.quickPhrases : [];
  const seen = new Set<string>();
  const quickPhrases: QuickPhrase[] = [];
  for (const item of rawPhrases) {
    const id = typeof item?.id === 'string' && item.id ? item.id : crypto.randomUUID();
    const title = String(item?.title ?? '').trim().slice(0, MAX_QUICK_PHRASE_TITLE_LENGTH);
    const prompt = String(item?.prompt ?? '').trim().slice(0, MAX_QUICK_PHRASE_PROMPT_LENGTH);
    // 双字段必须都配齐 → 整条丢弃, 不让「半成品」污染弹窗。
    if (!title || !prompt) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    quickPhrases.push({ id, title, prompt });
  }
  return {
    enabledByType: Object.fromEntries(
      Object.entries(enabledByType).filter(([, value]) => typeof value === 'boolean'),
    ),
    quickPhrases,
  };
}

function sanitizeProductUpdatesConfig(productUpdates: ProductUpdatesConfig | undefined): ProductUpdatesConfig {
  return {
    enabled: productUpdates?.enabled !== false,
    lastCheckedAt:
      typeof productUpdates?.lastCheckedAt === 'number' && Number.isFinite(productUpdates.lastCheckedAt)
        ? productUpdates.lastCheckedAt
        : DEFAULT_USER_SETTINGS.productUpdates.lastCheckedAt,
  };
}

/** 兜底默认值 — 字段为空 (老 snake_case 数据 / 外部写入) 时填充,
 *  保证 UI 始终有可显示的值。
 *  关键: 这些 fallback 必须等于 DEFAULT_USER_SETTINGS 的对应字段, 否则
 *  会出现"全新安装显示 A, 数据损坏后变成 B"的诡异跳变 (P3#1 修过)。
 *  - responseLength / preferredLanguage: 与 DEFAULT_USER_SETTINGS 一致
 *  - fontFamily / fontSize / lineHeight: 同上
 *  - customInstruction / selectedTags: 允许空, 不兜底
 *  - shortcuts: 缺省 (老 preference.json 没有此字段) 走 DEFAULT, 即 {} — 不抛错。
 */
function sanitizeSettings(settings: UserSettings): UserSettings {
  return {
    personalize: {
      customInstruction: settings.personalize.customInstruction,
      responseLength: normalizeResponseLength(settings.personalize.responseLength),
      preferredLanguage: normalizePreferredLanguage(settings.personalize.preferredLanguage),
      selectedTags: settings.personalize.selectedTags,
    },
    format: {
      fontFamily: normalizeActiveFontFamily(settings.format.fontFamily),
      fontId: normalizeFontId(
        settings.format.fontId,
        normalizeActiveFontFamily(settings.format.fontFamily),
      ),
      fontSize: settings.format.fontSize || DEFAULT_USER_SETTINGS.format.fontSize,
      lineHeight: settings.format.lineHeight || DEFAULT_USER_SETTINGS.format.lineHeight,
      documentWidth: settings.format.documentWidth || DEFAULT_USER_SETTINGS.format.documentWidth,
    },
    theme: settings.theme,
    language: sanitizeAppLanguage(settings.language),
    region: sanitizeRegion(settings.region),
    memoCardVariant: normalizeMemoCardVariant(settings.memoCardVariant),
    shortcuts: { ...DEFAULT_USER_SETTINGS.shortcuts, ...(settings.shortcuts ?? {}) },
    properties: sanitizePropertiesConfig(settings.properties),
    agents: sanitizeAgentsConfig(settings.agents),
    productUpdates: sanitizeProductUpdatesConfig(settings.productUpdates),
  };
}

/** updateSettings 接受的 patch 形状 — 每个分组都是 Partial, 顶层 theme 是可选。 */
export interface UserSettingsUpdate {
  personalize?: Partial<PersonalizeConfig>;
  format?: Partial<FormatConfig>;
  theme?: ThemeId;
  language?: AppLanguage;
  memoCardVariant?: MemoCardVariant;
  properties?: Partial<PropertiesConfig>;
  productUpdates?: Partial<ProductUpdatesConfig>;
  /**
   * 快捷键覆盖的浅合并 — 传入的字段会覆盖现有覆盖, 未提及的字段保留。
   * 注意: `{}` 不会清空 (是 no-op), 真正清空请用 `resetAllShortcutOverrides`。
   * 业务上更推荐用 `setShortcutOverride` / `resetShortcutOverride` 这两个
   * 专用方法, 这里仅为 `updateSettings` 的完整性保留入口。
   */
  shortcuts?: ShortcutOverrides;
  agents?: Partial<AgentsConfig>;
}

interface UserSettingsState {
  settings: UserSettings;
  isLoading: boolean;
  /** 启动时从后端加载一次, 写盘由 setPending 自动 debounce 落盘 */
  loadInitial: () => Promise<void>;
  /** 更新 settings: 同步写状态, 异步 debounce 落盘 (200ms)。
   *  返回 Promise<void> 以保持与旧 useUserSettings 的 Promise 签名兼容。 */
  updateSettings: (updates: UserSettingsUpdate) => Promise<void>;
  /** 写一个快捷键覆盖 — 立刻生效, debounce 落盘。 */
  setShortcutOverride: (actionId: string, chord: string) => void;
  /** 重置单个 action 的覆盖, 回到 defaultBinding。 */
  resetShortcutOverride: (actionId: string) => void;
  /** 重置所有快捷键覆盖, 清空 settings.shortcuts。 */
  resetAllShortcutOverrides: () => void;
  /** 强制立即 flush pending 写盘 — 卸载时用 */
  flushPending: () => Promise<void>;
}

const FLUSH_DELAY_MS = 200;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSettings: UserSettings | null = null;

async function writeToBackend(settings: UserSettings): Promise<void> {
  try {
    await tauriPreferences.set(settings);
  } catch (error) {
    console.error('Failed to persist settings:', error);
  }
}

/** debounced flush — 拖动滑块 / 连续敲键盘时合并多次写盘 */
function scheduleFlush(settings: UserSettings): void {
  pendingSettings = settings;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    const toWrite = pendingSettings;
    flushTimer = null;
    pendingSettings = null;
    if (toWrite) void writeToBackend(toWrite);
  }, FLUSH_DELAY_MS);
}

export const useUserSettingsStore = create<UserSettingsState>((set, get) => ({
  settings: DEFAULT_USER_SETTINGS,
  isLoading: true,

  loadInitial: async () => {
    try {
      const loaded = (await tauriPreferences.get()) as Partial<UserSettings> | null;
      const theme = sanitizeTheme(loaded?.theme, DEFAULT_USER_SETTINGS.theme);

      // 首次安装: preference.json 里 language 是空串, 跟随系统语言。
      // 规则: zh-* → zh-CN, 其他 → en-US。 落盘后后续启动以用户偏好为准。
      const isFirstInstall = !loaded?.language;
      const language = isFirstInstall
        ? detectSystemLanguage()
        : sanitizeAppLanguage(loaded.language);

      // region 走同样的首次安装策略: 跑一次 detectRegion() 写入磁盘, 后续
      // 尊重持久化值。 sanitizeRegion 对未持久化 / 非法值会回退到 detect。
      const region = isFirstInstall ? detectRegion() : sanitizeRegion(loaded?.region);

      const merged = mergeSettings(DEFAULT_USER_SETTINGS, {
        ...loaded,
        theme,
        language,
      });
      const sanitized = sanitizeSettings({ ...merged, region });
      set({ settings: sanitized, isLoading: false });

      // 同步给 useRegionStore (非 React 代码 / 旧订阅者读这里)
      useRegionStore.getState().initialize(region);

      // 首次安装时立即落盘 (不走 debounce), 避免用户首次启动后立刻改语言
      // 又被下次启动的"首次安装"判定覆盖。
      if (isFirstInstall) {
        await writeToBackend(sanitized);
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
      set({ isLoading: false });
    }
  },

  updateSettings: (updates) => {
    const next = sanitizeSettings(mergeSettings(get().settings, updates));
    set({ settings: next });
    scheduleFlush(next);
    // 返回 Promise<void> 以保持与旧 useUserSettings 的 Promise 签名兼容
    // (section 内部有些代码 await 这个返回值)。
    return Promise.resolve();
  },

  setShortcutOverride: (actionId, chord) => {
    const cur = get().settings;
    // 已是同一 chord — no-op, 避免触发重渲染 + 重复 scheduleFlush
    if (cur.shortcuts[actionId] === chord) return;
    const next: UserSettings = {
      ...cur,
      shortcuts: { ...cur.shortcuts, [actionId]: chord },
    };
    set({ settings: next });
    scheduleFlush(next);
  },

  resetShortcutOverride: actionId => {
    const cur = get().settings;
    if (!(actionId in cur.shortcuts)) return;
    const nextShortcuts = { ...cur.shortcuts };
    delete nextShortcuts[actionId];
    set({ settings: { ...cur, shortcuts: nextShortcuts } });
    scheduleFlush({ ...cur, shortcuts: nextShortcuts });
  },

  resetAllShortcutOverrides: () => {
    const cur = get().settings;
    if (Object.keys(cur.shortcuts).length === 0) return;
    set({ settings: { ...cur, shortcuts: {} } });
    scheduleFlush({ ...cur, shortcuts: {} });
  },

  flushPending: async () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingSettings) {
      const toWrite = pendingSettings;
      pendingSettings = null;
      await writeToBackend(toWrite);
    }
  },
}));
