'use client';

import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { TreeSectionEmptyState } from '@shared/ui/tree-section-empty-state';
import type { CollectionIndexItem, DocTreeItem, MediaLibraryListItem, TableDocumentListItem } from '@platform/tauri/client';
import { TREE_EDGE_GUTTER } from './notebook-tree-layout';

interface SectionFrameProps {
  order: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  sectionActions?: ReactNode;
}

function SectionHeader({ collapsed, onToggleCollapsed, sectionActions, title, toggleLabel }: Omit<SectionFrameProps, 'order'> & { title: string; toggleLabel: string }) {
  return (
      <div
        className="notebook-file-tree__section-header group mb-0.5 flex h-7 items-center rounded-lg px-1.5 transition-colors hover:bg-[var(--muted)]"
        style={{ marginLeft: TREE_EDGE_GUTTER, width: `calc(100% - ${TREE_EDGE_GUTTER * 2}px)` }}
      >
        <button
          type="button"
          className="flex h-full items-center gap-0.5 text-[0.82rem] font-medium text-[var(--muted-foreground)] opacity-90 hover:text-[var(--foreground)] focus-visible:outline-none"
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={onToggleCollapsed}
        >
          <span>{title}</span>
          <ChevronRight className={cn(
            'h-3.5 w-3.5 opacity-0 transition-[opacity,transform] group-hover:opacity-100 group-focus-within:opacity-100',
            collapsed && 'opacity-100',
            !collapsed && 'rotate-90',
          )} />
        </button>
        <div className="ml-auto flex items-center">{sectionActions}</div>
      </div>
  );
}

interface NotebookPinnedSectionProps extends SectionFrameProps {
  items: DocTreeItem[];
  renderItem: (item: DocTreeItem) => ReactNode;
  hasPreviousPage: boolean;
  hasMoreItems: boolean;
  loadingMore: boolean;
  onLoadPrevious: () => void;
  onLoadMore: () => void;
}

export function NotebookPinnedSection({
  order,
  collapsed,
  onToggleCollapsed,
  sectionActions,
  items,
  renderItem,
  hasPreviousPage,
  hasMoreItems,
  loadingMore,
  onLoadPrevious,
  onLoadMore,
}: NotebookPinnedSectionProps) {
  const { t } = useI18n();

  return (
    <section
      className="pb-3"
      aria-label={t('memo.fileTree.pinnedSectionTitle')}
      data-notebook-pinned-section="true"
      style={{ order }}
    >
      <SectionHeader collapsed={collapsed} onToggleCollapsed={onToggleCollapsed} sectionActions={sectionActions}
        title={t('memo.fileTree.pinnedSectionTitle')}
        toggleLabel={t(collapsed ? 'memo.fileTree.expandPinned' : 'memo.fileTree.collapsePinned')} />
      {!collapsed && <div className="flex flex-col gap-0.5">
        {items.map(renderItem)}
        {(hasPreviousPage || hasMoreItems) && (
          <div className="flex h-8 items-center justify-between gap-2 px-2 text-xs text-[var(--muted-foreground)]">
            {hasPreviousPage ? (
              <button
                type="button"
                className="rounded px-1 hover:text-[var(--foreground)]"
                disabled={loadingMore}
                onClick={onLoadPrevious}
              >
                {t('memo.fileTree.previousPinnedPage')}
              </button>
            ) : <span />}
            {hasMoreItems ? (
              <button
                type="button"
                className="rounded px-1 hover:text-[var(--foreground)] disabled:opacity-60"
                disabled={loadingMore}
                onClick={onLoadMore}
              >
                {t(loadingMore ? 'memo.fileTree.loadingMorePinned' : 'memo.fileTree.loadMorePinned')}
              </button>
            ) : <span />}
          </div>
        )}
      </div>}
    </section>
  );
}

interface NotebookViewsSectionProps extends SectionFrameProps {
  tables: TableDocumentListItem[];
  mediaLibraries: MediaLibraryListItem[];
  workDocuments?: CollectionIndexItem[];
  renderWorkDocuments?: (item: CollectionIndexItem) => ReactNode;
  renderTable: (item: TableDocumentListItem) => ReactNode;
  renderMediaLibrary: (item: MediaLibraryListItem) => ReactNode;
  onHideSection: () => void;
}

export function NotebookViewsSection({
  order,
  collapsed,
  onToggleCollapsed,
  sectionActions,
  tables,
  mediaLibraries,
  renderTable,
  renderMediaLibrary,
  workDocuments = [],
  renderWorkDocuments,
  onHideSection,
}: NotebookViewsSectionProps) {
  const { t } = useI18n();
  const isEmpty = tables.length === 0 && mediaLibraries.length === 0 && workDocuments.length === 0;

  return (
    <section
      className="pb-3"
      aria-label={t('memo.fileTree.viewsSectionTitle')}
      data-notebook-views-section="true"
      style={{ order }}
    >
      <SectionHeader collapsed={collapsed} onToggleCollapsed={onToggleCollapsed} sectionActions={sectionActions}
        title={t('memo.fileTree.viewsSectionTitle')}
        toggleLabel={t(collapsed ? 'memo.fileTree.expandViews' : 'memo.fileTree.collapseViews')} />
      {!collapsed && (isEmpty ? (
        <TreeSectionEmptyState
          message={t('memo.fileTree.sectionEmpty')}
          hideLabel={t('memo.fileTree.sectionEmptyHide')}
          onHide={onHideSection}
          edgeGutter={TREE_EDGE_GUTTER}
        />
      ) : (
        <div className="space-y-0.5">
          {tables.map(renderTable)}
          {mediaLibraries.map(renderMediaLibrary)}
          {renderWorkDocuments && workDocuments.map(renderWorkDocuments)}
        </div>
      ))}
    </section>
  );
}
