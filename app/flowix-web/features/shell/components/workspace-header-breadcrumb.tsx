'use client';

import { Fragment } from 'react';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { breadcrumbSignature, useBreadcrumbCollapse } from '@shared/hooks/use-breadcrumb-collapse';
import { DocumentBreadcrumbCollapsedPopover, DocumentBreadcrumbFolderPopover,
  type DocumentBreadcrumbCollapsedItem } from '@features/memo/public/shell-api';
import { useI18n } from '@/lib/i18n';

export interface WorkspaceHeaderBreadcrumbItem {
  label: string;
  type?: 'folder' | 'file';
  /** 段对应的文件系统路径；文件夹段靠它打开文件树弹层。 */
  path?: string;
}

/**
 * Width reserved for the `···` marker: the trigger is a `w-6` button, so 24px
 * is exactly what the row loses when the middle folds away. The file-browser
 * breadcrumb reserves more (44) because its button carries horizontal padding.
 */
const COLLAPSED_MARKER_WIDTH = 24;

/**
 * The current file takes the leftover row width (`flex-1`), so a short name
 * sits right after the chevron while a long one fills the bar before it starts
 * truncating. The root may shrink, parent folders keep their measured size.
 */
function segmentSizing(visibleIndex: number, total: number): string {
  if (visibleIndex === total - 1) return 'flex-1';
  return visibleIndex === 0 ? 'shrink' : 'shrink-0';
}

/**
 * The `···` marker standing in for the folded middle segments. With an opener
 * it lists them in a popover; without one it stays inert so a display-only
 * breadcrumb never grows a clickable control.
 */
function CollapsedMarker({
  folders,
  title,
  activeFilePath,
  onOpenFile,
}: {
  folders: readonly DocumentBreadcrumbCollapsedItem[];
  /** Every folded label, also the tooltip when the marker is inert. */
  title: string;
  activeFilePath: string | null;
  /** Column-local opener; `null` = nothing owns the destination. */
  onOpenFile: ((filePath: string) => void) | null;
}) {
  const { t } = useI18n();
  const marker = <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />;

  if (!onOpenFile || folders.length === 0) {
    return (
      <span title={title} data-tauri-drag-region
        className="flex shrink-0 items-center text-[var(--muted-foreground)]">
        {marker}
      </span>
    );
  }

  return (
    <DocumentBreadcrumbCollapsedPopover
      items={folders}
      activeFilePath={activeFilePath}
      onFileSelect={onOpenFile}
    >
      <button
        type="button"
        aria-label={t('breadcrumb.showCollapsedFolders')}
        title={title}
        className="flex h-4 w-6 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--muted)] data-[state=open]:text-[var(--foreground)]"
      >
        {marker}
      </button>
    </DocumentBreadcrumbCollapsedPopover>
  );
}

/**
 * Path breadcrumb for the workspace header, styled after the file-browser
 * breadcrumbs: muted folder segments, a foreground file segment and
 * `ChevronRight` separators. When the row runs out of width, middle segments
 * collapse into a `···` marker (tooltip lists them) while the root and the
 * current file stay visible.
 *
 * With `onOpenFile` supplied (document column), every folder segment that
 * carries a path opens a file-tree popover: folders expand in place so the
 * path can be walked level by level, and picking a file there hands it back to
 * the caller, which opens it in this column. The `···` marker behaves the same
 * way as the repository breadcrumb: it lists the folded folders and lets you
 * step into any of them. Segments without a handler (breadcrumb owned by a
 * surface that has its own bar) stay plain text.
 *
 * Collapse planning lives in `useBreadcrumbCollapse` so this header and the
 * file browser cannot drift apart.
 */
