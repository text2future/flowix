'use client';

import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { cn } from '@/lib/utils';
import {
  NotebookIcon,
  NOTEBOOK_ICON_OPTIONS,
  resolveNotebookIconOption,
} from '@features/memo/components/notebook-icon';

interface NotebookIconPopoverProps {
  value: string | null;
  onChange: (icon: string | null) => void;
  disabled?: boolean;
  variant?: 'standalone' | 'inline';
}

export function NotebookIconPopover({
  value,
  onChange,
  disabled = false,
  variant = 'standalone',
}: NotebookIconPopoverProps) {
  const [open, setOpen] = useState(false);
  const selected = resolveNotebookIconOption(value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            variant === 'inline'
              ? 'flex h-8 w-8 items-center justify-center rounded-md border-0 bg-transparent p-0 transition-colors hover:bg-[var(--muted)]/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--primary)] data-[state=open]:bg-[var(--muted)]/40'
              : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-input bg-[var(--card)] transition-colors hover:bg-[var(--muted)]/40 focus-visible:border-[var(--primary)] focus-visible:outline-none data-[state=open]:border-[var(--primary)]',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
          aria-label="设置笔记本图标"
          title={selected.label}
        >
          <NotebookIcon
            icon={selected.id}
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
        <OverlayScrollbar
          className="max-h-[240px]"
          scrollerClassName="max-h-[240px] overflow-y-auto overflow-x-hidden pr-1"
        >
          <div className="grid grid-cols-6 gap-1">
            {NOTEBOOK_ICON_OPTIONS.map((option) => {
              const active = option.id === selected.id;
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
        </OverlayScrollbar>
      </PopoverContent>
    </Popover>
  );
}
