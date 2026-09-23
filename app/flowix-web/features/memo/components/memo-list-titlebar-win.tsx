'use client';

import { SidebarToggleIcon } from '@shared/icons/sidebar-toggle-icon';
import { Tooltip } from '@shared/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { CaretDoubleLeftIcon } from '@phosphor-icons/react';
import searchIcon from '@/assets/search.svg?raw';
import { NotebookIconMenu } from './notebook-icon-menu';
import type { Notebook } from '../store';

interface MemoListTitlebarWinProps {
  isPreview?: boolean;
  noteNavigationVisible: boolean;
  selectedNotebook: Notebook | null;
  onCollapseMemoList: () => void;
  onToggleNoteNavigation: () => void;
  onOpenPreferences: (tab?: string) => void;
}

export function MemoListTitlebarWin({
  isPreview = false,
  noteNavigationVisible,
  selectedNotebook,
  onCollapseMemoList,
  onToggleNoteNavigation,
  onOpenPreferences,
}: MemoListTitlebarWinProps) {
  const { t } = useI18n();
  return (
    <div
      data-tauri-drag-region
      className="relative h-9 px-3 shrink-0 flex items-center justify-between gap-1"
    >
      <div className="flex items-center">
        {!isPreview && selectedNotebook && (
          <NotebookIconMenu
            noteNavigationVisible={noteNavigationVisible}
            onToggleNoteNavigation={onToggleNoteNavigation}
            onOpenPreferences={onOpenPreferences}
            buttonClassName="h-6 w-6 [-webkit-app-region:no-drag]"
            productIconClassName="-translate-x-[3px]"
          />
        )}
      </div>
      <div className="flex items-center gap-4">
        {!isPreview && (
          <>
            <Tooltip content={t("memo.list.searchTooltip")} shortcut="palette.search">
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent('flowix:open-palette'))}
                aria-label={t("memo.list.search")}
                className="w-5 h-5 flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors [-webkit-app-region:no-drag]"
              >
                <span
                  className="flex h-5 w-5 items-center justify-center [&>svg]:h-5 [&>svg]:w-5"
                  dangerouslySetInnerHTML={{ __html: searchIcon }}
                />
              </button>
            </Tooltip>
          </>
        )}
        {!isPreview && (
          <Tooltip
            content={t("memo.list.collapseMemoListTooltip")}
            shortcut="panel.memoList.toggle"
          >
            <button
              type="button"
              onClick={onCollapseMemoList}
              aria-label={t("memo.list.collapseMemoList")}
              className="w-5 h-5 flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors [-webkit-app-region:no-drag]"
            >
              <SidebarToggleIcon className="w-5 h-5" />
            </button>
          </Tooltip>
        )}
        {isPreview && (
          <Tooltip content={t("memo.list.collapseMemoListTooltip")}>
            <button
              type="button"
              onClick={onCollapseMemoList}
              aria-label={t("memo.list.collapseMemoList")}
              className="w-5 h-5 flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors [-webkit-app-region:no-drag]"
            >
              <CaretDoubleLeftIcon className="h-4 w-4" weight="regular" />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
