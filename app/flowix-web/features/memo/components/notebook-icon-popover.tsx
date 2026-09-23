'use client';

import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { cn } from '@/lib/utils';
import {
  getNotebookIconOption,
  NotebookIcon,
  NOTEBOOK_ICON_OPTIONS,
} from '@features/memo/components/notebook-icon';

interface NotebookIconPopoverProps {
  value: string | null;
  notebookName: string;
  onChange: (icon: string | null) => void;
}

export function NotebookIconPopover({
  value,
  notebookName,
  onChange,
}: NotebookIconPopoverProps) {
  const [open, setOpen] = useState(false);
  const selected = getNotebookIconOption(value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-input bg-background transition-colors',
            'hover:bg-[var(--muted)]/40 focus-visible:border-[var(--primary)] focus-visible:outline-none',
            'data-[state=open]:border-[var(--primary)]',
          )}
          aria-label="设置笔记本图标"
          title={selected?.label ?? '设置笔记本图标'}
        >
          <NotebookIcon
            icon={selected?.id}
            name={notebookName}
            className="h-7 w-7 rounded-md bg-[var(--muted)] text-sm font-semibold text-[var(--secondary-foreground)]"
            imageClassName="h-[72%] w-[72%]"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="z-[230] w-[280px] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-2 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
      >
        <div className="max-h-[240px] overflow-y-auto [scrollbar-gutter:stable]">
          <div className="grid grid-cols-6 gap-1">
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-lg border transition-colors',
                value === null
                  ? 'border-[var(--primary)] bg-[color-mix(in_oklch,var(--primary)_10%,transparent)]'
                  : 'border-transparent hover:border-[var(--border)] hover:bg-[var(--muted)]/60',
              )}
              title="使用名称首字母"
              aria-label="使用名称首字母"
            >
              <NotebookIcon
                name={notebookName}
                className="h-6 w-6 rounded-md bg-[var(--muted)] text-sm font-semibold text-[var(--secondary-foreground)]"
              />
            </button>
            {NOTEBOOK_ICON_OPTIONS.map((option) => {
              const active = option.id === value;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-lg border transition-colors',
                    active
                      ? 'border-[var(--primary)] bg-[color-mix(in_oklch,var(--primary)_10%,transparent)]'
                      : 'border-transparent hover:border-[var(--border)] hover:bg-[var(--muted)]/60',
                  )}
                  title={option.label}
                  aria-label={option.label}
                >
                  <NotebookIcon
                    icon={option.id}
                    className="h-6 w-6 rounded-md bg-[var(--muted)] text-[var(--muted-foreground)]"
                    imageClassName="h-[72%] w-[72%]"
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
