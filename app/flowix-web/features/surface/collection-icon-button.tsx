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
  /** 当前集合属性 `icon` 的值（属性图标 value），空 = 默认图标。 */
  value: string;
  /** 选中某个图标：写入集合属性 `icon`。 */
  onChange: (next: string) => void;
  /** 清除自定义图标（恢复默认）。 */
  onReset: () => void;
  changeLabel: string;
  resetLabel: string;
  hintLabel: string;
}

/**
 * 集合图标按钮：默认随头图走（头图可见时叠在头图下缘 = `banner` 变体，
 * 头图隐藏时退到标题行内 = `title` 变体）。两者共用同一套点击换图标交互：
 * 可编辑时点击打开属性图标 picker，写入集合属性 `icon`；不可编辑只展示。
 * 侧边栏和「全部」列表通过 CollectionResourceIcon 读取同一份集合属性。
 */
export function CollectionIconPickerButton({ defaultIcon, iconSrc, editable, value, onChange, onReset, changeLabel, resetLabel, hintLabel }: CollectionIconPickerButtonProps) {
  const [open, setOpen] = useState(false);
  // 两种位置共用头图图标的 chip 样式：尺寸、描边、圆角和内部图标均一致。
  const sizeClass = 'h-[45px] w-[45px] border border-[var(--border)]';
  const containerBase = cn(
    'collection-header-icon-tint flex shrink-0 items-center justify-center rounded-xl text-[var(--muted-foreground)]',
    sizeClass,
  );

  if (!editable) {
    return (
      <span className={containerBase}>
        <CollectionHeaderIcon defaultIcon={defaultIcon} iconSrc={iconSrc} />
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
          className={cn(containerBase, 'transition-colors hover:bg-[var(--muted)]/60')}
        >
          <CollectionHeaderIcon defaultIcon={defaultIcon} iconSrc={iconSrc} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" sideOffset={8} className="w-[300px] rounded-xl p-2">
        <PropertyIconPickerPanel
          value={value}
          onSelect={(next: string) => { onChange(next); setOpen(false); }}
        />
        <div className="mt-2 flex items-center justify-between border-t border-[var(--border)] pt-2">
          <span className="text-xs text-[var(--muted-foreground)]">{hintLabel}</span>
          <button
            type="button"
            onClick={() => { onReset(); setOpen(false); }}
            className="rounded-md px-2 py-1 text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"
          >
            {resetLabel}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
