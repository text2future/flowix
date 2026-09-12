'use client';

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ChatTeardropTextIcon, NoteIcon, type Icon } from '@phosphor-icons/react';
import { Tooltip } from '@shared/ui/tooltip';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type MemoListViewTab = 'conversations' | 'notes';

// MemoList and AgentConversationList are mutually exclusive views, so the
// tab component is remounted during a view switch. Keep the previous position
// between those mounts so the selected background can still animate across it.
let lastRenderedTab: MemoListViewTab | null = null;

interface MemoListViewTabsProps {
  activeTab: MemoListViewTab;
  onChange: (tab: MemoListViewTab) => void;
  /** The notes tab doubles as the entry point for the note navigation drawer. */
  navigationDrawerEnabled?: boolean;
  navigationDrawerOpen?: boolean;
  onToggleNavigationDrawer?: () => void;
}

const TABS: ReadonlyArray<{
  value: MemoListViewTab;
  labelKey: I18nKey;
  icon: Icon;
}> = [
  {
    value: 'notes',
    labelKey: 'memo.navigation.allNotes',
    icon: NoteIcon,
  },
  {
    value: 'conversations',
    labelKey: 'memo.navigation.conversations',
    icon: ChatTeardropTextIcon,
  },
];

function TabIcon({
  icon: IconComponent,
  className,
  weight,
}: {
  icon: Icon;
  className?: string;
  weight: 'regular' | 'fill';
}) {
  return (
    <IconComponent
      aria-hidden="true"
      className={cn('memo-list-view-tab-icon h-4 w-4 opacity-50', className)}
      size={16}
      weight={weight}
    />
  );
}

export function MemoListViewTabs({
  activeTab,
  onChange,
  navigationDrawerEnabled = false,
  navigationDrawerOpen = false,
  onToggleNavigationDrawer,
}: MemoListViewTabsProps) {
  const { t } = useI18n();
  const [indicatorTab, setIndicatorTab] = useState<MemoListViewTab>(
    () => lastRenderedTab ?? activeTab,
  );

  useEffect(() => {
    if (indicatorTab === activeTab) {
      lastRenderedTab = activeTab;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      setIndicatorTab(activeTab);
      lastRenderedTab = activeTab;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, indicatorTab]);

  const handleChange = (tab: MemoListViewTab) => {
    lastRenderedTab = activeTab;
    onChange(tab);
  };

  return (
    <div
      data-memo-list-view-tabs
      role="tablist"
      aria-label={t('memo.navigation.menuTitle')}
      className="relative flex h-[30px] shrink-0 items-center gap-0.5 rounded-xl border border-[var(--border)] bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] p-0.5"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-0.5 top-1/2 h-6 w-6 -translate-y-1/2 rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-sm transition-transform duration-200 ease-out"
        style={{
          transform: indicatorTab === 'conversations'
            ? 'translateX(26px) translateY(-50%)'
            : 'translateX(0) translateY(-50%)',
        }}
      />
      {TABS.map(({ value, labelKey, icon: IconComponent }) => {
        const active = activeTab === value;
        const label = t(labelKey);
        const opensNavigation =
          value === 'notes' &&
          active &&
          navigationDrawerEnabled &&
          Boolean(onToggleNavigationDrawer);
        const buttonLabel = opensNavigation
          ? navigationDrawerOpen
            ? t('memo.navigation.closeDrawer')
            : t('memo.navigation.menuTitle')
          : label;
        const activate = () => {
          if (opensNavigation) {
            onToggleNavigationDrawer?.();
            return;
          }
          handleChange(value);
        };
        return (
          <Tooltip key={value} content={buttonLabel} side="bottom" sideOffset={4}>
            <button
              type="button"
              role="tab"
              data-memo-list-view-tab={value}
              aria-selected={active}
              aria-label={buttonLabel}
              aria-expanded={opensNavigation ? navigationDrawerOpen : undefined}
              title={buttonLabel}
              onPointerDown={(event) => {
                // Leaving an edited BrowserColumn synchronously blurs and
                // serializes its editor during the ancestor pointerdown. Run
                // the tab intent before that focus transition can rerender the
                // trigger and swallow the later click event.
                if (event.isPrimary === false || event.button !== 0) return;
                activate();
              }}
              onClick={(event) => {
                // Pointer activation already ran on pointerdown. A detail of 0
                // is the keyboard/assistive-technology click path.
                if (event.detail === 0) activate();
              }}
              className={cn(
                'group relative z-[1] flex h-6 w-6 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]',
                active
                  ? 'text-[var(--primary)]'
                  : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]',
              )}
            >
              {opensNavigation ? (
                <span className="relative block h-4 w-4" aria-hidden="true">
                  {navigationDrawerOpen ? (
                    <ChevronLeft
                      className="absolute inset-0 h-4 w-4"
                      strokeWidth={2.5}
                    />
                  ) : (
                    <>
                      <TabIcon
                        icon={IconComponent}
                        weight={active ? 'fill' : 'regular'}
                        className="absolute inset-0 transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0"
                      />
                      <ChevronRight
                        className="absolute inset-0 h-4 w-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
                        strokeWidth={2.5}
                      />
                    </>
                  )}
                </span>
              ) : (
                <TabIcon icon={IconComponent} weight={active ? 'fill' : 'regular'} />
              )}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
