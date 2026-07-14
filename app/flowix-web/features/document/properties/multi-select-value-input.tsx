/**
 * Multi-select value input. Stores its value as a YAML array on disk —
 * functionally identical to the legacy `Tags` row type (which is why
 * they round-trip through the same `convertRowValue` path), but
 * explicitly typed as `MultiSelect` so the dialog UI distinguishes
 * "tag chips" from "preset-bound keyword list" cleanly.
 */

import { useState } from 'react';
import { useI18n, translate } from '@features/i18n';
import { cn } from '@/lib/utils';

interface MultiSelectValueInputProps {
  value: string;
  disabled?: boolean;
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
  disabled = false,
  onChange,
}: MultiSelectValueInputProps) {
  const { t, language } = useI18n();
  const tags = tagsFromValue(value);
  const [draft, setDraft] = useState('');

  const commitDraft = () => {
    const nextTag = draft.trim();
    if (!nextTag) return;
    if (!tags.includes(nextTag)) {
      onChange([...tags, nextTag].join(', '));
    }
    setDraft('');
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((item) => item !== tag).join(', '));
  };

  return (
    <div
      className={cn(
        'flex min-h-8 w-full flex-wrap items-center gap-1 rounded-lg border border-input bg-background px-2 py-1 text-sm focus-within:border-[var(--primary)]',
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex h-5 items-center gap-1 rounded-md bg-[var(--muted)] px-1.5 text-xs text-[var(--foreground)]"
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
        value={draft}
        disabled={disabled}
        placeholder={tags.length === 0 ? t('document.properties.tagInputPlaceholder') : ''}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            commitDraft();
          }
          if (event.key === 'Backspace' && !draft && tags.length > 0) {
            onChange(tags.slice(0, -1).join(', '));
          }
        }}
        className="min-w-[88px] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
      />
    </div>
  );
}