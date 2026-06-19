'use client';

import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export const FIELD_TITLE_CLASS = 'text-sm font-normal text-[var(--foreground)]';
export const FIELD_DESC_CLASS = 'text-sm text-[var(--muted-foreground)]';
export const SECTION_HEADER_TITLE_CLASS =
  'text-base font-medium text-[var(--foreground)]';
export const FIELD_INPUT_CLASS =
  'bg-[var(--card)] border-[var(--border)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]';

/** Top-of-tab header. Use once per tab to introduce the section.
 *  Renders the title with a light-gray divider underneath, visually
 *  separating the page heading from the form fields below. */
export function SectionHeader({
  title,
  className,
}: {
  title: string;
  className?: string;
}) {
  return (
    <div className={cn('pb-3 border-b border-[var(--divider)]', className)}>
      <h3 className={SECTION_HEADER_TITLE_CLASS}>{title}</h3>
    </div>
  );
}

/** Vertical field: title + optional description stacked above a control. */
export function Field({
  title,
  description,
  hint,
  children,
  className,
}: {
  title: string;
  description?: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="space-y-0.5">
        <label className={FIELD_TITLE_CLASS}>{title}</label>
        {description && <p className={FIELD_DESC_CLASS}>{description}</p>}
      </div>
      {children}
      {hint && <p className={FIELD_DESC_CLASS}>{hint}</p>}
    </div>
  );
}

/** Horizontal field: title + description on the left, control on the right. */
export function FieldRow({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      <div className="space-y-0.5 min-w-0">
        <label className={FIELD_TITLE_CLASS}>{title}</label>
        {description && <p className={FIELD_DESC_CLASS}>{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
