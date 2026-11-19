import { create } from 'zustand';
import { preferences as tauriPreferences } from '@platform/tauri/client';
import {
  DEFAULT_USER_SETTINGS,
  DEFAULT_AI_MEMORY_LOCATIONS,
  type AiMemoryLocation,
  type AgentsConfig,
  FONT_FAMILY_OPTIONS,
  type PersonalizeConfig,
  type FormatConfig,
  type MemoListView,
  type ProductUpdatesConfig,
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
} from '@/lib/i18n';
import { createLogger } from '@/lib/logger';

const logger = createLogger('user-settings');

const LEGACY_SERIF_FONT_FAMILY =
  "'Noto Serif CJK SC', 'Songti SC', 'SimSun', 'Times New Roman', serif, Georgia";

function normalizeFontFamily(fontFamily: string): string {
  if (fontFamily === LEGACY_SERIF_FONT_FAMILY) {
    return FONT_FAMILY_OPTIONS.find((font) => font.label === 'Serif')?.value ?? fontFamily;
  }
  return fontFamily;
}

function normalizeFontId(fontId: string | undefined, fontFamily: string): string | undefined {
  if (fontId && FONT_FAMILY_OPTIONS.some((font) => font.id === fontId && font.value === fontFamily)) {
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

function normalizeMemoListView(value: unknown): MemoListView {
  // `cards` is the legacy persisted value for the detailed list.
  if (value === 'folders') return 'folders';
  if (value === 'detailed' || value === 'cards') return 'detailed';
  return DEFAULT_USER_SETTINGS.memoListView;
}

function normalizeRecentAgentConversationsLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_USER_SETTINGS.recentAgentConversationsLimit;
  }
  return Math.min(50, Math.max(1, Math.floor(value)));
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) <= 0x1f);
}

function normalizeAiMemoryFolder(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_USER_SETTINGS.aiMemoryFolder;
  const folder = value;
  const trimmed = folder.trim();
  if (
    trimmed === '.'
    || trimmed === '..'
    || hasControlCharacter(folder)
    || /[\\/<>:"|?*]/.test(folder)
    || folder.endsWith('.')
  ) return DEFAULT_USER_SETTINGS.aiMemoryFolder;
  return folder;
}

function normalizeAiPersonality(value: unknown): string {
  return typeof value === 'string' ? value : DEFAULT_USER_SETTINGS.aiPersonality;
}

function isValidAiMemoryPath(value: string): boolean {
  const path = value.trim();
  if (!path) return true;
  if (
    path.startsWith('/')
    || path.includes('\\')
    || hasControlCharacter(path)
    || /[<>:"|?*`]/.test(path)
    || path.includes('//')
    || path.split('/').some((segment) => segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' '))
  ) return false;
  return true;
}

function normalizeAiMemoryLocations(value: unknown): AiMemoryLocation[] {
  const input = Array.isArray(value) ? value : [];
  const byId = new Map<string, AiMemoryLocation>();
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<AiMemoryLocation>;
    if (typeof candidate.id !== 'string' || !candidate.id.trim()) continue;
    const id = candidate.id.trim();
    const builtin = DEFAULT_AI_MEMORY_LOCATIONS.find((location) => location.id === id);
    const candidateName = typeof candidate.name === 'string' ? candidate.name.trim().slice(0, 64) : '';
    const name = builtin?.id === 'general'
      ? builtin.name
      : typeof candidate.name === 'string'
        ? candidateName
        : builtin?.name ?? '';
    const rawPath = typeof candidate.path === 'string' ? candidate.path : '';
    const path = isValidAiMemoryPath(rawPath) ? rawPath.slice(0, 512) : '';
    if (builtin?.id !== 'general' && (hasControlCharacter(name) || /[/\\]/.test(name))) continue;
    byId.set(id, { id, name, path });
  }

  const builtins = DEFAULT_AI_MEMORY_LOCATIONS
    .filter((location) => location.id === 'general' || byId.has(location.id))
    .map((location) => byId.get(location.id) ?? { ...location });
  const custom = [...byId.values()].filter((location) => !DEFAULT_AI_MEMORY_LOCATIONS.some(({ id }) => id === location.id));
  return [...builtins, ...custom].slice(0, 32);
}

