/**
 * Single-select value input for `Select` property rows. Supports plain
 * string options and value/label pairs used by table fields.
 */

import { useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@shared/ui/select';
import { useI18n } from '@/lib/i18n';
import { stableTextHue } from '@/lib/color';
import { cn } from '@/lib/utils';
import { usePropertyValueTypography } from './value-typography';

interface SelectValueInputProps {
  value: string;
  options: readonly (string | { value: string; label: string })[];
  disabled?: boolean;
  variant?: 'default' | 'table';
  placeholder?: string;
  outlined?: boolean;
  keepParentMenuOpen?: boolean;
  onChange: (next: string) => void;
  onCreateOption?: (label: string) => Promise<string | null>;
}

export function SelectValueInput({
  value,
  options,
  disabled = false,
  variant = 'default',
  placeholder,
  outlined = false,
  keepParentMenuOpen = false,
  onChange,
  onCreateOption,
}: SelectValueInputProps) {
  const { t } = useI18n();
  const typography = usePropertyValueTypography();
  const normalizedOptions = options.map((option) => typeof option === 'string'
    ? { value: option, label: option }
    : option);
  const selectedOption = normalizedOptions.find((option) => option.value === value);
  const selectedLabel = selectedOption?.label ?? value;
  const [draft, setDraft] = useState('');
  return (
    <Select
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      anchorToCell={variant === 'table'}
    >
      <SelectTrigger
        className={cn(
          'h-8 gap-2 rounded-lg',
          variant === 'table' && (outlined
            ? 'multidimensional-table__select-trigger border border-[var(--border)] bg-transparent px-2 text-left shadow-none hover:bg-[var(--hover-bg)] focus:border-[var(--primary)]'
            : 'multidimensional-table__select-trigger border-0 bg-transparent px-0 text-left shadow-none hover:bg-transparent focus:border-0'),
          disabled && 'cursor-not-allowed disabled:opacity-50 disabled:cursor-not-allowed'
        )}
      >
        <SelectValue placeholder={placeholder ?? (variant === 'table' ? '' : t('document.properties.select.placeholder'))}>
          {variant === 'table'
            ? selectedLabel
              ? <span
                className="multidimensional-table__option-chip min-w-0 max-w-full truncate"
                title={selectedLabel}
                style={{ ...typography, '--multidimensional-table-option-hue': stableTextHue(selectedLabel) } as React.CSSProperties}
              >{selectedLabel}</span>
              : null
            : selectedOption?.label}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        align="start"
        style={typography}
        keepParentMenuOpen={keepParentMenuOpen}
        className={cn('min-w-[160px] space-y-0.5 border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]', variant === 'table' ? 'multidimensional-table__field-options-popover !z-[170]' : 'rounded-xl')}
        matchAnchorWidth={variant === 'table' ? 2 : false}
        autoFocusInput={variant === 'table'}
        closeOnEnter={variant === 'table'}
      >
        {variant === 'table' && <div className="-mx-1 -mt-1 flex min-w-0 items-center gap-1 border-b border-[var(--border)] px-1 py-1" style={{ backgroundColor: 'color-mix(in srgb, var(--muted) 50%, transparent)' }}>
          {selectedLabel && <span
            className="multidimensional-table__option-chip inline-flex max-w-full shrink-0 items-center gap-1 truncate"
            title={selectedLabel}
            style={{ ...typography, '--multidimensional-table-option-hue': stableTextHue(selectedLabel) } as React.CSSProperties}
          >
            <span className="min-w-0 truncate">{selectedLabel}</span>
            <button
              type="button"
              aria-label={`删除选项 ${selectedLabel}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onChange('')}
              className="shrink-0 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >×</button>
          </span>}
          <input
            autoFocus
            ref={(element) => element?.focus({ preventScroll: true })}
            value={draft}
            placeholder="添加选项"
            aria-label="输入或添加选项"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Backspace' && !draft && selectedLabel) {
                event.preventDefault();
                onChange('');
                return;
              }
              if (event.key !== 'Enter') return;
              event.preventDefault();
              event.stopPropagation();
              if (draft.trim()) {
                const label = draft.trim();
                if (onCreateOption) {
                  void onCreateOption(label).then((id) => { if (id) onChange(id); });
                } else {
                  onChange(label);
                }
                setDraft('');
              }
            }}
            className="h-7 min-w-0 flex-1 rounded-md border-0 bg-transparent px-1 text-sm outline-none multidimensional-table__option-input placeholder:text-[var(--muted-foreground)] placeholder:opacity-85 focus:placeholder:opacity-60"
          />
        </div>}
        {normalizedOptions.length === 0 ? (
          <div className="px-3 py-2 text-xs text-[var(--muted-foreground)]">
            {t('document.properties.select.empty')}
          </div>
        ) : (
          normalizedOptions.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              className="h-8 !min-h-8 rounded-lg px-1 py-0 text-left hover:bg-[var(--hover-bg)]"
            >
              <span
                className="multidimensional-table__option-chip max-w-full truncate"
                style={{ '--multidimensional-table-option-hue': stableTextHue(option.label) } as React.CSSProperties}
              >
                {option.label}
              </span>
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}
