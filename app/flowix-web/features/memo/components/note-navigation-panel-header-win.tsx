'use client';

import { CaretDoubleLeftIcon } from '@phosphor-icons/react';

import { Tooltip } from '@shared/ui/tooltip';
import { useI18n } from '@features/i18n';

interface NoteNavigationPanelHeaderWinProps {
  onTogglePanel: () => void;
}

/**
 * Windows header for the note navigation panel.
 *
 * Design rules:
 * - `h-9` (36px) ── Windows uses a native OS title bar
 *   (`<WindowsTitlebarControls />`) at the very top; this in-app header sits
 *   BELOW it and is purely internal UI decoration, so it can be shorter
 *   than the macOS variant.
 * - `px-2` ── matches MemoListTitlebarWin's horizontal padding; no traffic
 *   lights to reserve space for (Windows native chrome handles those).
 * - `data-tauri-drag-region` ── kept for consistency with other in-app
 *   titlebars; redundant on Windows because the OS title bar already
 *   handles window dragging, but harmless and keeps the visual layer
 *   uniform.
 * - `rounded-lg` + `w-7 h-7` button ── matches MemoListTitlebarWin's
 *   button sizing & Windows-typical tighter radius.
 */
export function NoteNavigationPanelHeaderWin({
  onTogglePanel,
}: NoteNavigationPanelHeaderWinProps) {
  const { t } = useI18n();
  return (
    <div
      data-tauri-drag-region
      className="shrink-0 h-9 px-2 flex items-center justify-end"
    >
      <Tooltip content={t("memo.navigation.collapsePanelTooltip")}>
        <button
          type="button"
          onClick={onTogglePanel}
          aria-label={t("memo.navigation.collapsePanel")}
          className="w-7 h-7 flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded-lg transition-colors"
        >
          <CaretDoubleLeftIcon className="w-4 h-4" weight="regular" />
        </button>
      </Tooltip>
    </div>
  );
}