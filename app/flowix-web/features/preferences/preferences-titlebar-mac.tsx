'use client';

import { useI18n } from '@features/i18n';

/**
 * Mac title bar for the Preferences window.
 *
 * The window is created with `titleBarStyle(Overlay)` + `hiddenTitle(true)`
 * (see `open_preferences_window` in commands.rs), so the system renders only
 * the traffic-light cluster at the top-left — no separate title strip — and
 * this `h-12` bar sits directly under it, sharing the same drag region.
 *
 * Design rules:
 * - h-12 (48px) — matches the other Mac title bars in the app
 * - 标题在整条 bar 内水平居中
 *   红绿灯在 Rust 端固定在 (x=18, y=25) — 与主窗口 tauri.conf.json 完全相同
 *   标题较短（4 字符），与红绿灯无视觉冲突
 * - 整条作为 Tauri drag region
 */
export function PreferencesTitlebarMac() {
  const { t } = useI18n();
  const title = t('preferences.title');

  return (
    <div
      data-tauri-drag-region
      className="h-12 shrink-0 pr-4 flex items-center justify-center bg-[var(--bg-titlebar)] border-b border-solid border-[var(--divider)] select-none"
    >
      <span
        className="text-base font-semibold tracking-tight text-center text-[var(--foreground)] pointer-events-none"
        aria-label={title}
      >
        {title}
      </span>
    </div>
  );
}
