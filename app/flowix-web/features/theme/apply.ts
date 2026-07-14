import { resolveSystemTheme, sanitizeTheme } from '@features/theme/sanitize';
import type { ResolvedThemeId, ThemeId } from '@features/theme';

export interface ApplyOptions {
  /** 来自 prefers-color-scheme: dark 的当前值, 由调用方读 mq 传入。 */
  prefersDark: boolean;
}

/**
 * 首屏 boot 脚本 (index.html) 读取的 localStorage key — 缓存"已解析"的主题
 * id (dark / light / rock), 让 <head> 的 inline 脚本在 CSS paint 前就能把
 * data-theme 写到 <html>, 避免深色模式开窗时一帧白色闪烁。
 *
 * 真源始终是 ~/.flowix/boot/preference.json (Tauri IPC); 这个 cache 只是给首屏
 * 做同步 fallback, 命中失败时 boot 脚本会回退到系统外观。
 *
 * 与 index.html boot 脚本中的字符串保持一致。
 */
export const THEME_CACHE_KEY = 'flowix-theme';

/**
 * 纯函数: 把 themeId + 系统偏好解析后, 把结果写到给定 root。
 *
 * 单一职责 — 不订阅 mq 变化、不 dispatch 事件、不写 CSS var。 这样:
 * - 切主题 = 1 次 setAttribute + 1 次 colorScheme 写入 (旧的 ~48 次 setProperty 变 2 次)。
 * - SSR / 单测 / 非 React 上下文都能复用, 副作用由上层 (ThemeProvider / useApplyTheme) 装配。
 * - 返回 resolvedId, 让上层拿到要广播给消费者的值 (markdown-editor 据此重跑 shiki 装饰)。
 *
 * 副作用: 同步把 resolved 写入 localStorage (THEME_CACHE_KEY), 供下次首屏
 * boot 脚本读取。 写入失败 (隐私模式 / 配额满) 静默吞掉, 不影响本次主题应用。
 */
export function applyTheme(
  root: HTMLElement,
  theme: ThemeId | string | undefined,
  opts: ApplyOptions,
): ResolvedThemeId {
  const id = sanitizeTheme(theme);
  const resolved: ResolvedThemeId =
    id === 'system' ? resolveSystemTheme(opts.prefersDark) : id;
  root.setAttribute('data-theme', resolved);
  // colorScheme 影响浏览器原生控件 (滚动条、表单) 的反色策略, 跟着主题走最自然。
  root.style.colorScheme = resolved === 'dark' ? 'dark' : 'light';
  try {
    localStorage.setItem(THEME_CACHE_KEY, resolved);
  } catch {
    // localStorage 不可用不影响主题应用, 静默吞掉。
  }
  return resolved;
}
