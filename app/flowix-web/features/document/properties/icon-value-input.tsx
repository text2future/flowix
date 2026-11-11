import { useCallback, useEffect, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { useI18n } from '@/lib/i18n';
import { getPropertyIconOption } from '@features/document/properties/property-icons';
import { PropertyIconPickerPanel } from '@features/document/properties/icon-picker-panel';
import { cn } from '@/lib/utils';

interface IconValueInputProps {
  value: string;
  disabled?: boolean;
  variant?: 'default' | 'table';
  keepParentMenuOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onChange: (next: string) => void;
  /**
   * 自定义触发器：把宿主自身的元素（如侧栏列表项的笔记图标）当作弹窗触发按钮。
   * 提供时不再渲染默认的整宽按钮与清除入口，弹窗网格保持不变。
   * 传入的元素需自行转发 Radix 合并的 props（原生 button/span 即可）。
   */
  trigger?: ReactNode;
}

export function IconValueInput({
  value,
  disabled = false,
  variant = 'default',
  keepParentMenuOpen = false,
  onOpenChange,
  onChange,
  trigger,
}: IconValueInputProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const selected = getPropertyIconOption(value);
  const changeOpen = useCallback((nextOpen: boolean) => {
    if (disabled) return;
    setOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }, [disabled, onOpenChange]);
  useEffect(() => { if (disabled) { setOpen(false); onOpenChange?.(false); } }, [disabled, onOpenChange]);

  const clearValue = (event: MouseEvent) => {
    event.stopPropagation();
    if (disabled) return;
    onChange('');
  };

  return (
    <Popover open={disabled ? false : open} onOpenChange={changeOpen} cellPopup={variant === 'table'}>
      <PopoverTrigger asChild>
        {trigger ?? (
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'group flex h-8 w-full items-center gap-2 rounded-lg text-left text-sm transition-colors',
            variant === 'table'
              ? 'border-0 bg-transparent px-0 hover:bg-transparent focus-visible:border-0 data-[state=open]:border-0'
              : 'border border-input bg-background px-2.5 hover:bg-[var(--muted)]/40 focus-visible:border-[var(--primary)] data-[state=open]:border-[var(--primary)]',
            'focus-visible:outline-none',
            disabled && 'cursor-not-allowed disabled:opacity-50'
          )}
        >
          {selected ? (
            <img
              src={selected.src}
              alt=""
              className={cn('h-5 w-5 shrink-0 object-contain', variant === 'table' && 'multidimensional-table__icon-value')}
              draggable={false}
            />
          ) : (
            <span className={cn(
              'h-5 w-5 shrink-0 rounded-md border border-dashed',
              variant === 'table' ? 'multidimensional-table__icon-placeholder' : 'border-[var(--border)]',
            )} />
          )}
          {selected && !disabled && (
            <span
              role="button"
              tabIndex={-1}
              onClick={clearValue}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] opacity-0 transition-opacity hover:bg-[var(--muted)] hover:text-[var(--foreground)] group-hover:opacity-100 group-focus-visible:opacity-100"
              aria-label={t('document.properties.icon.clear')}
            >
              <X className="h-3.5 w-3.5" />
            </span>
          )}
        </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        keepParentMenuOpen={keepParentMenuOpen}
        className={cn('z-[150] w-[280px] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)] p-2', variant === 'table' && '!z-[170]')}
      >
        <PropertyIconPickerPanel
          value={value}
          disabled={disabled}
          onSelect={(next) => {
            onChange(next);
            changeOpen(false);
          }}
          onClear={() => {
            onChange('');
            changeOpen(false);
          }}
          clearLabel={t('document.properties.icon.clear')}
        />
      </PopoverContent>
    </Popover>
  );
}
