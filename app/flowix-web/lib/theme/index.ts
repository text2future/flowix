/** 主题系统单一真源 — types / palette / sanitize / apply / options / provider 桶导出。 */
export type { ThemeId, ResolvedThemeId } from './types';
export { THEME_IDS, DEFAULT_THEME_ID } from './palette';
export { sanitizeTheme, resolveSystemTheme } from './sanitize';
export { applyTheme, type ApplyOptions } from './apply';
export { THEME_OPTIONS, type ThemeOption } from './options';
export { ThemeProvider } from './provider';
