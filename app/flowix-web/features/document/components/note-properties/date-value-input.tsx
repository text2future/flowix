import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { translate, useI18n, type AppLanguage } from '@/lib/i18n';
import { useAppLanguage } from '@features/preferences/public/runtime-api';
import { cn } from '@/lib/utils';

function getWeekdayKeys(): Array<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'> {
  return ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
}

function parseDateValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function formatDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getMonthDays(viewMonth: Date): Array<{ date: Date; inMonth: boolean }> {
  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const firstDay = new Date(year, month, 1);
  const firstWeekday = (firstDay.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - firstWeekday);

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return { date, inMonth: date.getMonth() === month };
  });
}

function getMonthTitle(language: AppLanguage, date: Date): string {
  return translate(language, 'document.properties.monthTitle', {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
  });
}


export function DateValueInput({
  value,
  disabled,
  variant = 'default',
  onChange,
}: {
  value: string;
  disabled?: boolean;
  variant?: 'default' | 'table';
  onChange: (value: string) => void;
}) {
  const { t, language } = useI18n();
  const settingsLanguage = useAppLanguage();
  // 同步当前 user settings 语言; 跟 i18n provider 同源 ── 即便 Provider
  // 因为 react 批处理有微小延迟, 这里也能拿到最新值。
  const effectiveLanguage = (settingsLanguage ?? language) as AppLanguage;
  const [open, setOpen] = useState(false);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const selectedDate = parseDateValue(value);
  const [viewMonth, setViewMonth] = useState(() => selectedDate ?? new Date());

  useEffect(() => {
    if (selectedDate) {
      setViewMonth(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
    }
  }, [selectedDate?.getFullYear(), selectedDate?.getMonth()]);

  const monthDays = useMemo(() => getMonthDays(viewMonth), [viewMonth]);

  // 周列标签: zh-CN "一/二/..."; en-US "Mon/Tue/..."。优先用 i18n key 走
  // locales.ts; 静态 hook 之外用 translate(language, ...)。
  const weekdayLabels = useMemo(() => {
    const keys = getWeekdayKeys();
    return keys.map((key) => translate(effectiveLanguage, `document.properties.weekdays.${key}` as const));
  }, [effectiveLanguage]);

  const changeMonth = (offset: number) => {
    setViewMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  };

  const selectDate = (date: Date) => {
    onChange(formatDateValue(date));
    setOpen(false);
  };

  const clearDate = (event: MouseEvent) => {
    event.stopPropagation();
    onChange('');
    setOpen(false);
  };

  return (
    <Popover open={disabled ? false : open} onOpenChange={disabled ? undefined : setOpen} cellPopup={variant === 'table'}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'frontmatter-property__date-picker-trigger group flex h-8 w-full items-center gap-0 rounded-lg border-0 bg-transparent px-0 text-left text-sm transition-colors',
            'hover:bg-transparent focus-visible:outline-none focus-visible:ring-0',
            disabled && 'cursor-not-allowed opacity-50'
          )}
        >
          <span className={cn(
            'min-w-0 flex-1 truncate',
            value ? 'text-[var(--foreground)]' : 'text-[var(--muted-foreground)]',
            !value && variant === 'table' && 'opacity-80',
          )}>
            {value || t('document.properties.selectDate')}
          </span>
          {value && !disabled && (
            <span
              role="button"
              tabIndex={-1}
              onClick={clearDate}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] opacity-0 transition-opacity hover:bg-[var(--muted)] hover:text-[var(--foreground)] group-hover:opacity-100 group-focus-visible:opacity-100"
              aria-label={t('document.properties.clearDate')}
            >
              <X className="h-3.5 w-3.5" />
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className={cn('frontmatter-property__date-picker-popover w-[272px] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]', variant === 'table' ? 'p-1' : 'p-2')}
      >
        <div className="rounded-lg bg-[var(--card)]">
          <div className="mb-2 flex items-center justify-between px-1">
            <button
              type="button"
              onClick={() => changeMonth(-1)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
              aria-label={t('document.properties.prevMonth')}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="text-sm font-medium text-[var(--foreground)]">
              {getMonthTitle(effectiveLanguage, viewMonth)}
            </div>
            <button
              type="button"
              onClick={() => changeMonth(1)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
              aria-label={t('document.properties.nextMonth')}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 px-1 pb-1 text-center text-[11px] font-medium text-[var(--muted-foreground)]">
            {weekdayLabels.map((label) => (
              <div key={label} className="flex h-6 items-center justify-center">
                {label}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {monthDays.map(({ date, inMonth }) => {
              const dateValue = formatDateValue(date);
              const isSelected = value === dateValue;
              const isToday = dateValue === formatDateValue(new Date());

              return (
                <button
                  key={dateValue}
                  type="button"
                  data-date={dateValue}
                  onClick={() => selectDate(date)}
                  className={cn(
                    'flex h-8 items-center justify-center rounded-md text-sm transition-colors',
                    inMonth ? 'text-[var(--foreground)]' : 'text-[var(--muted-foreground)] opacity-45',
                    'hover:bg-[var(--muted)] hover:text-[var(--foreground)]',
                    isToday && !isSelected && 'ring-1 ring-inset ring-[var(--border)]',
                    isSelected && 'bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary)] hover:text-[var(--primary-foreground)]'
                  )}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
