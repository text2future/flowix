'use client';

import { CaretDoubleLeftIcon } from '@phosphor-icons/react';

import { Tooltip } from '@shared/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { NotebookIconMenu } from './notebook-icon-menu';

interface NoteNavigationPanelHeaderWinProps {
  onTogglePanel: () => void;
  onOpenPreferences: (tab?: string) => void;
}

/**
 * Windows header for the note navigation panel.
 *
 * This 40px strip matches the macOS navigation panel header. It is an app
 * drag region; the main window uses custom controls with no native title bar.
 */
export function NoteNavigationPanelHeaderWin({
  onTogglePanel,
  onOpenPreferences,
}: NoteNavigationPanelHeaderWinProps) {
  const { t } = useI18n();
  return (
    <div
      data-tauri-drag-region
      className="shrink-0 h-10 px-2 flex items-center justify-between"
    >
      <div className="ml-1 flex items-center">
        <NotebookIconMenu
          onOpenPreferences={onOpenPreferences}
          buttonClassName="h-6 w-6"
        />
      </div>
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
