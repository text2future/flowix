/**
 * Single-select value input for `Select` property rows. Reads its option
 * list from the row's preset (e.g. `type` → `[note, prompt]`); falls back
 * to a fixed empty list for free-key rows.
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@shared/ui/select';
import { useI18n } from '@features/i18n';
import { cn } from '@/lib/utils';

const OPTION_LABEL_KEYS = {
  note: 'document.properties.option.note',
  prompt: 'document.properties.option.prompt',
  todo: 'document.properties.option.todo',
  'in-progress': 'document.properties.option.inProgress',
  done: 'document.properties.option.done',
} as const;

interface SelectValueInputProps {
  value: string;
  options: readonly string[];
  disabled?: boolean;
  onChange: (next: string) => void;
}

export function SelectValueInput({
  value,
  options,
  disabled = false,
  onChange,
}: SelectValueInputProps) {
  const { t } = useI18n();
  const formatOptionLabel = (option: string) => {
    const knownKey = OPTION_LABEL_KEYS[option as keyof typeof OPTION_LABEL_KEYS];
    if (knownKey) return t(knownKey);
    return option;
  };

  return (
    <Select
      value={value}
      onValueChange={onChange}
      disabled={disabled}
    >
      <SelectTrigger
        className={cn(
          'h-8 rounded-lg',
          disabled && 'pointer-events-none opacity-50'
        )}
      >
        <SelectValue placeholder={t('document.properties.select.placeholder')} />
      </SelectTrigger>
      <SelectContent align="start" className="min-w-[160px]">
        {options.length === 0 ? (
          <div className="px-3 py-2 text-xs text-[var(--muted-foreground)]">
            {t('document.properties.select.empty')}
          </div>
        ) : (
          options.map((option) => (
            <SelectItem key={option} value={option}>
              {formatOptionLabel(option)}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}
