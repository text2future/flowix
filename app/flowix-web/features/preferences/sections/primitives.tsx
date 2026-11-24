'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const FIELD_TITLE_CLASS = 'text-sm font-normal text-[var(--foreground)]';
export const FIELD_DESC_CLASS = 'text-sm text-[var(--muted-foreground)]';
export const SECTION_HEADER_TITLE_CLASS =
  'text-base font-medium text-[var(--foreground)]';
export const FIELD_INPUT_CLASS =
  'bg-[var(--card)] border-[var(--border)] text-[var(--foreground)] placeholder:text-[var(--input-placeholder)] focus-visible:border-[var(--input-ring)] focus-visible:outline-none';

/** Top-of-tab header. Use once per tab to introduce the section.
 *  Renders the title with a light-gray divider underneath, visually
 *  separating the page heading from the form fields below.
 *
 *  `size`:
 *  - `default` (默认): 顶层 tab 标题 ── `text-base font-medium` + 分割线
 *  - `compact`:         嵌在卡片里当子标题用 ── `text-sm font-semibold` 前
 *                       景色, 不带分割线也不带 pb
 *  - `field`:           与表单字段标签一致 ── `text-sm font-normal` 前景色,
 *                       不带分割线也不带 pb */
export function SectionHeader({
  title,
  description,
  className,
  size = 'default',
}: {
  title: string;
  description?: string;
  className?: string;
  size?: 'default' | 'compact' | 'field';
}) {
  return (
    <div
      className={cn(
        size === 'default' ? 'space-y-1 pb-3 border-b border-[var(--divider)]' : 'space-y-1',
        className,
      )}
    >
      <h3
        className={cn(
          size === 'default'
            ? SECTION_HEADER_TITLE_CLASS
            : size === 'field'
              ? FIELD_TITLE_CLASS
              : 'text-sm font-semibold text-[var(--foreground)]',
        )}
      >
        {title}
      </h3>
      {description && <p className={FIELD_DESC_CLASS}>{description}</p>}
    </div>
  );
}

/** Vertical field: title + optional description stacked above a control. */
export function Field({
  title,
  description,
  hint,
  controlId,
  children,
  className,
}: {
  title: string;
  description?: string;
  hint?: string;
  /** Connects the visible field title to its input, select, or custom control. */
  controlId?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="space-y-0.5">
        {controlId
          ? <label htmlFor={controlId} className={FIELD_TITLE_CLASS}>{title}</label>
          : <span className={FIELD_TITLE_CLASS}>{title}</span>}
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
  controlId,
  children,
  className,
}: {
  title: string;
  description?: string;
  /** Connects the visible row title to its input, select, or custom control. */
  controlId?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      <div className="space-y-0.5 min-w-0">
        {controlId
          ? <label htmlFor={controlId} className={FIELD_TITLE_CLASS}>{title}</label>
          : <span className={FIELD_TITLE_CLASS}>{title}</span>}
        {description && <p className={FIELD_DESC_CLASS}>{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
