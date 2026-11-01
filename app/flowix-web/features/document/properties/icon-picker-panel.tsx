'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import {
  PROPERTY_ICON_CATEGORY_LABEL_KEY,
  PROPERTY_ICON_PACK_LABEL_KEY,
} from '@features/document/properties/icon-category-labels';
import {
  PROPERTY_ICON_PACKS,
  getDefaultPropertyIconCategory,
  getDefaultPropertyIconPack,
  getPropertyIconCategoryOptions,
  getPropertyIconOption,
  type PropertyIconCategoryId,
  type PropertyIconPackId,
} from '@features/document/properties/property-icons';

interface PropertyIconPickerPanelProps {
  /** 当前图标值 (空串表示未设置)。 */
  value: string;
  disabled?: boolean;
  /** 选中某个图标。 */
  onSelect: (next: string) => void;
  className?: string;
}

/**
 * 图标 picker 的弹层内容: 图标包切换 + 滚动区 (锚点式分类标签 + 当前分类网格)。
 *
 * ── 布局 ──
 * 弹窗整体定高, 包条固定在顶部; 分类标签放在滚动区内部 (随内容滚动, 可换行),
 * 差额全部由网格吃掉, 切包/切分类不改变弹窗大小。
 *
 * ── 为什么只渲染当前分类 ──
 * 图标总量上千, 一次挂 1000+ 个 <img> 会让弹层首次打开明显卡顿; 分类来自
 * 目录结构 (见 property-icons.ts), 单个分类最多约 260 个。只有一个分类的包
 * (mochi) 不渲染分类标签。
 *
 * ── 滚动条 ──
 * 走共享 OverlayScrollbar: 自绘滑块不占布局宽度, 默认隐藏, 滚动时淡入。
 *
 * ── 为什么用原生事件委托而不是 React onClick ──
 * 文件树的 picker 宿主在 WKWebView 里会出现 React 合成 click 不触发的情况
 * (树行的 setPointerCapture 会重定向 click, 详见 tree-icon-picker.tsx)。
 * 这里统一走 addEventListener + 事件委托, 两种宿主表现一致。
 */
export function PropertyIconPickerPanel({
  value,
  disabled = false,
  onSelect,
  className,
}: PropertyIconPickerPanelProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const selected = getPropertyIconOption(value);
  const [pack, setPack] = useState<PropertyIconPackId>(
    () => selected?.pack ?? getDefaultPropertyIconPack(),
  );
  const [category, setCategory] = useState<PropertyIconCategoryId>(
    () => selected?.category ?? getDefaultPropertyIconCategory(),
  );
  const packEntry = PROPERTY_ICON_PACKS.find((entry) => entry.id === pack)
    ?? PROPERTY_ICON_PACKS[0];
  const options = getPropertyIconCategoryOptions(pack, category);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const optionButton = target.closest<HTMLButtonElement>('button[data-icon-option]');
      if (optionButton) {
        if (optionButton.disabled) return;
        event.preventDefault();
        event.stopPropagation();
        onSelectRef.current(optionButton.dataset.iconOption ?? '');
        return;
      }
      const packButton = target.closest<HTMLButtonElement>('button[data-icon-pack]');
      if (packButton) {
        event.preventDefault();
        event.stopPropagation();
        const next = packButton.dataset.iconPack as PropertyIconPackId | undefined;
        if (!next || next === pack) return;
        setPack(next);
        setCategory(getDefaultPropertyIconCategory(next));
        return;
      }
      const categoryButton = target.closest<HTMLButtonElement>('button[data-icon-category]');
      if (!categoryButton) return;
      event.preventDefault();
      event.stopPropagation();
      const next = categoryButton.dataset.iconCategory as PropertyIconCategoryId | undefined;
      if (next) setCategory(next);
    };
    root.addEventListener('click', handleClick);
    return () => root.removeEventListener('click', handleClick);
  }, [pack]);

  return (
    <div ref={rootRef} className={cn('flex h-[300px] flex-col gap-2', className)}>
      {PROPERTY_ICON_PACKS.length > 1 && (
        <div
          role="tablist"
          aria-label={t('document.properties.icon.categories')}
          className="flex shrink-0 gap-1"
        >
          {PROPERTY_ICON_PACKS.map((entry) => {
            const active = entry.id === pack;
            const label = t(PROPERTY_ICON_PACK_LABEL_KEY[entry.id]);
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={active}
                data-icon-pack={entry.id}
                className={cn(
                  'shrink-0 rounded-md px-2 py-1 text-xs font-semibold leading-none transition-colors',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-[var(--hover-bg)] hover:text-foreground',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      <OverlayScrollbar
        observeContent
        className="min-h-0 flex-1"
        scrollerClassName="h-full"
      >
        {packEntry && packEntry.categories.length > 1 && (
          <div
            role="tablist"
            aria-label={t('document.properties.icon.categories')}
            className="flex flex-wrap gap-1 pb-2"
          >
            {packEntry.categories.map((entry) => {
              const active = entry.id === category;
              const label = t(PROPERTY_ICON_CATEGORY_LABEL_KEY[entry.id]);
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-icon-category={entry.id}
                  className={cn(
                    'rounded px-1.5 py-0.5 text-xs transition-colors',
                    active
                      ? 'font-medium text-[var(--primary)]'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
        <div className="grid grid-cols-5 gap-1">
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                data-icon-option={option.value}
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-lg border transition-colors',
                  active
                    ? 'border-[var(--primary)] bg-[color-mix(in_oklch,var(--primary)_10%,transparent)]'
                    : 'border-transparent hover:border-[var(--border)] hover:bg-[var(--muted)]/60',
                )}
                title={option.label}
                aria-label={option.label}
              >
                <img
                  src={option.src}
                  alt=""
                  className="h-6 w-6 object-contain"
                  draggable={false}
                />
              </button>
            );
          })}
        </div>
      </OverlayScrollbar>
    </div>
  );
}
