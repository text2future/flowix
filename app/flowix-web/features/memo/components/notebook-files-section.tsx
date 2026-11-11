'use client';

import type { CSSProperties, ReactNode, Ref } from 'react';
import { ChevronRight } from 'lucide-react';

import { Button } from '@shared/ui/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { TREE_EDGE_GUTTER, TREE_ROW_HEIGHT } from './notebook-tree-layout';
import type { NotebookTreeRenderRow } from './notebook-tree-render-rows';

interface VirtualTreeRow {
  key: string;
  item: NotebookTreeRenderRow;
  start: number;
  size: number;
}

interface NotebookFilesSectionProps {
  order: number;
  fillsRemainingSpace: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  sectionActions: ReactNode;
  isRootDropTarget: boolean;
  headerRef: Ref<HTMLDivElement>;
  rootRef: Ref<HTMLDivElement>;
  notebookName: string;
  hasError: boolean;
  onRetry: () => void;
  hasVisibleItems: boolean;
  loading: boolean;
  hasDraft: boolean;
  virtualTreeSize: number;
  contentClassName?: string;
  folderDropHighlight: CSSProperties | null;
  virtualRows: readonly VirtualTreeRow[];
  renderRow: (row: NotebookTreeRenderRow) => ReactNode;
}

/** Renders the notebook tab's file section; the parent owns tree state and actions. */
export function NotebookFilesSection({
  order,
  fillsRemainingSpace,
  collapsed,
  onToggleCollapsed,
  sectionActions,
  isRootDropTarget,
  headerRef,
  rootRef,
  notebookName,
  hasError,
  onRetry,
  hasVisibleItems,
  loading,
  hasDraft,
  virtualTreeSize,
  contentClassName,
  folderDropHighlight,
  virtualRows,
  renderRow,
}: NotebookFilesSectionProps) {
  const { t } = useI18n();

  return (
    <section
      className="flex min-h-0 flex-col pb-3"
      aria-label={t('memo.fileTree.sectionTitle')}
      data-notebook-files-section="true"
      style={{ order, flexGrow: fillsRemainingSpace ? 1 : 0 }}
    >
      <div
        ref={headerRef}
        className={cn(
          'notebook-file-tree__section-header group mb-0.5 flex h-7 shrink-0 items-center gap-1 rounded-lg px-1.5 transition-colors duration-150 hover:bg-[var(--muted)]',
          isRootDropTarget && 'notebook-file-tree__drop-hint',
        )}
        style={{
          marginLeft: TREE_EDGE_GUTTER,
          width: `calc(100% - ${TREE_EDGE_GUTTER * 2}px)`,
        }}
      >
        <button
          type="button"
          className="flex h-full items-center gap-0.5 text-[0.82rem] font-medium text-[var(--muted-foreground)] opacity-90 hover:text-[var(--foreground)] focus-visible:outline-none"
          aria-label={t(collapsed ? 'memo.fileTree.expandFiles' : 'memo.fileTree.collapseFiles')}
          title={t(collapsed ? 'memo.fileTree.expandFiles' : 'memo.fileTree.collapseFiles')}
          onClick={onToggleCollapsed}
        >
          <span>{t('memo.fileTree.sectionTitle')}</span>
          <ChevronRight className={cn(
            'h-3.5 w-3.5 opacity-0 transition-[opacity,transform] group-hover:opacity-100 group-focus-within:opacity-100',
            collapsed && 'opacity-100',
            !collapsed && 'rotate-90',
          )} />
        </button>
        <div className="ml-auto flex items-center">{sectionActions}</div>
      </div>
      {!collapsed && (
        <div
          ref={rootRef}
          role="tree"
          aria-multiselectable="true"
          aria-label={notebookName}
          data-notebook-tree-root="true"
          style={{ minHeight: virtualTreeSize || TREE_ROW_HEIGHT }}
          className={cn(
            'relative min-h-0 flex-1 rounded-lg transition-colors duration-150',
            isRootDropTarget && 'notebook-file-tree__drop-hint',
          )}
        >
          {hasError && (
            <div className="flex items-center justify-center gap-2 px-4 py-4 text-center text-xs text-[var(--muted-foreground)]" role="alert">
              <span>{t('memo.fileTree.unreadableHint')}</span>
              <Button type="button" size="xs" variant="ghost" className="rounded-lg" onClick={onRetry}>
                {t('error.retry')}
              </Button>
            </div>
          )}
          {!hasVisibleItems && !loading && !hasError && !hasDraft && (
            <div className="px-4 py-6 text-center text-xs text-[var(--muted-foreground)]">
              {t('memo.fileTree.empty')}
            </div>
          )}
          <div
            className={cn(
              'notebook-file-tree__virtual-items relative min-h-full',
              hasVisibleItems && contentClassName,
            )}
            data-notebook-tree-virtualized="true"
            style={{ height: virtualTreeSize }}
          >
            {folderDropHighlight && (
              <div
                aria-hidden="true"
                className="notebook-file-tree__drop-range notebook-file-tree__drop-hint pointer-events-none absolute right-[6px] z-[1] rounded-lg"
                style={folderDropHighlight}
              />
            )}
            {virtualRows.map(({ key, item, start, size }) => (
              <div
                key={key}
                className="absolute inset-x-0 top-0 z-[2]"
                data-notebook-virtual-row={key}
                data-notebook-tree-row="true"
                data-notebook-drop-path={item.kind === 'node' && item.item.type === 'folder'
                  ? item.item.fullPath
                  : undefined}
                data-notebook-parent-path={item.parentPath}
                style={{ height: size, transform: `translateY(${start}px)` }}
              >
                {renderRow(item)}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
