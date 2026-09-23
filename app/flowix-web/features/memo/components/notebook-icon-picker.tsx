'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  NotebookIcon,
  NOTEBOOK_ICON_OPTIONS,
} from '@features/memo/components/notebook-icon';

interface NotebookIconPickerProps {
  value: string | null;
  notebookName: string;
  onChange: (icon: string | null) => void;
  disabled?: boolean;
}

export function NotebookIconPicker({
  value,
  notebookName,
  onChange,
  disabled = false,
}: NotebookIconPickerProps) {
  const { t } = useI18n();
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [showBottomScrollHint, setShowBottomScrollHint] = useState(false);

  useEffect(() => {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return;

    setShowBottomScrollHint(
      scrollArea.scrollTop + scrollArea.clientHeight < scrollArea.scrollHeight - 1,
    );
  }, []);

  return (
    <div>
      <div className="flex items-center gap-1.5 pb-[0.35rem] pt-[0.35rem] text-sm font-semibold leading-[1.2] text-[var(--foreground)]">
        {t("notebook.iconLabel")}
      </div>
      <div className="relative">
        <div
          ref={scrollAreaRef}
          className="max-h-[146px] overflow-y-auto pr-1 [scrollbar-gutter:stable]"
          onScroll={(event) => {
            const scrollArea = event.currentTarget;
            setShowBottomScrollHint(
              scrollArea.scrollTop + scrollArea.clientHeight < scrollArea.scrollHeight - 1,
            );
          }}
        >
          <div className="grid grid-cols-7 gap-1.5">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(null)}
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-md border transition-colors',
                value === null
                  ? 'border-[var(--primary)] bg-[var(--accent)]'
                  : 'border-[var(--border)] hover:bg-[var(--muted)]',
                disabled && 'cursor-not-allowed opacity-60',
              )}
              aria-label={t("memo.notebook.letterIcon")}
              title={t("memo.notebook.letterIcon")}
            >
              <NotebookIcon
                name={notebookName}
                className="h-[26px] w-[26px] rounded-md bg-[var(--muted)] text-[15px] font-semibold text-[var(--secondary-foreground)]"
              />
            </button>
            {NOTEBOOK_ICON_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={disabled}
                onClick={() => onChange(option.id)}
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-md border transition-colors',
                  value === option.id
                    ? 'border-[var(--primary)] bg-[var(--accent)]'
                    : 'border-[var(--border)] hover:bg-[var(--muted)]',
                  disabled && 'cursor-not-allowed opacity-60',
                )}
                aria-label={option.label}
                title={option.label}
              >
                <NotebookIcon
                  icon={option.id}
                  className={cn(
                    'h-[26px] w-[26px] rounded-md bg-[var(--muted)]',
                    value === option.id
                      ? 'text-[var(--secondary-foreground)]'
                      : 'text-[var(--muted-foreground)]',
                  )}
                  imageClassName="h-[72%] w-[72%]"
                />
              </button>
            ))}
          </div>
        </div>
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-[var(--card)] via-[var(--card)]/80 to-transparent transition-opacity duration-150',
            showBottomScrollHint ? 'opacity-100' : 'opacity-0',
          )}
        />
      </div>
    </div>
  );
}
