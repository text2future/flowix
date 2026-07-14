'use client';

import { SidebarToggleIcon } from '@shared/icons/sidebar-toggle-icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { Tooltip } from '@shared/ui/tooltip';
import { useI18n } from '@features/i18n';
import productLogo from '@/assets/product-logo.png';

interface MemoListTitlebarMacProps {
  noteNavigationVisible: boolean;
  onCollapseSidebar: () => void;
  onToggleNoteNavigation: () => void;
  onOpenPreferences: () => void;
}

export function MemoListTitlebarMac({
  noteNavigationVisible,
  onCollapseSidebar,
  onToggleNoteNavigation,
  onOpenPreferences,
}: MemoListTitlebarMacProps) {
  const { t } = useI18n();
  return (
    <div
      data-tauri-drag-region
      className="h-12 px-3 shrink-0 flex items-center justify-between gap-1"
    >
      <div className={`${noteNavigationVisible ? '-ml-2' : 'ml-[72px]'} flex items-center`}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Flowix menu"
              className="w-8 h-8 flex items-center justify-center rounded-md select-none transition-colors hover:bg-[var(--muted)]"
            >
              <img
                src={productLogo}
                alt=""
                aria-hidden="true"
                className="h-4 w-4 shrink-0 rounded opacity-75"
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="bottom"
            sideOffset={2}
            className="w-[12.8rem] p-1 bg-[var(--popover)]"
          >
            <DropdownMenuItem
              onClick={onToggleNoteNavigation}
              className="rounded-md px-2 py-1.5 hover:bg-[var(--muted)]"
            >
              {t('shell.statusBar.noteNav')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onOpenPreferences}
              className="rounded-md px-2 py-1.5 hover:bg-[var(--muted)]"
            >
              {t('status.preferences')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Tooltip content={t("memo.list.collapseSidebarTooltip")} shortcut="panel.memoList.toggle">
        <button
          type="button"
          onClick={onCollapseSidebar}
          aria-label={t("memo.list.collapseSidebar")}
          className="w-8 h-8 flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
        >
          <SidebarToggleIcon className="w-5 h-5" />
        </button>
      </Tooltip>
    </div>
  );
}
