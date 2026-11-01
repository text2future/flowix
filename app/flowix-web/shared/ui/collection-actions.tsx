'use client';

import { createPortal } from 'react-dom';
import type { ReactNode, RefCallback } from 'react';

/** Omitted host = standalone header; null target = embedded, awaiting its slot. */
export interface CollectionActionsHost {
  readonly target: HTMLElement | null;
}

/** Mounted but inactive panels must never publish actions into the active tab. */
export const INACTIVE_COLLECTION_ACTIONS_HOST: CollectionActionsHost = { target: null };

/** The shell owns the slot; React reports its mount, replacement and removal. */
export function CollectionActionsSlot({ onTargetChange, children }: {
  onTargetChange: RefCallback<HTMLDivElement>;
  children?: ReactNode;
}) {
  return <div ref={onTargetChange} className="flex shrink-0 items-center gap-2" data-host-actions-slot="true">
    {children}
  </div>;
}

export function CollectionActionsPortal({ host, children }: {
  host: CollectionActionsHost;
  children: ReactNode;
}) {
  return host.target ? createPortal(children, host.target) : null;
}
