import type { ThemeId } from '@features/theme';

/**
 * 合法主题白名单 — 单一真源。
 *
 * useApplyTheme / user-settings-store / 后端 Rust Theme enum 都参考这份数组;
 * 加新主题时只改这里 + css/theme/<id>.css + options.ts 即可, 不再散落 3 处。
 */
export const THEME_IDS = ['system', 'light', 'dark', 'rock', 'mist', 'ember'] as const satisfies readonly ThemeId[];

/** 启动 / 数据缺失 / 非法值时的兜底主题。 */
export const DEFAULT_THEME_ID: ThemeId = 'system';
