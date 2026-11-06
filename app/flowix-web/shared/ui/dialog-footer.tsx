import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Standard action spacing; callers may choose a stacked layout or add a leading action. */
export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} data-slot="dialog-footer" className={cn('flex justify-end gap-2 pt-4', className)} />;
}
