import type { FocusEventHandler } from 'react';
import { cn } from '@/lib/utils';

interface FlowixCheckboxBaseProps {
  checked: boolean;
  indeterminate?: boolean;
  className?: string;
  disabled?: boolean;
}

export type FlowixCheckboxProps = FlowixCheckboxBaseProps & (
  | {
      interactive?: true;
      onCheckedChange: (checked: boolean) => void;
      'aria-label': string;
      onBlur?: FocusEventHandler<HTMLButtonElement>;
    }
  | {
      interactive: false;
      onCheckedChange?: never;
      'aria-label'?: never;
      onBlur?: never;
    }
);

export function FlowixCheckbox({
  checked,
  indeterminate = false,
  onCheckedChange,
  'aria-label': ariaLabel,
  interactive = true,
  className,
  disabled = false,
  onBlur,
}: FlowixCheckboxProps) {
  const checkboxClassName = cn(
    'flowix-hand-checkbox',
    interactive && 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
    checked && 'flowix-hand-checkbox--checked',
    indeterminate && 'flowix-hand-checkbox--indeterminate',
    disabled && 'disabled:cursor-not-allowed disabled:opacity-50',
    className,
  );
  const mark = (checked || indeterminate) && <span className="flowix-hand-checkbox__mark" aria-hidden="true" />;

  if (!interactive) {
    return <span aria-hidden="true" className={checkboxClassName}>{mark}</span>;
  }

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      onBlur={onBlur}
      className={checkboxClassName}
    >
      {mark}
    </button>
  );
}
