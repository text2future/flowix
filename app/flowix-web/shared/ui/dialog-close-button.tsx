import type { ButtonHTMLAttributes } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DIALOG_CLOSE_CLASS } from './dialog-styles';

export function DialogCloseButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label="关闭"
      {...props}
      data-slot="dialog-close"
      className={cn('absolute right-5 top-5 z-20 disabled:cursor-not-allowed disabled:opacity-50', DIALOG_CLOSE_CLASS, className)}
    >
      <X className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
