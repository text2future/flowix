/**
 * 全局常量定义
 *
 * 主题相关 (ThemeId / THEME_OPTIONS / 颜色 vars / sanitize) 已迁到 lib/theme,
 * 实际色板在 css/theme/*.css; 本文件保留非颜色 / 通用 / 偏好设置结构。
 */

import { SUPPORTED_TEXT_EXTENSIONS } from '@/types';
import { DEFAULT_THEME_ID, type ThemeId } from '@features/theme';
import type { ShortcutOverrides } from '@features/shortcuts';
import { DEFAULT_APP_LANGUAGE, type AppLanguage, type Region } from '@features/i18n';
import type { AgentTypeKey } from '@/types/agent';

// 文件类型
export const BINARY_EXTENSIONS = [
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.avi', '.mov',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib',
];

/** 判断是否为文本文件 */
export function isTextFile(fileName: string): boolean {
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'));
  return SUPPORTED_TEXT_EXTENSIONS.some(e => ext === e || fileName.toLowerCase().endsWith(e));
}

// UI 存储键名
export const STORAGE_KEYS = {
  CHAT: 'flowix-chat-storage',
  AGENT_CONVERSATIONS: 'flowix-agent-conversations',
  SETTINGS: 'flowix-settings',
  TAG: 'flowix-tag',
  MEMO: 'flowix-memo-storage',
} as const;

/* ============================================================
 * User Settings (镜像后端 ~/.flowix/preference.json 结构)
 * 字段与后端 PreferenceFile / *Config 一一对应, 改 nested 后:
 *   - settings.personalize.customInstruction
 *   - settings.format.fontFamily
 *   - settings.theme
 * 调用方传 updateSettings({ personalize: { customInstruction: 'x' } })
 * 由 hooks/useUserSettings.ts 里的 mergeSettings 合并。
 * ============================================================ */

export interface PersonalizeConfig {
  customInstruction: string;
  responseLength: string;
  preferredLanguage: string;
  selectedTags: string[];
}

export interface FormatConfig {
  /** 字体族 (CSS font-family stack) */
  fontFamily: string;
  fontId?: string;
  /** 字号 (px) */
  fontSize: number;
  /** 行间距 (unitless line-height) */
  lineHeight: number;
  /** 文档编辑区最大宽度 (px) — 应用于 .ProseMirror max-width */
  documentWidth: number;
}

export type PropertyFieldType =
  | 'Text'
  | 'Number'
  | 'Date'
  | 'URL'
  | 'Icon'
  | 'Select'
  | 'MultiSelect';

export interface PropertyFieldConfig {
  key: string;
  name: string;
  type: PropertyFieldType;
  options?: string[];
}

export interface PropertiesConfig {
  fields: PropertyFieldConfig[];
}

export type MemoCardVariant = 'detailed' | 'compact';

export interface QuickPhrase {
  /** 稳定 id，由前端 crypto.randomUUID() 生成；用作 React key 与 patch 引用。 */
  id: string;
  /** 弹窗列表显示名，trim 后非空。 */
  title: string;
  /** 注入到 composer 输入框的内容，trim 后非空且不超过 MAX_QUICK_PHRASE_PROMPT_LENGTH。 */
  prompt: string;
}

export interface AgentsConfig {
  enabledByType: Partial<Record<AgentTypeKey, boolean>>;
  customLocationEnabledByType: Partial<Record<AgentTypeKey, boolean>>;
  customLocations: Partial<Record<AgentTypeKey, string>>;
  /** 用户在偏好设置里手工维护的常用语列表；空数组表示未配置。 */
  quickPhrases: QuickPhrase[];
}

/** 单条常用语提示词字符上限 — 100 字内（含中英文标点）。
 *  约束理由：常用语作为弹窗内一键插入的快捷片段，设计上希望简短直白；
 *  长内容更适合走 slash-menu / 模板 / 笔记引用，不在本功能职责内。 */
export const MAX_QUICK_PHRASE_PROMPT_LENGTH = 100;

/** 标题最大长度 — 比提示词更短，仅作列表显示名。 */
export const MAX_QUICK_PHRASE_TITLE_LENGTH = 40;

export interface ProductUpdatesConfig {
  enabled: boolean;
  lastCheckedAt: number;
}

export interface UserSettings {
  personalize: PersonalizeConfig;
  format: FormatConfig;
  /** 主题 id, 顶层字段; 合法值与兜底逻辑见 lib/theme。 */
  theme: ThemeId;
  /** UI display language. Independent from personalize.preferredLanguage, which only guides AI replies. */
  language: AppLanguage;
  /**
   * 安装时基于系统语言/时区识别的地区 (mainland / overseas)。
   * 首次安装由 detectRegion() 写入并落盘, 后续尊重用户偏好 (虽然 UI
   * 未提供手动修改入口, 但字段已落到 preference.json, 跨设备 / 备份恢复
   * 时保持一致)。 与 `language` 同生命周期。
   */
  region: Region;
  /** Memo list card presentation. */
  memoCardVariant: MemoCardVariant;
  /**
   * 快捷键用户覆盖层 — actionId → chord 字符串 (e.g. 'Mod+Shift+K')。
   * 只存与 ActionDefinition.defaultBinding 不同的部分, 缺省走默认。
   * 持久化到后端 ~/.flowix/preference.json 的 `shortcuts` 字段 (camelCase),
   * 后端 schema 见 backend/src/user_config.rs::PreferenceFile。
   */
  shortcuts: ShortcutOverrides;
  /** 用户主动配置过的自定义属性字段定义, 持久化到 preference.json。 */
  properties: PropertiesConfig;
  agents: AgentsConfig;
  productUpdates: ProductUpdatesConfig;
}

