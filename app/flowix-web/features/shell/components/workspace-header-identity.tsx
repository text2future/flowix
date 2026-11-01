import type { ReactNode } from 'react';

/** Ordinary surface identity; Agent supplies its existing editable identity slot. */
export function WorkspaceHeaderIdentity({ title, icon, className = '' }: {
  title?: string | null; icon?: ReactNode; className?: string;
}) {
  return <span className={`flex min-w-0 items-center gap-2 text-sm text-[var(--foreground)] ${className}`}
    title={title ?? undefined} data-tauri-drag-region>
    {icon && <span className="shrink-0">{icon}</span>}
    {title && <span className="truncate" data-tauri-drag-region>{title}</span>}
  </span>;
}
