'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { OverlayScrollbar, type OverlayScrollbarHandle } from '@shared/ui/overlay-scrollbar';
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
  /** 提供时在面板下方渲染「清除」按钮区 (边框分隔 + 靠右, 样式同集合图标设置)。 */
  onClear?: () => void;
  /** 清除按钮文案 (与 onClear 成对提供)。 */
  clearLabel?: string;
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
  onClear,
  clearLabel,
  className,
}: PropertyIconPickerPanelProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onClearRef = useRef(onClear);
  onClearRef.current = onClear;
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
  const scrollbarRef = useRef<OverlayScrollbarHandle>(null);

  // 分类吸顶后用户常在滚动中途切换分类/包, 滚动位置必须归零,
  // 否则会落在新分类列表的中间 (新列表更短时还会被浏览器 clamp 出怪异状态)。
  useEffect(() => {
    scrollbarRef.current?.getScroller()?.scrollTo({ top: 0 });
  }, [pack, category]);

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
      if (!categoryButton) {
        // 清除按钮也走同一套原生事件委托 (WKWebView 下 React 合成 click 不可靠)。
        const clearButton = target.closest<HTMLButtonElement>('button[data-icon-clear]');
        if (!clearButton) return;
        if (clearButton.disabled) return;
        event.preventDefault();
        event.stopPropagation();
        onClearRef.current?.();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const next = categoryButton.dataset.iconCategory as PropertyIconCategoryId | undefined;
      if (next) setCategory(next);
    };
    root.addEventListener('click', handleClick);
    return () => root.removeEventListener('click', handleClick);
  }, [pack]);

  return (
    // 外层只做纵向排布并把清除按钮区纳入 rootRef 的事件委托范围;
    // 定高的 300px 区域只包 picker 本体, 清除区贴在其下 (无边距, 同集合图标设置)。
    <div ref={rootRef} className={cn('flex flex-col', className)}>
      <div className="flex h-[300px] flex-col gap-2">
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
        ref={scrollbarRef}
        observeContent
        /* 滚动条贴边: 宿主弹窗都是 p-2 (8px), 框架 -mx-2 拉到弹窗内缘,
         * 滚动区内容 px-2 补回, 视觉不动, 自绘滑块贴住弹窗右缘。 */
        className="min-h-0 flex-1 -mx-2"
        scrollerClassName="h-full px-2"
      >
        {packEntry && packEntry.categories.length > 1 && (
          <div
            role="tablist"
            aria-label={t('document.properties.icon.categories')}
            /* 分类条吸顶: sticky 于滚动容器顶部, 不透明底色盖住滚过的图标。
             * 刻意不设 z-index ── sticky 是定位元素, z-auto 就能盖过静态网格,
             * 同时画在自绘滑块 (z-2) / 轨道 (z-1) 之下, 不遮右缘滚动条
             * (同 overlay-scrollbar.css 里集合页吸顶条的结论)。 */
            className="sticky top-0 flex flex-wrap gap-1 bg-[var(--card)] pb-2"
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
        {/* 1fr 轨道比 40px 按钮宽（弹窗 280/300px），固定尺寸子项在 stretch 下
            会退化为起点对齐（贴格子左侧），必须显式居中。 */}
        <div className="grid grid-cols-5 justify-items-center gap-1">
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
      {onClear && (
        <div className="flex items-center justify-end border-t border-[var(--border)] pt-2">
          <button
            type="button"
            disabled={disabled}
            data-icon-clear=""
            className="rounded-md px-2 py-1 text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"
          >
            {clearLabel}
          </button>
        </div>
      )}
    </div>
  );
}
