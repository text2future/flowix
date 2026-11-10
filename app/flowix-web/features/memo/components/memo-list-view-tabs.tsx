'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Tooltip } from '@shared/ui/tooltip';
import documentFilledIcon from '@/assets/document-filled.svg?raw';
import documentOutlineIcon from '@/assets/document-outline.svg?raw';
import folderMinusFilledIcon from '@/assets/folder-minus-filled.svg?raw';
import folderMinusOutlineIcon from '@/assets/folder-minus-outline.svg?raw';

export type MemoListViewTab = 'cards' | 'folders' | 'conversations';

interface MemoListViewTabsProps {
  activeTab: MemoListViewTab;
  onChange: (tab: MemoListViewTab) => void;
}

type TabIconProps = {
  className?: string;
  /** fill=选中态（filled 变体），regular=非选中态（outline 变体）。 */
  weight: 'regular' | 'fill';
};

const TABS: ReadonlyArray<{
  value: MemoListViewTab;
  /** 完整文案：无障碍标签用；tab 内只展示图标。 */
  labelKey: I18nKey;
  /** hover tooltip 短文案（空间 / 笔记）。 */
  shortLabelKey: I18nKey;
  icon: (props: TabIconProps) => ReactNode;
  dimmed?: boolean;
}> = [
  {
    value: 'folders',
    labelKey: 'memo.list.viewFolders',
    shortLabelKey: 'memo.list.viewFoldersShort',
    icon: ({ className, weight }) => (
      <span className={cn(className, 'inline-flex items-center justify-center')}>
        <span
          className="block h-full w-full"
          dangerouslySetInnerHTML={{ __html: weight === 'fill' ? folderMinusFilledIcon : folderMinusOutlineIcon }}
        />
      </span>
    ),
  },
  {
    value: 'cards',
    labelKey: 'memo.list.viewCards',
    shortLabelKey: 'memo.list.viewCardsShort',
    icon: ({ className, weight }) => (
      <span className={cn(className, 'inline-flex items-center justify-center')}>
        <span
          className="block h-full w-full"
          dangerouslySetInnerHTML={{ __html: weight === 'fill' ? documentFilledIcon : documentOutlineIcon }}
        />
      </span>
    ),
  },
];

function TabIcon({
  icon,
  className,
  weight,
  dimmed = true,
}: {
  icon: (props: TabIconProps) => ReactNode;
  className?: string;
  weight: 'regular' | 'fill';
  dimmed?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'memo-list-view-tab-icon flex h-4 w-4 shrink-0 items-center justify-center',
        dimmed && 'opacity-50',
        className,
      )}
    >
      {icon({ className: 'h-full w-full', weight })}
    </span>
  );
}

export function MemoListViewTabs({
  activeTab,
  onChange,
}: MemoListViewTabsProps) {
  const { t } = useI18n();
  const [indicatorTab, setIndicatorTab] = useState<MemoListViewTab>(activeTab);
  // 指示条几何按目标 tab 实测：不能写死步进。
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef(new Map<MemoListViewTab, HTMLButtonElement>());

  useEffect(() => {
    if (indicatorTab === activeTab) return;
    const frame = window.requestAnimationFrame(() => {
      setIndicatorTab(activeTab);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, indicatorTab]);

  useLayoutEffect(() => {
    const measure = () => {
      const button = buttonRefs.current.get(indicatorTab);
      const container = containerRef.current;
      if (!container) return;
      // 把 tab 条总宽同步给同侧列表内容（.sidebar-list-content）：
      // 顶部的筛选/排序下拉按钮行要按这个宽度预留左边距，否则 tab 条
      // 变宽后会盖住下拉按钮。fallback 值对应纯图标 tab。
      container.closest<HTMLElement>('.sidebar-list-content')
        ?.style.setProperty('--memo-list-tabs-width', `${container.offsetWidth}px`);
      if (!button) return;
      setIndicator({ left: button.offsetLeft, width: button.offsetWidth });
    };
    measure();
    // 切语言 / 字体加载完成都会改变按钮宽度：观察按钮尺寸变化后重测。
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    buttonRefs.current.forEach((button) => observer.observe(button));
    const container = containerRef.current;
    if (container) observer.observe(container);
    return () => observer.disconnect();
  }, [indicatorTab]);

  const handleChange = (tab: MemoListViewTab) => {
    onChange(tab);
  };

  return (
    <div
      ref={containerRef}
      data-memo-list-view-tabs
      role="tablist"
      aria-label={t('memo.navigation.menuTitle')}
      className="relative flex h-[32px] shrink-0 items-center gap-0 rounded-xl border border-[var(--border)] bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] px-[1px]"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 h-7 -translate-y-1/2 rounded-[10px] border border-[var(--border)] bg-[var(--card)] shadow-sm transition-[left,width] duration-200 ease-out"
        style={{
          left: indicator?.left ?? 0,
          width: indicator?.width ?? 0,
          opacity: indicator ? 1 : 0,
        }}
      />
      {TABS.map(({ value, labelKey, shortLabelKey, icon: IconComponent, dimmed }) => {
        const active = activeTab === value;
        const label = t(labelKey);
        return (
          <Tooltip
            key={value}
            content={t(shortLabelKey)}
            side="bottom"
            align="start"
            sideOffset={4}
          >
            <button
              type="button"
              role="tab"
              ref={(node) => {
                if (node) buttonRefs.current.set(value, node);
                else buttonRefs.current.delete(value);
              }}
              data-memo-list-view-tab={value}
              aria-selected={active}
              aria-label={label}
              onPointerDown={(event) => {
                // Leaving an edited BrowserColumn synchronously blurs and
                // serializes its editor during the ancestor pointerdown. Run
                // the tab intent before that focus transition can rerender the
                // trigger and swallow the later click event.
                if (event.isPrimary === false || event.button !== 0) return;
                handleChange(value);
              }}
              onClick={(event) => {
                // Pointer activation already ran on pointerdown. A detail of 0
                // is the keyboard/assistive-technology click path.
                if (event.detail === 0) handleChange(value);
              }}
              className={cn(
                // item 圆角 10px；容器为 rounded-xl(12px)。
                'group relative z-[1] flex h-7 shrink-0 items-center rounded-[10px] px-1.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]',
                active
                  ? 'text-[var(--foreground)]'
                  : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]',
              )}
            >
              <TabIcon icon={IconComponent} weight={active ? 'fill' : 'regular'} dimmed={active ? false : dimmed} className={active ? 'opacity-90' : undefined} />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
