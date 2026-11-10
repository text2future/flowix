'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, ListFilter, ListTodo, X } from 'lucide-react';

import { MapPinSimpleAreaIcon } from '@phosphor-icons/react';

import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useNoteStore } from '@features/memo/store/note-store';
import { useTagStore } from '@features/memo/store/tag-store';
import { TagTree } from '@features/memo/components/tag-tree';
import { NoteFilterMenu } from '@features/collection/public/note-filter-menu';
import type { NoteFilterConfig } from '@features/collection/public/note-filter-api';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { TagIcon, TagSvgIcon } from '@shared/ui/tag-icon';

const MEMO_NAVIGATION_MENU_CLASS =
  'w-[190px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]';
const MEMO_NAVIGATION_MENU_ITEM_CLASS =
  'group flex h-7 cursor-pointer items-center justify-between rounded-lg py-0 pl-[6px] pr-2 text-left hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]';

export type MemoNavigationTarget = 'all' | 'todos' | 'tags';

interface NavigationSubmenuProps {
  label: ReactNode;
  icon?: ReactNode;
  itemIcon?: ReactNode;
  labelAdornment?: ReactNode;
  /**
   * 尾部 ChevronRight 旁的当前值提示（例如已选的筛选 / 排序）。
   * 与 labelAdornment 不同：labelAdornment 贴在 label 文本后（左侧），
   * valueAdornment 贴在右侧 Chevron 旁（尾部）。
   */
  valueAdornment?: ReactNode;
  open: boolean;
  items?: Array<{ id: string; label: string; secondary?: string }>;
  loading?: boolean;
  emptyText: string;
  loadingText: string;
  /**
   * 隐藏二级弹窗顶部的 group label（默认渲染 label 文案）。
   * 自定义 submenuContent 时如果调用方已在内部写了分组标题，
   * 顶部那个与 label 同名的 header 就会冗余 ── 传 true 不渲染。
   */
  hideHeader?: boolean;
  submenuContent?: ReactNode;
  submenuClassName?: string;
  onOpenChange: (open: boolean) => void;
  onCloseMenu?: () => void;
  onSelect?: (id: string) => void;
  onClick?: () => void;
}

export function MemoNavigationSubmenu({
  label,
  icon,
  itemIcon,
  labelAdornment,
  valueAdornment,
  open,
  items = [],
  loading = false,
  emptyText,
  loadingText,
  hideHeader = false,
  submenuContent,
  submenuClassName,
  onOpenChange,
  onCloseMenu,
  onSelect,
  onClick,
}: NavigationSubmenuProps) {
  const closeTimerRef = useRef<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState<CSSProperties>({ left: '100%', top: 0 });

  const cancelClose = () => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      onOpenChange(false);
      closeTimerRef.current = null;
    }, 160);
  };

  useEffect(() => () => cancelClose(), []);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const submenu = submenuRef.current;
      if (!trigger || !submenu) return;
      const rect = trigger.getBoundingClientRect();
      const width = submenu.offsetWidth || 220;
      const height = Math.min(submenu.offsetHeight || submenu.scrollHeight, window.innerHeight - 16);
      const opensLeft = window.innerWidth - rect.right < width + 8;
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - height - 8));
      setSubmenuPosition({
        left: opensLeft ? undefined : '100%',
        right: opensLeft ? '100%' : undefined,
        top: top - rect.top,
      });
    };
    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    const observer = typeof ResizeObserver === 'undefined' || !submenuRef.current
      ? null
      : new ResizeObserver(updatePosition);
    if (observer && submenuRef.current) observer.observe(submenuRef.current);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  return (
    <div
      className="relative"
      onMouseEnter={() => {
        cancelClose();
        onOpenChange(true);
      }}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        ref={triggerRef}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'memo-navigation-submenu-trigger flex h-7 w-full cursor-pointer items-center justify-between rounded-lg py-0 pl-[6px] pr-2 text-sm text-[var(--foreground)] outline-none transition-colors',
          // 第一层级行 hover 即展开：hover 与展开态统一用中性 hover-bg。
          'hover:bg-[var(--hover-bg)]',
          open && 'bg-[var(--hover-bg)]',
        )}
        onClick={() => {
          onClick?.();
          if (onClick) {
            onCloseMenu?.();
            return;
          }
          onOpenChange(!open);
        }}
      >
        <span className={cn('flex min-w-0 items-center', icon && 'gap-2')}>
          {icon}
          <span className="truncate">{label}</span>
          {labelAdornment}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {valueAdornment}
          <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
        </span>
      </button>
      {open && (
        <div ref={submenuRef} style={{ ...submenuPosition, maxWidth: 'calc(100vw - 16px)', transformOrigin: 'top left' }} className={cn('flowix-popover-enter absolute z-[151] flex max-h-[min(var(--memo-submenu-max-height,560px),calc(100vh-16px))] w-[220px] flex-col overflow-hidden rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]', submenuClassName)}>
          {!hideHeader && (
            <div
              className="mention-note-header"
              aria-label={typeof label === 'string' ? label : undefined}
            >
              <span>{label}</span>
              {labelAdornment}
            </div>
          )}
          {submenuContent ?? (
            <OverlayScrollbar
              className="mention-note-items-frame"
              scrollerClassName="mention-note-items"
            >
              {loading ? (
                <div className="mention-note-empty mention-note-empty--loading">{loadingText}</div>
              ) : items.length === 0 ? (
                <div className="mention-note-empty">{emptyText}</div>
              ) : (
                items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    title={item.secondary ? `${item.label} · ${item.secondary}` : item.label}
                    className="memo-navigation-submenu-item mention-note-item !h-7 !min-h-7 !rounded-lg !py-0 !pl-[6px] !pr-2 hover:bg-[var(--brand)] focus-visible:bg-[var(--brand)] focus-visible:outline-none"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      onSelect?.(item.id);
                      onCloseMenu?.();
                      onOpenChange(false);
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {itemIcon}
                      <span className="mention-note-title">{item.label}</span>
                    </span>
                    {item.secondary && (
                      <span className="mention-note-notebook mention-note-notebook-name">
                        {item.secondary}
                      </span>
                    )}
                  </button>
                ))
              )}
            </OverlayScrollbar>
          )}
        </div>
      )}
    </div>
  );
}

