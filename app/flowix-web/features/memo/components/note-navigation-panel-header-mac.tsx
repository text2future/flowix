'use client';

import { CaretDoubleLeftIcon } from '@phosphor-icons/react';

import { Tooltip } from '@shared/ui/tooltip';
import { useI18n } from '@/lib/i18n';

interface NoteNavigationPanelHeaderMacProps {
  onTogglePanel: () => void;
}

/**
 * macOS header for the note navigation panel.
 *
 * The 40px height matches the Windows navigation panel header. The main
 * macOS window uses an overlay title bar; this strip provides a drag region
 * within the navigation panel and reserves space for the traffic lights.
 */
export function NoteNavigationPanelHeaderMac({
  onTogglePanel,
}: NoteNavigationPanelHeaderMacProps) {
  const { t } = useI18n();
  return (
    <div
      data-tauri-drag-region
      className="shrink-0 h-10 pl-[90px] flex items-center justify-end"
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
