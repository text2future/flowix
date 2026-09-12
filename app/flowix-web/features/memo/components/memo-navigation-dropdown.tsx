'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, Hash, Layers, ListTodo, X } from 'lucide-react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useMemoStore, useTagStore } from '@features/memo';
import { TagMentionName } from '@features/editor/extensions/tag-mention/tag-mention-label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';

const MEMO_NAVIGATION_MENU_CLASS =
  'w-[220px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]';
const MEMO_NAVIGATION_MENU_ITEM_CLASS =
  'group flex h-7 cursor-pointer items-center justify-between rounded-lg py-0 pl-[6px] pr-2 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';

export type MemoNavigationTarget = 'all' | 'todos' | 'tags';

interface NavigationSubmenuProps {
  label: ReactNode;
  icon?: ReactNode;
  itemIcon?: ReactNode;
  itemKind?: 'tag' | 'reference';
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
  onOpenChange: (open: boolean) => void;
  onCloseMenu?: () => void;
  onSelect?: (id: string) => void;
  onClick?: () => void;
}

export function MemoNavigationSubmenu({
  label,
  icon,
  itemIcon,
  itemKind,
  labelAdornment,
  valueAdornment,
  open,
  items = [],
  loading = false,
  emptyText,
  loadingText,
  hideHeader = false,
  submenuContent,
  onOpenChange,
  onCloseMenu,
  onSelect,
  onClick,
}: NavigationSubmenuProps) {
  const closeTimerRef = useRef<number | null>(null);
  const selectedTagId = useTagStore((state) => state.selectedTagId);

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
        className={cn(
          'memo-navigation-submenu-trigger flex h-7 w-full cursor-pointer items-center justify-between rounded-lg py-0 pl-[6px] pr-2 text-sm text-[var(--foreground)] outline-none transition-colors',
          open
            ? 'bg-[var(--muted)] hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]'
            : 'hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]',
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
        <div className="absolute left-full top-0 z-[151] flex max-h-[min(560px,calc(100vh-16px))] w-[220px] flex-col overflow-hidden rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
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
                    className={cn(
                      'memo-navigation-submenu-item mention-note-item !h-7 !min-h-7 !rounded-lg !py-0 !pl-[6px] !pr-2 hover:bg-[var(--brand)] focus-visible:bg-[var(--brand)] focus-visible:outline-none',
                      itemKind === 'tag' && item.id === selectedTagId && 'is-selected',
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      onSelect?.(item.id);
                      onCloseMenu?.();
                      onOpenChange(false);
                    }}
                  >
                    {itemKind === 'tag' ? (
                      <span className="mention-note-title mention-tag-title">
                        <span className="mention-tag-icon" aria-hidden="true" />
                        <TagMentionName name={item.label} />
                      </span>
                    ) : (
                      <span className="flex min-w-0 items-center gap-2">
                        {itemIcon}
                        <span className="mention-note-title">{item.label}</span>
                      </span>
                    )}
                    {itemKind === 'reference' && item.secondary && (
                      <span className="mention-note-notebook mention-note-notebook-name">
                        {item.secondary}
                      </span>
                    )}
                    {itemKind === 'tag' && item.id === selectedTagId && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-[var(--brand)]" aria-hidden="true" />
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
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onNavigate?: (target: MemoNavigationTarget) => void;
  showClear?: boolean;
  onClear?: () => void;
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
  children,
  open,
  onOpenChange,
  onNavigate,
  showClear = false,
  onClear,
  className,
}: MemoNavigationDropdownProps) {
  const { t } = useI18n();
  const activeFilter = useMemoStore((state) => state.activeFilter);
  const selectedNotebook = useMemoStore((state) => state.selectedNotebook);
  const selectedTagId = useTagStore((state) => state.selectedTagId);
  const setActiveFilter = useMemoStore((state) => state.setActiveFilter);
  const setSelectedTagId = useTagStore((state) => state.setSelectedTagId);
  const tags = useTagStore((state) => state.tags);
  const loadTags = useTagStore((state) => state.loadTags);
  const [internalOpen, setInternalOpen] = useState(false);
  const [openSubmenu, setOpenSubmenu] = useState<'tags' | null>(null);
  const selectedNotebookId = selectedNotebook?.id ?? null;
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

  const handleTagSelect = (tagId: string) => {
    setSelectedTagId(tagId);
    setActiveFilter('tagged');
  };

  const tagSubmenuItems = tags.map((tag) => ({ id: tag.id, label: tag.name }));
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
            className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] opacity-0 transition-opacity hover:bg-[var(--muted)] hover:text-[var(--foreground)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] group-hover:opacity-100"
            onClick={onClear}
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
        )}
      </div>
      <DropdownMenuContent align="start" side="bottom" className={MEMO_NAVIGATION_MENU_CLASS}>
        <DropdownMenuItem
          onClick={() => handleNavigate('all')}
          className={cn(
            MEMO_NAVIGATION_MENU_ITEM_CLASS,
            isActive('all') && 'hover:bg-[var(--brand)]',
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Layers className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t('memo.navigation.all')}</span>
          </span>
          {isActive('all') && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--brand)] group-hover:text-[var(--primary-foreground)]" aria-hidden="true" />}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleNavigate('todos')}
          className={cn(
            MEMO_NAVIGATION_MENU_ITEM_CLASS,
            isActive('todos') && 'hover:bg-[var(--brand)]',
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <ListTodo className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t('memo.list.filterTasks')}</span>
          </span>
          {isActive('todos') && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--brand)] group-hover:text-[var(--primary-foreground)]" aria-hidden="true" />}
        </DropdownMenuItem>
        <MemoNavigationSubmenu
          label={t('memo.navigation.tags')}
          icon={<Hash className="h-4 w-4 shrink-0" aria-hidden="true" />}
          itemIcon={<Hash className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />}
          itemKind="tag"
          valueAdornment={activeFilter === 'tagged' && selectedTagName ? (
            <span className="max-w-[100px] truncate text-xs text-[var(--muted-foreground)]">
              #{selectedTagName}
            </span>
          ) : undefined}
          open={openSubmenu === 'tags'}
          items={tagSubmenuItems}
          emptyText={t('memo.navigation.emptyTags')}
          loadingText={t('memo.navigation.loading')}
          onOpenChange={(open) => setOpenSubmenu((current) => {
            if (open) return 'tags';
            return current === 'tags' ? null : current;
          })}
          onCloseMenu={closeMenu}
          onSelect={handleTagSelect}
          onClick={() => handleNavigate('tags')}
        />
        {children && <div>{children}</div>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
