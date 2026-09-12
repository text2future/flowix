'use client';

import { SidebarToggleIcon } from '@shared/icons/sidebar-toggle-icon';
import { Tooltip } from '@shared/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { NotebookIconMenu } from './notebook-icon-menu';
import type { Notebook } from '../store';

interface MemoListTitlebarMacProps {
  noteNavigationVisible: boolean;
  selectedNotebook: Notebook | null;
  onCollapseMemoList: () => void;
  onToggleNoteNavigation: () => void;
  onOpenPreferences: (tab?: string) => void;
}

export function MemoListTitlebarMac({
  noteNavigationVisible,
  selectedNotebook,
  onCollapseMemoList,
  onToggleNoteNavigation,
  onOpenPreferences,
}: MemoListTitlebarMacProps) {
  const { t } = useI18n();
  return (
    <div
      data-tauri-drag-region
      className="relative h-12 pr-3.5 shrink-0 flex items-center justify-between gap-1"
    >
      <div className="ml-[82px] flex items-center">
        {selectedNotebook && (
          <NotebookIconMenu
            noteNavigationVisible={noteNavigationVisible}
            onToggleNoteNavigation={onToggleNoteNavigation}
            onOpenPreferences={onOpenPreferences}
            buttonClassName="ml-1 h-6 w-6"
          />
        )}
      </div>
      <Tooltip content={t("memo.list.collapseMemoListTooltip")} shortcut="panel.memoList.toggle">
        <button
          type="button"
          onClick={onCollapseMemoList}
          aria-label={t("memo.list.collapseMemoList")}
          className="w-5 h-5 flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
        >
          <SidebarToggleIcon className="w-5 h-5" />
        </button>
      </Tooltip>
    </div>
  );
}