/**
 * 可选字体列表 - 与 menu-board.tsx 中 Font 下拉选项保持同步。
 * key 是 UI 标签, value 是写入 CSS 的 font-family stack。
 */
export type FontSource = 'bundled' | 'system' | 'downloadable';

export interface FontFamilyOption {
  id: string;
  label: string;
  value: string;
  source: FontSource;
}

export const FONT_FAMILY_OPTIONS: FontFamilyOption[] = [
  {
    id: 'nunito-sans',
    label: 'Nunito Sans',
    value: "'Nunito Sans', 'Inter', -apple-system, 'Segoe UI', sans-serif, BlinkMacSystemFont",
    source: 'bundled',
  },
  {
    id: 'noto-sans-sc',
    label: 'Noto Sans',
    value: "'Noto Sans SC', 'Nunito Sans', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
    source: 'downloadable',
  },
  {
    id: 'noto-serif-sc',
    label: 'Noto Serif',
    value: "'Noto Serif SC', 'Songti SC', 'SimSun', Georgia, serif",
    source: 'downloadable',
  },
  {
    id: 'inter',
    label: 'Inter',
    value: "'Inter', -apple-system, 'Segoe UI', sans-serif",
    source: 'system',
  },
  {
    id: 'pingfang-sc',
    label: 'PingFang SC',
    value: "'PingFang SC', 'Microsoft YaHei', sans-serif",
    source: 'system',
  },
  {
    id: 'microsoft-yahei',
    label: 'Microsoft YaHei',
    value: "'Microsoft YaHei', 'PingFang SC', sans-serif",
    source: 'system',
  },
  {
    id: 'system-ui',
    label: 'System UI',
    value: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    source: 'system',
  },
  {
    id: 'serif',
    label: 'Serif',
    value: "Georgia, 'Times New Roman', 'Songti SC', 'SimSun', serif",
    source: 'system',
  },
  {
    id: 'monospace',
    label: 'Monospace',
    value: "'JetBrains Mono', 'Anonymous Pro', 'Consolas', 'Menlo', monospace",
    source: 'system',
  },
];

/** 字号范围 (px) */
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 24;
export const FONT_SIZE_STEP = 1;

/** 行间距范围 (unitless) */
export const LINE_HEIGHT_MIN = 1.0;
export const LINE_HEIGHT_MAX = 2.4;
export const LINE_HEIGHT_STEP = 0.05;

/** 文档编辑区宽度范围 (px) */
export const DOCUMENT_WIDTH_MIN = 500;
export const DOCUMENT_WIDTH_MAX = 1100;
export const DOCUMENT_WIDTH_STEP = 50;
export const DOCUMENT_WIDTH_DEFAULT = 800;

export const DEFAULT_USER_SETTINGS: UserSettings = {
  personalize: {
    customInstruction: '',
    // 字段值必须与 general.tsx 中 <SelectItem value=...> 的可选值一致,
    // 否则下拉显示空白。preferredLanguage 之前误写 'zh' 不会匹配任何选项。
    responseLength: 'standard',
    preferredLanguage: 'Simplified Chinese',
    selectedTags: [],
  },
  format: {
    fontFamily: FONT_FAMILY_OPTIONS[0].value,
    fontId: FONT_FAMILY_OPTIONS[0].id,
    fontSize: 15,
    lineHeight: 1.6,
    documentWidth: DOCUMENT_WIDTH_DEFAULT,
  },
  // 默认值收敛到 lib/theme/DEFAULT_THEME_ID — 改默认值改一处即可。
  theme: DEFAULT_THEME_ID,
  language: DEFAULT_APP_LANGUAGE,
  // loadInitial 阶段会被 detectRegion() 覆盖为真实值; 这里给 overseas
  // 只是 SSR / IPC 还没回来时的兜底, 不会落到磁盘。
  region: 'overseas',
  memoCardVariant: 'detailed',
  // 启动时无任何用户覆盖, 所有 action 走 ActionDefinition.defaultBinding。
  shortcuts: {},
  properties: {
    fields: [],
  },
  agents: {
    enabledByType: {},
    customLocationEnabledByType: {},
    customLocations: {},
    quickPhrases: [],
  },
  productUpdates: {
    enabled: true,
    lastCheckedAt: 0,
  },
};

// UI 常量
export const DEFAULT_REQUEST_TIMEOUT = 600000;

// ---------- Toast 视觉常量 ----------

/** 单条 toast 默认展示时长 (ms) */
export const TOAST_DURATION_MS = 1600;

/** Toast 背景色 */
export const TOAST_BG = '#2d2f35';

/** Toast 阴影 (用于内联 box-shadow) */
export const TOAST_SHADOW =
  '0 16px 40px rgba(15,18,25,0.22), 0 3px 10px rgba(15,18,25,0.18)';

/** Toast 4 种 tone 对应的图标颜色 */
export const TOAST_COLORS = {
  success: '#22C55E',
  error:   '#FF8A8A',
  info:    '#7CB9FF',
  warning: '#FFC56B',
} as const;

export type ToastColorKey = keyof typeof TOAST_COLORS;
