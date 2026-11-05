'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { CenteredLoadingSpinner } from '@shared/ui/centered-loading-spinner';

/** Shared flexible viewport used by list surfaces in the middle column. */
export function ListSurfaceViewport({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      {children}
    </div>
  );
}

/** Initial-load state shared by notes, trees, and conversation lists. */
export function ListSurfaceLoadingState({
  label,
  ariaLabel,
  className,
}: {
  label?: string;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <CenteredLoadingSpinner
      className={cn('h-full w-full', className)}
      ariaLabel={ariaLabel ?? label}
      label={label}
    />
  );
}

/** Compact ring spinner using the editor loading indicator's visual treatment. */
export function ListSurfaceSpinner({
  className,
  ariaLabel,
}: {
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <span
      className={cn(
        'shrink-0 flowix-spin rounded-full border-2 border-[color-mix(in_oklch,var(--muted-foreground)_26%,transparent)] border-t-[var(--brand)]',
        className,
      )}
      role={ariaLabel ? 'status' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    />
  );
}