function initialAiMemoryLocations(value: unknown, legacyFolder: unknown): AiMemoryLocation[] {
  const locations = normalizeAiMemoryLocations(value);
  const legacy = normalizeAiMemoryFolder(legacyFolder).trim();
  const root = legacy || 'Memory';
  const oldDefaultSuffix: Record<string, string> = {
    general: '通用',
    solution: '方案',
    workflow: '工作流',
  };

  if (Array.isArray(value) && value.some((item) => item && typeof item === 'object')) {
    return locations.map((location) => {
      const suffix = oldDefaultSuffix[location.id];
      const previousDefault = suffix ? `${root}/${suffix}` : '';
      if (previousDefault && location.path === previousDefault) {
        return { ...location, path: '' };
      }
      return location;
    });
  }

  return DEFAULT_AI_MEMORY_LOCATIONS.map((location) => ({
    ...location,
    path: legacy && legacy !== 'Memory' ? legacy : '',
  }));
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
    region: sanitizeRegion(updates.region ?? base.region),
    memoListView: normalizeMemoListView(updates.memoListView ?? base.memoListView),
    autoOpenCreatedNotesInBrowser:
      updates.autoOpenCreatedNotesInBrowser ?? base.autoOpenCreatedNotesInBrowser,
    aiMemoryFolder: normalizeAiMemoryFolder(updates.aiMemoryFolder ?? base.aiMemoryFolder),
    aiMemoryLocations: normalizeAiMemoryLocations(updates.aiMemoryLocations ?? base.aiMemoryLocations),
    aiPersonality: normalizeAiPersonality(updates.aiPersonality ?? base.aiPersonality),
    recentAgentConversationsLimit: normalizeRecentAgentConversationsLimit(
      updates.recentAgentConversationsLimit ?? base.recentAgentConversationsLimit,
    ),
    spaceShowHiddenFolders:
      updates.spaceShowHiddenFolders ?? base.spaceShowHiddenFolders,
    spaceShowSystemFolders:
      updates.spaceShowSystemFolders ?? base.spaceShowSystemFolders,
    shortcuts: { ...base.shortcuts, ...(updates.shortcuts ?? {}) },
    agents: {
      enabledByType: {
        ...base.agents.enabledByType,
        ...(updates.agents?.enabledByType ?? {}),
      },
    },
    productUpdates: {
      ...base.productUpdates,
      ...(updates.productUpdates ?? {}),
    },
  };
}

function sanitizeAgentsConfig(agents: AgentsConfig | undefined): AgentsConfig {
  const enabledByType =
    agents?.enabledByType && typeof agents.enabledByType === 'object'
      ? agents.enabledByType
      : {};
  return {
    enabledByType: Object.fromEntries(
      Object.entries(enabledByType).filter(([, value]) => typeof value === 'boolean'),
    ),
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
      firstLineIndent: settings.format.firstLineIndent === 2 ? 2 : DEFAULT_USER_SETTINGS.format.firstLineIndent,
      documentWidth: settings.format.documentWidth || DEFAULT_USER_SETTINGS.format.documentWidth,
    },
    theme: settings.theme,
    language: sanitizeAppLanguage(settings.language),
    region: sanitizeRegion(settings.region),
    memoListView: normalizeMemoListView(settings.memoListView),
    autoOpenCreatedNotesInBrowser: settings.autoOpenCreatedNotesInBrowser !== false,
    aiMemoryFolder: normalizeAiMemoryFolder(settings.aiMemoryFolder),
    aiMemoryLocations: normalizeAiMemoryLocations(settings.aiMemoryLocations),
    aiPersonality: normalizeAiPersonality(settings.aiPersonality),
    recentAgentConversationsLimit: normalizeRecentAgentConversationsLimit(settings.recentAgentConversationsLimit),
    // 老 preference.json 没有这两个键：缺省视为开启，避免升级后文件树突然少一半。
    spaceShowHiddenFolders: settings.spaceShowHiddenFolders !== false,
    spaceShowSystemFolders: settings.spaceShowSystemFolders !== false,
    shortcuts: { ...DEFAULT_USER_SETTINGS.shortcuts, ...(settings.shortcuts ?? {}) },
    agents: sanitizeAgentsConfig(settings.agents),
    productUpdates: sanitizeProductUpdatesConfig(settings.productUpdates),
  };
}

