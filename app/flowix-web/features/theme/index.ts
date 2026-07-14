/** 主题系统单一真源 — types / palette / sanitize / apply / options / provider 桶导出。 */
export type { ThemeId, ResolvedThemeId } from '@features/theme/types';
export { THEME_IDS, DEFAULT_THEME_ID } from '@features/theme/palette';
export { sanitizeTheme, resolveSystemTheme } from '@features/theme/sanitize';
export { applyTheme, type ApplyOptions } from '@features/theme/apply';
export { THEME_OPTIONS, type ThemeOption } from '@features/theme/options';
export { ThemeProvider } from '@features/theme/provider';
