/**
 * 主题 id 联合类型。
 *
 * - 'system' 是调度器: 跟随 prefers-color-scheme 在 light / dark 间切换, 不直接持色。
 * - 其余 3 个是静态色板, 由 css/theme/*.css 提供变量。
 */
export type ThemeId = 'system' | 'light' | 'dark' | 'rock';

/** 'system' 被解析后落到具体主题 (永远不会是 'system')。 */
export type ResolvedThemeId = Exclude<ThemeId, 'system'>;