/**
 * Reuse unchanged branches from the previous settings tree.
 *
 * Settings are JSON-shaped and small, while updates are comparatively rare.
 * Preserving references here lets Zustand selectors subscribe to a complete
 * settings section (for example `format`) without rerendering when an
 * unrelated section changes. It also turns semantic no-op updates into a
 * true store no-op.
 */
function shareUnchangedSettings<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;

  if (Array.isArray(previous) && Array.isArray(next)) {
    if (previous.length !== next.length) return next;
    let unchanged = true;
    const shared = next.map((value, index) => {
      const sharedValue = shareUnchangedSettings(previous[index], value);
      if (!Object.is(sharedValue, previous[index])) unchanged = false;
      return sharedValue;
    });
    return (unchanged ? previous : shared) as T;
  }

  if (
    previous !== null
    && next !== null
    && typeof previous === 'object'
    && typeof next === 'object'
  ) {
    const previousRecord = previous as Record<string, unknown>;
    const nextRecord = next as Record<string, unknown>;
    const previousKeys = Object.keys(previousRecord);
    const nextKeys = Object.keys(nextRecord);
    if (previousKeys.length !== nextKeys.length) return next;

    let unchanged = true;
    const shared: Record<string, unknown> = {};
    for (const key of nextKeys) {
      if (!(key in previousRecord)) return next;
      const sharedValue = shareUnchangedSettings(previousRecord[key], nextRecord[key]);
      shared[key] = sharedValue;
      if (!Object.is(sharedValue, previousRecord[key])) unchanged = false;
    }
    return (unchanged ? previous : shared) as T;
  }

  return next;
}

/** updateSettings 接受的 patch 形状 — 每个分组都是 Partial, 顶层 theme 是可选。 */
export interface UserSettingsUpdate {
  personalize?: Partial<PersonalizeConfig>;
  format?: Partial<FormatConfig>;
  theme?: ThemeId;
  language?: AppLanguage;
  region?: UserSettings['region'];
  memoListView?: MemoListView;
  autoOpenCreatedNotesInBrowser?: boolean;
  /** Legacy AI memory root retained for migration from earlier settings. */
  aiMemoryFolder?: string;
  /** Named notebook-relative destinations for AI memory notes. */
  aiMemoryLocations?: AiMemoryLocation[];
  /** User-provided personality guidance included in native Agent instructions. */
  aiPersonality?: string;
  recentAgentConversationsLimit?: number;
  /** 访问空间是否展示隐藏（点开头）文件夹。 */
  spaceShowHiddenFolders?: boolean;
  /** 访问空间是否展示系统（attachments / node_modules 等）文件夹。 */
  spaceShowSystemFolders?: boolean;
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
  /** Apply a font choice already committed atomically by the native preference store. */
  applyTypographyFont: (fontId: string, fontFamily: string) => void;
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
type PreferencePatch = Record<string, unknown>;
let pendingPatch: PreferencePatch | null = null;

function normalizePreferencePatch(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePreferencePatch);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, normalizePreferencePatch(child)]),
    );
  }
  return value;
}

