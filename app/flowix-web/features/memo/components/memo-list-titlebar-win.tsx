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

interface MemoListTitlebarWinProps {
  onCollapseSidebar: () => void;
  onToggleNoteNavigation: () => void;
  onOpenPreferences: () => void;
}

export function MemoListTitlebarWin({
  onCollapseSidebar,
  onToggleNoteNavigation,
  onOpenPreferences,
}: MemoListTitlebarWinProps) {
  const { t } = useI18n();

  return (
    <div
      data-tauri-drag-region
      className="h-9 px-2 shrink-0 flex items-center justify-between gap-1"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Flowix menu"
            className="flex h-7 items-center gap-1 rounded-md pl-1 pr-2 select-none transition-colors hover:bg-[var(--muted)]"
          >
            <img src={productLogo} alt="" aria-hidden="true" className="h-[12.6px] w-[12.6px] shrink-0 rounded" />
            <span className="leading-none translate-y-[1px] text-[13px] font-semibold tracking-tight text-[color-mix(in_oklch,var(--foreground)_86%,transparent)]">
              Flowix
            </span>
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
      <div className="flex items-center gap-1">
        <Tooltip content="Collapse sidebar" shortcut="panel.memoList.toggle">
          <button
            type="button"
            onClick={onCollapseSidebar}
            aria-label="Collapse sidebar"
            className="w-7 h-7 flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
          >
            <SidebarToggleIcon className="w-4 h-4" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
