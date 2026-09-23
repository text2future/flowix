'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { ArrowLeftToLine, ArrowRightToLine } from 'lucide-react';
import { PREFERENCE_TAB_GROUPS } from '@features/preferences/public/app-api';
import { ShortcutKbd } from '@shared/ui/shortcut-kbd';
import productLogo from '@/assets/productlogo.png';
import { cn } from '@/lib/utils';
import { openUrl } from '@platform/tauri/opener';

interface NotebookIconMenuProps {
  noteNavigationVisible: boolean;
  onToggleNoteNavigation: () => void;
  /** 打开偏好设置窗口; 可传入偏好 tab id (如 'theme' / 'dsh' / 'mcp' / 'aiAgent')。 */
  onOpenPreferences: (tab?: string) => void;
  buttonClassName?: string;
  productIconClassName?: string;
}

// hover 打开下拉窗的延迟: 指针悬停多久后展示菜单。
const HOVER_OPEN_DELAY_MS = 800;
// hover 打开下拉窗的关闭延迟: 给指针留出从图标(trigger)跨越到 portal 菜单的间隙。
const HOVER_CLOSE_DELAY_MS = 150;
const NOTEBOOK_ICON_MENU_CLASS =
  'w-[12.8rem] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]';
const NOTEBOOK_ICON_MENU_ITEM_CLASS =
  'group h-7 items-center justify-start gap-1.5 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';
const NOTEBOOK_ICON_MENU_DIVIDER_CLASS = 'mx-1 my-1 h-px bg-[var(--border-popup)] opacity-60';
const OFFICIAL_SITE_URL = 'https://flowix.cc';
const COMMUNITY_URL = 'https://github.com/text2future/flowix';

/**
 * 中间列顶部的图标 (统一展示产品图标):
 * - hover 图标 → 延迟展示 Flowix 下拉菜单 (笔记导航 / 偏好设置)
 * - 点击整个产品图标按钮 → 展示下拉菜单
 */
export function NotebookIconMenu({
  noteNavigationVisible,
  onToggleNoteNavigation,
  onOpenPreferences,
  buttonClassName,
  productIconClassName,
}: NotebookIconMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const visiblePreferenceGroups = PREFERENCE_TAB_GROUPS.map((group) => ({
    ...group,
    tabs: group.tabs.filter((tab) => !['cloudSync', 'connections', 'tools', 'history'].includes(tab.id)),
  }));

  const cancelOpen = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  // 悬停后延迟展示菜单; 离开图标或点击图标都会取消未触发的打开。
  const scheduleOpen = useCallback(() => {
    cancelOpen();
    cancelClose();
    openTimerRef.current = window.setTimeout(() => setOpen(true), HOVER_OPEN_DELAY_MS);
  }, [cancelOpen, cancelClose]);

  // 离开图标/菜单后延迟收起, 给指针留出跨越间隙的时间; 同时取消未触发的打开。
  const scheduleClose = useCallback(() => {
    cancelOpen();
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS);
  }, [cancelOpen, cancelClose]);

  useEffect(() => {
    return () => {
      if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
      }}
    >
      <DropdownMenuTrigger asChild onClick={() => setOpen(true)}>
        <button
          type="button"
          aria-label={t('memo.list.notebookMenu.open')}
          title={t('memo.list.notebookMenu.open')}
          className={cn('group relative flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center', buttonClassName)}
          onMouseEnter={scheduleOpen}
          onMouseLeave={scheduleClose}
        >
          <img
            src={productLogo}
            alt=""
            aria-hidden="true"
            className={cn(
              'product-icon h-[18px] w-[18px] shrink-0 rounded opacity-30 transition-opacity group-hover:opacity-100',
              productIconClassName,
            )}
          />
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute bottom-[3px] right-[3px] h-0 w-0 border-b-[5px] border-l-[5px] border-l-transparent transition-opacity',
              open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            )}
            style={{
              borderBottomColor: 'color-mix(in oklch, var(--foreground) 30%, var(--bg-titlebar))',
            }}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={2}
        className={NOTEBOOK_ICON_MENU_CLASS}
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
      >
        <DropdownMenuItem
          onClick={onToggleNoteNavigation}
          className={NOTEBOOK_ICON_MENU_ITEM_CLASS}
        >
          {noteNavigationVisible ? (
            <ArrowLeftToLine className="h-4 w-4 shrink-0" />
          ) : (
            <ArrowRightToLine className="h-4 w-4 shrink-0" />
          )}
          <span>
            {t(
              noteNavigationVisible
                ? 'memo.list.notebookMenu.collapseNavigation'
                : 'memo.list.notebookMenu.expandNavigation',
            )}
          </span>
          <ShortcutKbd
            actionId="panel.noteNavigation.toggle"
            className="ml-auto text-[var(--muted-foreground)] group-hover:text-[var(--primary-foreground)]"
          />
        </DropdownMenuItem>
        {/* 与筛选/排序等其它下拉窗一致的分割线样式 */}
        <div role="separator" aria-hidden="true" className={NOTEBOOK_ICON_MENU_DIVIDER_CLASS} />
        {visiblePreferenceGroups.map((group) => (
          <div key={group.labelKey}>
            <DropdownMenuLabel className="shrink-0 px-2 py-1 text-xs font-normal uppercase tracking-wider text-[var(--muted-foreground)]">
              {t(group.labelKey)}
            </DropdownMenuLabel>
            {group.tabs.map((tab) => (
              <DropdownMenuItem
                key={tab.id}
                onClick={() => onOpenPreferences(tab.id)}
                className={NOTEBOOK_ICON_MENU_ITEM_CLASS}
              >
                {tab.icon}
                <span>{t(tab.labelKey)}</span>
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        <div role="separator" aria-hidden="true" className={NOTEBOOK_ICON_MENU_DIVIDER_CLASS} />
        <DropdownMenuLabel className="shrink-0 px-2 py-1 text-xs font-normal uppercase tracking-wider text-[var(--muted-foreground)]">
          {t('memo.list.notebookMenu.about')}
        </DropdownMenuLabel>
        <DropdownMenuItem
          onClick={() => void openUrl(OFFICIAL_SITE_URL)}
          className={NOTEBOOK_ICON_MENU_ITEM_CLASS}
        >
          <span>{t('memo.list.notebookMenu.officialWebsite')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => void openUrl(COMMUNITY_URL)}
          className={NOTEBOOK_ICON_MENU_ITEM_CLASS}
        >
          <span>{t('memo.list.notebookMenu.community')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
