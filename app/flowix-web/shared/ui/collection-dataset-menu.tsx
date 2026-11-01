import type { ReactNode } from 'react';
import { FunnelIcon } from '@phosphor-icons/react';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { OverlayScrollbar } from './overlay-scrollbar';

export const collectionDatasetMenuClassName = 'max-h-[60vh] w-[220px] max-w-[calc(100vw-16px)] overflow-hidden rounded-xl p-1.5 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]';

/** All collection tabs share this order; only note views supply field actions. */
export function CollectionDatasetMenuContent({ location, noteFilter, assetFilter, children }: {
  location: ReactNode;
  noteFilter?: ReactNode;
  assetFilter?: ReactNode;
  children?: ReactNode;
}) {
  return <OverlayScrollbar className="overlay-scrollbar-frame--edge-aligned max-h-[calc(60vh-14px)]" scrollerClassName="max-h-[calc(60vh-14px)] overflow-y-auto overflow-x-hidden">
    <div className="space-y-0.5">
      {location}
      {noteFilter}
      {assetFilter}
      {children && <><div role="separator" aria-hidden="true" className="mx-2 h-px bg-[var(--border)]" />{children}</>}
    </div>
  </OverlayScrollbar>;
}

/** The only dataset popup shell used by note, asset and file-tree views. */
export function CollectionDatasetMenu({ open, onOpenChange, disabled = false, active = false,
  label = '管理数据集', title = '数据集合', ignoreOutside = false,
  location, noteFilter, assetFilter, children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  active?: boolean;
  label?: string;
  title?: string;
  ignoreOutside?: boolean;
  location: ReactNode;
  noteFilter?: ReactNode;
  assetFilter?: ReactNode;
  children?: ReactNode;
}) {
  return <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverTrigger asChild>
      <button type="button" disabled={disabled} aria-label={label} title={title}
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--muted)] data-[state=open]:text-[var(--foreground)] disabled:opacity-40 ${open || active ? 'bg-[var(--muted)] text-[var(--foreground)]' : ''}`}>
        <FunnelIcon size={14} weight="bold" aria-hidden="true" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" side="bottom" sideOffset={0} fitViewport style={{ zIndex: 150 }}
      ignorePopoverOutside={ignoreOutside} ignoreSelectOutside className={collectionDatasetMenuClassName}>
      <CollectionDatasetMenuContent location={location} noteFilter={noteFilter} assetFilter={assetFilter}>
        {children}
      </CollectionDatasetMenuContent>
    </PopoverContent>
  </Popover>;
}
