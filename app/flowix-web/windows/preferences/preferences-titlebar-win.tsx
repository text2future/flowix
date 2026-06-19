'use client';

/**
 * Windows title bar for the Preferences window.
 *
 * Design rules:
 * - 通栏 (spans the full window width above both sidebar and content)
 * - 高度与控制条一致 (h-9 / 36px, identical to the standard Windows control bar)
 * - 左侧展示标题 Preferences
 * - 右侧预留 126px (= 42 + 42 + 42) 给 <WindowsTitlebarControls />
 *   渲染的最小化/最大化/关闭按钮
 * - 整条都作为 Tauri drag region
 */
export function PreferencesTitlebarWin() {
  return (
    <div
      data-tauri-drag-region
      className="h-9 shrink-0 pl-4 pr-[126px] flex items-center bg-[var(--bg-titlebar)] border-b border-solid border-[var(--divider)] select-none"
    >
      <span
        className="text-sm font-semibold tracking-tight text-[var(--foreground)] pointer-events-none"
        aria-label="偏好设置"
      >
        偏好设置
      </span>
    </div>
  );
}
