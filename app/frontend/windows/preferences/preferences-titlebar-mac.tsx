'use client';

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
 * - 左侧 90px 留空给红绿灯 (与 document-titlebar-mac 保持一致)
 * - 标题居中, 沿用 macOS Big Sur+ 的窗口标题惯例
 * - 整条作为 Tauri drag region
 */
export function PreferencesTitlebarMac() {
  return (
    <div
      data-tauri-drag-region
      className="h-12 shrink-0 pl-[90px] pr-4 flex items-center justify-center bg-[#f7f7f7] border-b border-black/5 select-none"
    >
      <span
        className="text-sm font-semibold tracking-tight text-[var(--foreground)] pointer-events-none"
        aria-label="Preferences"
      >
        Preferences
      </span>
    </div>
  );
}
