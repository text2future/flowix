import { DEFAULT_THEME_ID, THEME_IDS } from '@features/theme/palette';
import type { ResolvedThemeId, ThemeId } from '@features/theme';

const VALID: ReadonlySet<ThemeId> = new Set(THEME_IDS);

/**
 * 把任意值 (后端 / 旧数据 / 损坏 JSON 注入) 收敛到合法 ThemeId, 否则 fallback。
 *
 * - 后端 theme 字段理论上是 enum, 但向前兼容老 preference.json (字符串 "invalid" 等)
 *   以及外部手改磁盘的情况, 兜底是必须的。
 * - 默认 fallback = DEFAULT_THEME_ID, 调用方可自定义 (e.g. 用 base.theme 作 fallback)。
 */
export function sanitizeTheme(v: unknown, fallback: ThemeId = DEFAULT_THEME_ID): ThemeId {
  return typeof v === 'string' && VALID.has(v as ThemeId) ? (v as ThemeId) : fallback;
}

/** 'system' 模式: 跟随系统外观解析成具体主题 (dark 或 light)。 */
export function resolveSystemTheme(prefersDark: boolean): ResolvedThemeId {
  return prefersDark ? 'dark' : 'light';
}
