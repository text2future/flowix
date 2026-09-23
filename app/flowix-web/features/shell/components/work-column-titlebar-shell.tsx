'use client';

import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { isMac } from '@features/shortcuts';
import { useI18n } from '@/lib/i18n';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@shared/ui/context-menu';
import { useWorkColumnTransferViewModel } from '@features/workspace/public/shell-api';
import { canUseNativeContextMenu, logNativeContextMenuError, popupNativeContextMenu } from '@platform/tauri/native-context-menu';
import { buildWorkColumnContextMenuItems } from '@features/shell/menus/work-column-context-menu';

/** Shared titlebar fade used by the work column and browser-column tabs. */
export const WORK_COLUMN_TITLEBAR_GRADIENT =
  'linear-gradient(to bottom, var(--bg-titlebar), transparent)';

interface WorkColumnTitlebarShellProps {
  isWindows: boolean;
  reserveWindowsControls?: boolean;
  showTrafficLightSpacer?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/** Shared frame for the work-column document and Agent titlebars. */
export function WorkColumnTitlebarShell({
  isWindows,
  reserveWindowsControls = true,
  showTrafficLightSpacer = false,
  className = '',
  style,
  children,
}: WorkColumnTitlebarShellProps) {
  const { t } = useI18n();
  const { canOpenInBrowserColumn, openInBrowserColumn } = useWorkColumnTransferViewModel();
  const useNativeMenu = canUseNativeContextMenu();

  const showNativeContextMenu = async (event: MouseEvent<HTMLDivElement>) => {
    if (!canUseNativeContextMenu()) return;
    try {
      await popupNativeContextMenu(event, buildWorkColumnContextMenuItems({
        label: t('workColumn.context.openInBrowserColumn'),
        enabled: canOpenInBrowserColumn,
        openInBrowserColumn: () => void openInBrowserColumn(),
      }));
    } catch (error) {
      logNativeContextMenuError('work-column titlebar', error);
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-tauri-drag-region
          // On Windows the shared ContextMenuTrigger must receive the event
          // directly so it can open the web menu. Installing a no-op native
          // handler here can prevent that fallback in the drag-region titlebar.
          onContextMenu={useNativeMenu ? (event) => void showNativeContextMenu(event) : undefined}
          className={`z-[50] flex shrink-0 select-none items-center pl-2 ${
            isWindows
              ? `h-9 ${reserveWindowsControls ? 'pr-[126px]' : 'pr-0'}`
              : 'h-12'
          } ${className}`}
          style={style}
        >
          {isMac() && showTrafficLightSpacer && (
            <div aria-hidden="true" className="h-full w-[88px] shrink-0" />
          )}
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-[180px] space-y-0.5 rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <ContextMenuItem
          disabled={!canOpenInBrowserColumn}
          onClick={() => {
            if (canOpenInBrowserColumn) {
              void openInBrowserColumn();
            }
          }}
          className="h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
        >
          <span className="leading-5">{t('workColumn.context.openInBrowserColumn')}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
