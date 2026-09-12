'use client';

import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Shared bottom-left host for non-blocking onboarding and update prompts. */
export function FloatingPromptStack({ children }: { children: ReactNode }) {
  return createPortal(
    <div className="pointer-events-none fixed bottom-4 left-4 z-[130] flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-[340px] flex-col gap-3">
      {children}
    </div>,
    document.body,
  );
}

export function FloatingPrompt({
  open,
  onClose,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  if (!open) return null;

  return (
    <section
      role="dialog"
      aria-modal="false"
      className={cn(
        'pointer-events-auto relative max-h-[calc(100vh-2rem)] w-full overflow-y-auto rounded-2xl border border-[var(--divider)] bg-[var(--card)] shadow-xl flowix-dialog-enter',
        className,
      )}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute right-4 top-4 z-10 rounded-md p-1 hover:bg-[var(--muted)]"
      >
        <X className="h-4 w-4" />
      </button>
      {children}
    </section>
  );
}
