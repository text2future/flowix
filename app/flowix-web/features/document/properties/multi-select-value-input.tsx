/**
 * Array-value input shared by MultiSelect, Tag, and Note Tags rows.
 * With options it renders a preset-bound multi-select menu; without options
 * it renders free-form chips. The row's semantic type remains owned by the
 * property model, not by this reusable input component.
 */

import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useI18n, translate } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useComposingValue } from '@shared/hooks/use-composing-value';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@shared/ui/dropdown-menu';

interface MultiSelectValueInputProps {
  value: string;
  options?: readonly (string | { value: string; label: string })[];
  disabled?: boolean;
  variant?: 'default' | 'table';
  onChange: (next: string) => void;
}

function tagsFromValue(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function MultiSelectValueInput({
  value,
  options = [],
  disabled = false,
  variant = 'default',
  onChange,
}: MultiSelectValueInputProps) {
  const { t, language } = useI18n();
  const normalizedOptions = options.map((option) => typeof option === 'string'
    ? { value: option, label: option }
    : option);
  const tags = tagsFromValue(value);
  const [draft, setDraft] = useState('');
  const draftInput = useComposingValue(draft, setDraft);

  const commitDraft = () => {
    if (disabled) return;
    const nextTag = draft.trim();
    if (!nextTag) return;
    if (!tags.includes(nextTag)) {
      onChange([...tags, nextTag].join(', '));
    }
    setDraft('');
  };

  const removeTag = (tag: string) => {
    if (disabled) return;
    onChange(tags.filter((item) => item !== tag).join(', '));
  };

  const toggleOption = (option: string) => {
    if (disabled) return;
    const next = tags.includes(option)
      ? tags.filter((item) => item !== option)
      : [...tags, option];
    onChange(next.join(', '));
  };

  if (variant === 'table' || normalizedOptions.length > 0) {
    return (
      <DropdownMenu anchorToCell={variant === 'table'} disabled={disabled}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={cn(
              'flex h-8 w-full items-center justify-between gap-2 rounded-lg px-2 text-left text-sm',
              variant === 'table'
                ? 'multidimensional-table__select-trigger border-0 bg-transparent px-0 text-left shadow-none hover:bg-transparent focus-visible:border-0'
                : 'border border-input bg-background hover:bg-[var(--muted)]/40 focus-visible:border-[var(--primary)]',
              'focus-visible:outline-none',
              disabled && 'cursor-not-allowed opacity-50 disabled:cursor-not-allowed',
            )}
          >
            <span className="min-w-0 flex-1 truncate">
              {tags.length > 0
                ? tags.map((tag) => normalizedOptions.find((option) => option.value === tag)?.label ?? tag).join(', ')
                : variant === 'table' ? null : <span className="text-[var(--muted-foreground)]">{t('document.properties.select.placeholder')}</span>}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className={cn('min-w-[200px] rounded-xl border-[var(--border-popup)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]', variant === 'table' ? 'p-0.5' : 'p-1')}
        >
          {normalizedOptions.length === 0 ? (
            <div className="px-3 py-2 text-xs text-[var(--muted-foreground)]">
              {t('document.properties.select.empty')}
            </div>
          ) : normalizedOptions.map((option) => {
            const selected = tags.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => toggleOption(option.value)}
                className={cn(
                  'flex h-7 w-full items-center justify-between gap-2 rounded-lg px-2 text-left text-sm',
                  'hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)] focus-visible:outline-none',
                )}
              >
                <span className="min-w-0 truncate">{option.label}</span>
                {selected && <Check className="h-4 w-4 shrink-0 text-[var(--brand)]" aria-hidden="true" />}
              </button>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <div
      className={cn(
        'flex min-h-8 w-full flex-wrap items-center gap-1 rounded-lg px-2 py-1 text-sm',
        'border border-input bg-background focus-within:border-[var(--primary)]',
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      {tags.map((tag) => (
        <span
          key={tag}
          className={cn(
            'inline-flex h-5 items-center gap-1 rounded-md text-xs text-[var(--foreground)]',
            'bg-[var(--muted)] px-1.5',
          )}
        >
          {tag}
          {!disabled && (
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              aria-label={translate(language, 'document.properties.deleteTag', { tag })}
            >
              ×
            </button>
          )}
        </span>
      ))}
      <input
        value={draftInput.value}
        disabled={disabled}
        placeholder={tags.length === 0 ? t('document.properties.tagInputPlaceholder') : ''}
        onChange={draftInput.onChange}
        onCompositionStart={draftInput.onCompositionStart}
        onCompositionEnd={draftInput.onCompositionEnd}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (draftInput.isComposingKeyboardEvent(event.nativeEvent)) return;
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            commitDraft();
          }
          if (event.key === 'Backspace' && !draft && tags.length > 0) {
            onChange(tags.slice(0, -1).join(', '));
          }
        }}
        className={cn(
          'min-w-[88px] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed',
        )}
      />
    </div>
  );
}
