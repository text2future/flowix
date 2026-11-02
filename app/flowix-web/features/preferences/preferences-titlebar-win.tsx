'use client';

import { useI18n } from '@/lib/i18n';

/**
 * Windows title bar for the Preferences window.
 *
 * Design rules:
 * - 通栏 (spans the full window width above both sidebar and content)
 * - 高度与控制条共享 `--window-titlebar-height`
 * - 左侧展示标题 Preferences
 * - 右侧预留 `--window-controls-width` 给 <WindowsTitlebarControls />
 *   渲染的最小化/最大化/关闭按钮
 * - 整条都作为 Tauri drag region
 */
export function PreferencesTitlebarWin() {
  const { t } = useI18n();
  const title = t('preferences.title');

  return (
    <div
      data-tauri-drag-region
      className="h-[var(--window-titlebar-height)] shrink-0 pl-4 pr-[var(--window-controls-width)] flex items-center bg-[var(--bg-titlebar)] border-b border-solid border-[var(--divider)] select-none"
    >
      <span
        className="text-sm font-semibold tracking-tight text-[var(--foreground)] pointer-events-none"
        aria-label={title}
      >
        {title}
      </span>
    </div>
  );
}
