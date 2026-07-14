'use client';

import { CaretDoubleLeftIcon } from '@phosphor-icons/react';

import { Tooltip } from '@shared/ui/tooltip';
import { useI18n } from '@features/i18n';

interface NoteNavigationPanelHeaderMacProps {
  onTogglePanel: () => void;
}

/**
 * macOS header for the note navigation panel.
 *
 * Design rules:
 * - `h-12` (48px) ── macOS uses frameless Tauri window; this header doubles
 *   as the OS title bar so it must be tall enough for comfortable drag and
 *   to match the other Mac title bars in the app.
 * - `pl-[90px]` ── reserves space for the macOS traffic-light cluster
 *   (~78px wide at x=18) so the collapse button on the right side doesn't
 *   visually collide with the OS controls on the left.
 * - `data-tauri-drag-region` ── drag-to-move-window; Tauri's webview handles
 *   the actual window manipulation.
 * - `rounded-xl` + `w-8 h-8` button ── matches DocumentTitlebarMac's touch
 *   target sizing & macOS-typical rounded affordance.
 */
export function NoteNavigationPanelHeaderMac({
  onTogglePanel,
}: NoteNavigationPanelHeaderMacProps) {
  const { t } = useI18n();
  return (
    <div
      data-tauri-drag-region
      className="shrink-0 h-12 pl-[90px] pr-2 flex items-center justify-end"
    >
      <Tooltip content={t("memo.navigation.collapsePanelTooltip")}>
        <button
          type="button"
          onClick={onTogglePanel}
          aria-label={t("memo.navigation.collapsePanel")}
          className="w-8 h-8 flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded-xl transition-colors"
        >
          <CaretDoubleLeftIcon className="w-4 h-4" weight="regular" />
        </button>
      </Tooltip>
    </div>
  );
}