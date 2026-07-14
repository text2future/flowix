import { DEFAULT_APP_LANGUAGE, type AppLanguage } from './locales';

/**
 * 跟随系统语言推断 UI 语言。
 *
 * 规则:
 * - navigator.language 以 `zh` 开头 → `zh-CN`
 * - 其他 / 不可用 → `en-US`
 *
 * 注意: `navigator.language` 在 webview 中拿的是 webview 自身的语言首选项
 * (Tauri 在 macOS / Windows / Linux 都透传 OS 的系统语言), 不会触发任何
 * 权限请求, 可以静默调用。
 */
export function detectSystemLanguage(): AppLanguage {
  if (typeof navigator === 'undefined' || !navigator.language) {
    return DEFAULT_APP_LANGUAGE;
  }
  const lang = navigator.language.trim().toLowerCase();
  return lang.startsWith('zh') ? 'zh-CN' : 'en-US';
}

// ============================================================
// Region 识别 — 单独成段, 与 language 解耦。
// 数据源: navigator.language + Intl 时区, 全部 webview / OS 公开元数据,
// 不需要任何权限, 不会触发授权弹窗。
// ============================================================

export type Region = 'mainland' | 'overseas';

const MAINLAND_TIMEZONES = new Set<string>([
  'Asia/Shanghai',
  'Asia/Urumqi',
  'Asia/Chongqing',
  'Asia/Harbin',
  'Asia/Shenzhen',
  'Asia/Kashgar',
]);

/**
 * 判定地区 — 命中即返回, 顺序:
 * 1. navigator.language 含 `zh-cn` / `zh-hans` (简体 / 简体-中国) → mainland
 * 2. navigator.language = `zh` / `zh-hans` (未指定国家) → mainland
 * 3. Intl 时区落在大陆时区 (Asia/Shanghai 等) → mainland
 * 4. 其余 → overseas
 */
export function detectRegion(): Region {
  if (typeof navigator !== 'undefined' && navigator.language) {
    const lang = navigator.language.trim().toLowerCase();

    // 含国别的简体: zh-CN / zh-Hans-CN / zh-Hans (脚本形式)
    if (
      lang === 'zh-cn' ||
      lang === 'zh-hans' ||
      lang === 'zh-hans-cn' ||
      lang.startsWith('zh-cn') ||
      lang.startsWith('zh-hans-cn')
    ) {
      return 'mainland';
    }
    // 不带国别的简体 / 中文 (用户系统语言只标到 `zh`)
    if (lang === 'zh' || lang === 'zh-hans') {
      return 'mainland';
    }
  }

  // 时区兜底: 显式简体中文 locale 拿不到时, 看 OS 时区是否落在大陆
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && MAINLAND_TIMEZONES.has(tz)) {
      return 'mainland';
    }
  } catch {
    // Intl 不可用时跳过
  }

  return 'overseas';
}
