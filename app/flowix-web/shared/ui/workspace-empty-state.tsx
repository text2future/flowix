import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import backgroundImage from '@/assets/bg.document.svg';

export interface WorkspaceEmptyStateProps {
  message: ReactNode;
  children?: ReactNode;
  /**
   * Which host's fill the state sits on. `agent` matches the conversation
   * surface (`--agent-bg`), `document` matches the document pane
   * (`--document-bg`). Every empty state is opaque, because hosts render their
   * own idle content underneath — e.g. a thread that failed to load still has
   * an `agent-thread-card__empty` card mounted below the error layer.
   */
  tone?: 'document' | 'agent';
  /**
   * Full-surface empty states paint the document artwork behind their copy.
   * Card-local states (a thread that failed to load inside an agent card) turn
   * it off: the 800px artwork clipped to a message pane reads as a stray light
   * block, and the host fill already carries the surface identity.
   */
  artwork?: boolean;
  className?: string;
}

/** Shared full-surface empty state used by workspace hosts and their views. */
export function WorkspaceEmptyState({
  message,
  children,
  tone = 'document',
  artwork = true,
  className,
}: WorkspaceEmptyStateProps) {
  return (
    <div
      className={cn(
        'relative flex h-full w-full items-center justify-center',
        tone === 'agent'
          ? 'bg-[var(--agent-bg,var(--document-bg))]'
          : 'bg-[var(--document-bg)]',
        className,
      )}
    >
      {artwork && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-no-repeat bg-bottom bg-[length:auto_800px] opacity-[0.42]"
          style={{ backgroundImage: `url(${backgroundImage})` }}
        />
      )}
      {children ? children : (
        <span className="relative text-center text-sm text-[var(--muted-foreground)]">
          {message}
        </span>
      )}
    </div>
  );
}
