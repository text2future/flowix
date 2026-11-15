import type { ThemeId } from './types';

/**
 * 合法主题白名单 — 单一真源。
 *
 * 前端运行时使用这份数组；新增主题还需同步首屏脚本、原生窗口、
 * 快捷键和设置面板等入口。详见 styles/theme/README.md。
 */
export const THEME_IDS = ['system', 'light', 'dark', 'mist', 'rock', 'ember'] as const satisfies readonly ThemeId[];

/** 启动 / 数据缺失 / 非法值时的兜底主题。 */
export const DEFAULT_THEME_ID: ThemeId = 'rock';
