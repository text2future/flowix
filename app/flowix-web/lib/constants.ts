/**
 * 全局常量定义
 *
 * 主题相关 (ThemeId / THEME_OPTIONS / 颜色 vars / sanitize) 已迁到 lib/theme,
 * 实际色板在 css/theme/*.css; 本文件保留非颜色 / 通用 / 偏好设置结构。
 */

import { SUPPORTED_TEXT_EXTENSIONS } from '../types';
import { DEFAULT_THEME_ID, type ThemeId } from './theme';
import type { ShortcutOverrides } from './shortcuts/types';

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
  /** 字号 (px) */
  fontSize: number;
  /** 行间距 (unitless line-height) */
  lineHeight: number;
  /** 文档编辑区最大宽度 (px) — 应用于 .ProseMirror max-width */
  documentWidth: number;
}

export interface UserSettings {
  personalize: PersonalizeConfig;
  format: FormatConfig;
  /** 主题 id, 顶层字段; 合法值与兜底逻辑见 lib/theme。 */
  theme: ThemeId;
  /**
   * 快捷键用户覆盖层 — actionId → chord 字符串 (e.g. 'Mod+Shift+K')。
   * 只存与 ActionDefinition.defaultBinding 不同的部分, 缺省走默认。
   * 持久化到后端 ~/.flowix/preference.json 的 `shortcuts` 字段 (camelCase),
   * 后端 schema 见 backend/src/user_config.rs::PreferenceFile。
   */
  shortcuts: ShortcutOverrides;
}

/**
 * 可选字体列表 - 与 menu-board.tsx 中 Font 下拉选项保持同步。
 * key 是 UI 标签, value 是写入 CSS 的 font-family stack。
 */
export const FONT_FAMILY_OPTIONS: { label: string; value: string }[] = [
  {
    label: 'Nunito Sans',
    value: "'Nunito Sans', 'Inter', -apple-system, 'Segoe UI', sans-serif, BlinkMacSystemFont",
  },
  {
    label: 'Inter',
    value: "'Inter', -apple-system, 'Segoe UI', sans-serif",
  },
  {
    label: 'PingFang SC',
    value: "'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  {
    label: 'Microsoft YaHei',
    value: "'Microsoft YaHei', 'PingFang SC', sans-serif",
  },
  {
    label: 'System UI',
    value: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  },
  {
    label: 'Serif',
    value: "Georgia, 'Times New Roman', 'Songti SC', 'SimSun', serif",
  },
  {
    label: 'Monospace',
    value: "'JetBrains Mono', 'Anonymous Pro', 'Consolas', 'Menlo', monospace",
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
export const DOCUMENT_WIDTH_DEFAULT = 700;

export const DEFAULT_USER_SETTINGS: UserSettings = {
  personalize: {
    customInstruction: '',
    // 字段值必须与 general.tsx 中 <SelectItem value=...> 的可选值一致,
    // 否则下拉显示空白。preferredLanguage 之前误写 'zh' 不会匹配任何选项。
    responseLength: '标准',
    preferredLanguage: '简体中文',
    selectedTags: [],
  },
  format: {
    fontFamily: FONT_FAMILY_OPTIONS[0].value,
    fontSize: 15,
    lineHeight: 1.6,
    documentWidth: DOCUMENT_WIDTH_DEFAULT,
  },
  // 默认值收敛到 lib/theme/DEFAULT_THEME_ID — 改默认值改一处即可。
  theme: DEFAULT_THEME_ID,
  // 启动时无任何用户覆盖, 所有 action 走 ActionDefinition.defaultBinding。
  shortcuts: {},
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
