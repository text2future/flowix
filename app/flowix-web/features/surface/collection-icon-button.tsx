'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Popover, PopoverTrigger, PopoverContent } from '@shared/ui/popover';
import { PropertyIconPickerPanel } from '@features/document/public/property-display-api';
import type { CollectionDefaultIcon } from '@features/collection/public/appearance-api';
import { CollectionHeaderIcon } from '@features/collection/public/title-api';

export interface CollectionIconPickerButtonProps {
  defaultIcon: CollectionDefaultIcon;
  /** 自定义集合图标（属性图标 URL）；指定时覆盖默认集合图标。 */
  iconSrc?: string;
  /** 集合可编辑才允许点击换图标；否则只展示（缺集合 / 只读）。 */
  editable: boolean;
  /** banner = 头图下缘（图标本体 h-12 w-12）；title = 标题行内（图标本体 h-10 w-10）。两者均无容器。 */
  placement: 'banner' | 'title';
  /** 当前集合属性 `icon` 的值（属性图标 value），空 = 默认图标。 */
  value: string;
  /** 选中某个图标：写入集合属性 `icon`。 */
  onChange: (next: string) => void;
  /** 清除自定义图标（恢复默认）。 */
  onReset: () => void;
  changeLabel: string;
  resetLabel: string;
}

/**
 * 集合图标按钮：默认随头图走（头图可见时叠在头图下缘 = `banner` 变体，
 * 头图隐藏时退到标题行内 = `title` 变体）。两者共用同一套点击换图标交互：
 * 可编辑时点击打开属性图标 picker，写入集合属性 `icon`；不可编辑只展示。
 * 侧边栏和「全部」列表通过 CollectionResourceIcon 读取同一份集合属性。
 */
export function CollectionIconPickerButton({ defaultIcon, iconSrc, editable, placement, value, onChange, onReset, changeLabel, resetLabel }: CollectionIconPickerButtonProps) {
  const [open, setOpen] = useState(false);
  // 两个位置都去掉容器（无 tint 底色 / 无外框 / 无圆角盒 / 无 hover 底色），
  // 图标本体直接展示，仅尺寸不同：banner h-12 w-12、title h-7 w-7。
  // title 靠下显得沉，整体向上偏移 2px 做光学对齐。
  const containerBase = cn(
    'flex shrink-0 items-center justify-center text-[var(--muted-foreground)]',
    placement === 'title' && '-translate-y-[2px]',
  );
  const iconClassName = placement === 'banner' ? 'h-12 w-12 object-contain' : 'h-7 w-7 object-contain';

  if (!editable) {
    return (
      <span className={containerBase}>
        <CollectionHeaderIcon defaultIcon={defaultIcon} iconSrc={iconSrc} iconClassName={iconClassName} />
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={changeLabel}
          title={changeLabel}
          className={containerBase}
        >
          <CollectionHeaderIcon defaultIcon={defaultIcon} iconSrc={iconSrc} iconClassName={iconClassName} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" sideOffset={8} className="w-[300px] rounded-xl p-2">
        <PropertyIconPickerPanel
          value={value}
          onSelect={(next: string) => { onChange(next); setOpen(false); }}
          onClear={() => { onReset(); setOpen(false); }}
          clearLabel={resetLabel}
        />
      </PopoverContent>
    </Popover>
  );
}
