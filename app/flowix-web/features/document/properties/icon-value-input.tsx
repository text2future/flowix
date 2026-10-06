import { useEffect, useState } from 'react';
import type { MouseEvent } from 'react';
import { X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { useI18n } from '@/lib/i18n';
import {
  PROPERTY_ICON_OPTIONS,
  getPropertyIconOption,
} from '@features/document/properties/property-icons';
import { cn } from '@/lib/utils';

interface IconValueInputProps {
  value: string;
  disabled?: boolean;
  variant?: 'default' | 'table';
  onChange: (next: string) => void;
}

export function IconValueInput({
  value,
  disabled = false,
  variant = 'default',
  onChange,
}: IconValueInputProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const selected = getPropertyIconOption(value);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const clearValue = (event: MouseEvent) => {
    event.stopPropagation();
    if (disabled) return;
    onChange('');
  };

  return (
    <Popover open={disabled ? false : open} onOpenChange={(nextOpen) => { if (!disabled) setOpen(nextOpen); }} cellPopup={variant === 'table'}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'group flex h-8 w-full items-center gap-2 rounded-lg text-left text-sm transition-colors',
            variant === 'table'
              ? 'border-0 bg-transparent px-0 hover:bg-transparent focus-visible:border-0 data-[state=open]:border-0'
              : 'border border-input bg-background px-2.5 hover:bg-[var(--muted)]/40 focus-visible:border-[var(--primary)] data-[state=open]:border-[var(--primary)]',
            'focus-visible:outline-none',
            disabled && 'cursor-not-allowed opacity-50'
          )}
        >
          {selected ? (
            <img
              src={selected.src}
              alt=""
              className="h-5 w-5 shrink-0 object-contain"
              draggable={false}
            />
          ) : (
            <span className="h-5 w-5 shrink-0 rounded-md border border-dashed border-[var(--border)]" />
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
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className={cn('z-[150] w-[280px] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]', variant === 'table' ? 'p-1' : 'p-2')}
      >
        <div className="max-h-[240px] overflow-y-auto [scrollbar-gutter:stable]">
          <div className="grid grid-cols-5 gap-1">
          {PROPERTY_ICON_OPTIONS.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  onChange(option.value);
                  setOpen(false);
                }}
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-lg border transition-colors',
                  active
                    ? 'border-[var(--primary)] bg-[color-mix(in_oklch,var(--primary)_10%,transparent)]'
                    : 'border-transparent hover:border-[var(--border)] hover:bg-[var(--muted)]/60'
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
        </div>
      </PopoverContent>
    </Popover>
  );
}