export function WorkspaceHeaderBreadcrumb({ items, onOpenFile }: {
  items: WorkspaceHeaderBreadcrumbItem[];
  /** Caller owns the opening (column-local); omitted = display-only breadcrumb. */
  onOpenFile?: (filePath: string, scopePath: string) => void;
}) {
  const { t } = useI18n();
  const { containerRef, itemRefs, hiddenStart } = useBreadcrumbCollapse<HTMLSpanElement>({
    signature: breadcrumbSignature(items),
    itemCount: items.length,
    ellipsisWidth: COLLAPSED_MARKER_WIDTH,
  });

  const visibleItems = hiddenStart === null
    ? items.map((item, index) => ({ item, index }))
    : [
      { item: items[0], index: 0 },
      ...items.slice(hiddenStart).map((item, offset) => ({ item, index: hiddenStart + offset })),
    ];
  const collapsedItems = hiddenStart === null ? [] : items.slice(1, hiddenStart);
  /** Opening a file from a folder popover scopes it to the breadcrumb root. */
  const scopePath = items[0]?.path ?? null;
  const activeFilePath = items.reduce<string | null>(
    (current, item) => (item.type === 'file' && item.path ? item.path : current), null);
  /** Column-local opener, or `null` when nothing owns the destination. */
  const openFromPopover = onOpenFile && scopePath
    ? (filePath: string) => onOpenFile(filePath, scopePath)
    : null;
  const collapsedFolders: DocumentBreadcrumbCollapsedItem[] = collapsedItems.flatMap((item) => (item.path
    ? [{ label: item.label, path: item.path }]
    : []));
  const collapsedTitle = collapsedItems.map((collapsed) => collapsed.label).join(' / ');

  return (
    <nav aria-label={t('breadcrumb.label')} className="relative flex min-w-0 flex-1 items-center self-stretch" data-tauri-drag-region>
      <span ref={containerRef} data-tauri-drag-region
        className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-xs text-[var(--muted-foreground)]">
        {visibleItems.map(({ item, index }, visibleIndex) => (
          <Fragment key={`${item.label}-${index}`}>
            {visibleIndex > 0 && <ChevronRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />}
            <span title={item.label} data-tauri-drag-region
              className={`flex min-w-0 items-center ${segmentSizing(visibleIndex, visibleItems.length)}`}>
              {openFromPopover && item.type !== 'file' && item.path ? (
                <DocumentBreadcrumbFolderPopover
                  folderPath={item.path}
                  folderName={item.label}
                  activeFilePath={activeFilePath}
                  onFileSelect={openFromPopover}
                >
                  <button
                    type="button"
                    aria-label={t('collection.openFolder', { name: item.label })}
                    title={item.path}
                    className="min-w-0 max-w-[180px] truncate rounded px-1 text-left transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--muted)] data-[state=open]:text-[var(--foreground)]"
                  >
                    {item.label}
                  </button>
                </DocumentBreadcrumbFolderPopover>
              ) : (
                <span data-tauri-drag-region
                  className={item.type === 'file'
                    ? 'min-w-0 flex-1 truncate text-[var(--foreground)]'
                    : 'min-w-0 max-w-[180px] truncate'}>
                  {item.label}
                </span>
              )}
            </span>
            {hiddenStart !== null && visibleIndex === 0 && collapsedItems.length > 0 && (
              <>
                <ChevronRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
                <CollapsedMarker
                  folders={collapsedFolders}
                  title={collapsedTitle}
                  activeFilePath={activeFilePath}
                  onOpenFile={openFromPopover}
                />
              </>
            )}
          </Fragment>
        ))}
      </span>
      {/* Hidden measurement layer: folders are measured at their 180px cap
          (that is all they can ever occupy), the file at its natural width —
          it stretches into whatever space is left, so a truncated file is only
          reported when the row genuinely cannot fit it. */}
      <span aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 -z-10 flex w-max items-center gap-1 opacity-0">
        {items.map((item, index) => (
          <span key={`${item.label}-${index}`}
            ref={(element) => { itemRefs.current[index] = element; }}
            className="flex shrink-0 items-center gap-1">
            {index > 0 && <ChevronRight className="h-3 w-3 shrink-0" />}
            <span className={`truncate ${item.type === 'file' ? '' : 'max-w-[180px]'}`}>{item.label}</span>
          </span>
        ))}
      </span>
    </nav>
  );
}