function mergePreferencePatches(current: PreferencePatch | null, incoming: PreferencePatch): PreferencePatch {
  const merged = { ...(current ?? {}) };
  for (const [key, rawValue] of Object.entries(incoming)) {
    const value = normalizePreferencePatch(rawValue);
    const previous = merged[key];
    if (
      previous !== null && typeof previous === 'object' && !Array.isArray(previous)
      && value !== null && typeof value === 'object' && !Array.isArray(value)
    ) {
      merged[key] = mergePreferencePatches(previous as PreferencePatch, value as PreferencePatch);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

const writesInFlight = new Set<Promise<void>>();
function writeToBackend(patch: PreferencePatch): Promise<void> {
  const write = tauriPreferences.patch(patch).then(() => undefined).catch(error => {
    logger.error('persist failed', { error });
  });
  writesInFlight.add(write);
  void write.finally(() => writesInFlight.delete(write));
  return write;
}

/** debounced flush — 拖动滑块 / 连续敲键盘时合并多次写盘 */
function scheduleFlush(patch: PreferencePatch): void {
  pendingPatch = mergePreferencePatches(pendingPatch, patch);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    const toWrite = pendingPatch;
    flushTimer = null;
    pendingPatch = null;
    if (toWrite) void writeToBackend(toWrite);
  }, FLUSH_DELAY_MS);
}

export const useUserSettingsStore = create<UserSettingsState>((set, get) => ({
  settings: DEFAULT_USER_SETTINGS,
  isLoading: true,

  loadInitial: async () => {
    try {
      const loaded = await tauriPreferences.get() as Partial<UserSettings> | null;
      const theme = sanitizeTheme(loaded?.theme, DEFAULT_USER_SETTINGS.theme);
      const hasSavedAiPersonality = Boolean(loaded?.aiPersonality?.trim());

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
        aiPersonality: hasSavedAiPersonality
          ? loaded?.aiPersonality ?? DEFAULT_USER_SETTINGS.aiPersonality
          : DEFAULT_USER_SETTINGS.aiPersonality,
        aiMemoryLocations: initialAiMemoryLocations(loaded?.aiMemoryLocations, loaded?.aiMemoryFolder),
      });
      const sanitized = shareUnchangedSettings(
        get().settings,
        sanitizeSettings({ ...merged, region }),
      );
      set({ settings: sanitized, isLoading: false });

      // 同步给 useRegionStore (非 React 代码 / 旧订阅者读这里)
      useRegionStore.getState().initialize(region);

      // 首次安装时立即落盘 (不走 debounce), 避免用户首次启动后立刻改语言
      // 又被下次启动的"首次安装"判定覆盖。
      if (isFirstInstall || !hasSavedAiPersonality) {
        await tauriPreferences.patch(sanitized as unknown as PreferencePatch);
      }
    } catch (error) {
      logger.error('load failed', { error });
      set({ isLoading: false });
    }
  },

  updateSettings: (updates) => {
    const prev = get().settings;
    const next = shareUnchangedSettings(prev, sanitizeSettings(mergeSettings(prev, updates)));
    if (next === prev) return Promise.resolve();
    set({ settings: next });
    if (next.region !== prev.region) useRegionStore.getState().initialize(next.region);
    scheduleFlush(updates as PreferencePatch);
    // 返回 Promise<void> 以保持与旧 useUserSettings 的 Promise 签名兼容
    // (section 内部有些代码 await 这个返回值)。
    return Promise.resolve();
  },

  applyTypographyFont: (fontId, fontFamily) => set((state) => {
    if (state.settings.format.fontId === fontId && state.settings.format.fontFamily === fontFamily) return state;
    return {
      settings: {
        ...state.settings,
        format: { ...state.settings.format, fontId, fontFamily },
      },
    };
  }),

  setShortcutOverride: (actionId, chord) => {
    const cur = get().settings;
    // 已是同一 chord — no-op, 避免触发重渲染 + 重复 scheduleFlush
    if (cur.shortcuts[actionId] === chord) return;
    const next: UserSettings = {
      ...cur,
      shortcuts: { ...cur.shortcuts, [actionId]: chord },
    };
    set({ settings: next });
    scheduleFlush({ shortcuts: { [actionId]: chord } });
  },

  resetShortcutOverride: actionId => {
    const cur = get().settings;
    if (!(actionId in cur.shortcuts)) return;
    const nextShortcuts = { ...cur.shortcuts };
    delete nextShortcuts[actionId];
    set({ settings: { ...cur, shortcuts: nextShortcuts } });
    scheduleFlush({ shortcuts: { [actionId]: null } });
  },

  resetAllShortcutOverrides: () => {
    const cur = get().settings;
    if (Object.keys(cur.shortcuts).length === 0) return;
    set({ settings: { ...cur, shortcuts: {} } });
    scheduleFlush({ shortcuts: null });
  },

  flushPending: async () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingPatch) {
      const toWrite = pendingPatch;
      pendingPatch = null;
      void writeToBackend(toWrite);
    }
    await Promise.all([...writesInFlight]);
  },
}));