interface MemoNavigationDropdownProps {
  title: ReactNode;
  titleTooltip?: string;
  ariaLabel: string;
  leadingContent?: ReactNode;
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onNavigate?: (target: MemoNavigationTarget) => void;
  showClear?: boolean;
  onClear?: () => void;
  notebookPath?: string | null;
  defaultCreateFolder?: string | null;
  onSavePath?: (path: string | null) => Promise<boolean>;
  className?: string;
}

/**
 * Shared navigation menu for the notes list view.
 *
 * The filter and sort entries are supplied by MemoList so their state remains
 * owned by the list while the common note/task/tag entries stay in one place.
 */
export function MemoNavigationDropdown({
  title,
  titleTooltip,
  ariaLabel,
  leadingContent,
  children,
  open,
  onOpenChange,
  onNavigate,
  showClear = false,
  onClear,
  notebookPath,
  defaultCreateFolder,
  onSavePath,
  className,
}: MemoNavigationDropdownProps) {
  const { t } = useI18n();
  const activeFilter = useNoteStore((state) => state.activeFilter);
  const selectedNotebook = useNoteStore((state) => state.selectedNotebook);
  const selectedTagId = useTagStore((state) => state.selectedTagId);
  const setActiveFilter = useNoteStore((state) => state.setActiveFilter);
  const setSelectedTagId = useTagStore((state) => state.setSelectedTagId);
  const tags = useTagStore((state) => state.tags);
  const loadTags = useTagStore((state) => state.loadTags);
  const selectedNotebookId = selectedNotebook?.id ?? null;
  const [internalOpen, setInternalOpen] = useState(false);
  const [openSubmenu, setOpenSubmenu] = useState<'tags' | null>(null);
  const dataCondition = useNoteStore(state => state.dataConditionsByNotebook?.[selectedNotebookId ?? ''] ?? null);
  const setDataCondition = useNoteStore(state => state.setDataCondition);
  const datasetConfig = useMemo<NoteFilterConfig>(() => ({
    condition: {
      ...(dataCondition ?? {}),
      path: defaultCreateFolder ?? '',
    },
  }), [dataCondition, defaultCreateFolder]);
  const menuOpen = open ?? internalOpen;

  const handleMenuOpenChange = useCallback((nextOpen: boolean) => {
    if (open === undefined) {
      setInternalOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  }, [onOpenChange, open]);

  const closeMenu = useCallback(() => {
    handleMenuOpenChange(false);
  }, [handleMenuOpenChange]);

  useEffect(() => {
    if (!menuOpen) setOpenSubmenu(null);
  }, [menuOpen]);

  useEffect(() => {
    if (!selectedNotebookId) return;
    void loadTags(selectedNotebookId);
  }, [loadTags, selectedNotebookId]);

  const isActive = (target: MemoNavigationTarget): boolean => {
    if (target === 'tags') return activeFilter === 'tagged';
    return activeFilter === target;
  };

  const handleNavigate = (target: MemoNavigationTarget) => {
    // Navigation to the category itself has no specific tag selected. The
    // tag tree remains available on the left for choosing an individual tag.
    setSelectedTagId(null);
    setActiveFilter(target === 'tags' ? 'tagged' : target);
    onNavigate?.(target);
  };

  const selectedTagName = selectedTagId
    ? (tags.find((tag) => tag.id === selectedTagId)?.name ?? selectedTagId)
    : null;

  return (
    <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
      <div className={cn('group flex min-w-0 items-center', className)}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={ariaLabel}
            title={titleTooltip}
            className="flex min-w-0 max-w-full items-center gap-0.5 overflow-hidden rounded-md py-0.5 pl-0 pr-1 transition-colors"
          >
            <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-[var(--foreground)] transition-colors duration-150 group-hover:text-[color-mix(in_oklch,var(--foreground)_80%,white)]">
              {title}
            </span>
            <ChevronDown
              aria-hidden="true"
              className="h-3.5 w-3 shrink-0 text-[var(--foreground)]"
              strokeWidth={2.5}
            />
          </button>
        </DropdownMenuTrigger>
        {showClear && onClear && (
          <button
            type="button"
            aria-label={t('memo.navigation.clearFilter')}
            title={t('memo.navigation.clearFilter')}
            className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-md text-[var(--foreground)] hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
            onClick={onClear}
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
        )}
      </div>
      <DropdownMenuContent align="start" side="bottom" className={MEMO_NAVIGATION_MENU_CLASS}>
        {leadingContent}
        <NoteFilterMenu
          key={selectedNotebookId ?? 'no-notebook'}
          config={datasetConfig}
          notebookId={selectedNotebookId}
          notebookPath={notebookPath}
          saving={false}
          embedded
          folderLabel={t('memo.navigation.saveLocation')}
          folderPickerTitle={t('multidimensionalTable.autoCollect.writeLocation')}
          folderIcon={<MapPinSimpleAreaIcon className="h-4 w-4 shrink-0" aria-hidden="true" />}
          filterIcon={<ListFilter className="h-4 w-4 shrink-0" aria-hidden="true" />}
          t={(key: I18nKey) => t(key)}
          open={menuOpen}
          onOpenChange={handleMenuOpenChange}
          onSave={async (condition) => {
            if (!selectedNotebookId) return false;
            setDataCondition(selectedNotebookId, condition);
            return true;
          }}
          onSavePath={onSavePath}
        >
          <DropdownMenuItem
            onClick={() => handleNavigate('todos')}
            className={MEMO_NAVIGATION_MENU_ITEM_CLASS}
          >
            <span className="flex min-w-0 items-center gap-2">
              <ListTodo className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{t('memo.list.filterTasks')}</span>
            </span>
            {isActive('todos') && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--brand)] group-hover:text-[var(--foreground)]" aria-hidden="true" />}
          </DropdownMenuItem>
          <MemoNavigationSubmenu
            label={t('memo.navigation.tags')}
            icon={<TagSvgIcon className="h-[18px] w-[18px] shrink-0" />}
            submenuClassName="memo-navigation-tag-tree-submenu"
            hideHeader
            submenuContent={(
              <OverlayScrollbar
                className="mention-note-items-frame memo-navigation-tag-tree-frame"
                scrollerClassName="mention-note-items"
              >
                <TagTree
                  selectedNotebook={selectedNotebook}
                  onSelectTag={closeMenu}
                  variant="menu"
                />
              </OverlayScrollbar>
            )}
            valueAdornment={activeFilter === 'tagged' && selectedTagName ? (
              <span className="inline-flex max-w-[100px] items-center truncate text-xs text-[var(--muted-foreground)]">
                <TagIcon prefix />
                <span className="truncate">{selectedTagName}</span>
              </span>
            ) : undefined}
            open={openSubmenu === 'tags'}
            emptyText={t('memo.navigation.emptyTags')}
            loadingText={t('memo.navigation.loading')}
            onOpenChange={(open) => setOpenSubmenu((current) => {
              if (open) return 'tags';
              return current === 'tags' ? null : current;
            })}
            onCloseMenu={closeMenu}
            onClick={() => handleNavigate('tags')}
          />
          {children && <div>{children}</div>}
        </NoteFilterMenu>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
