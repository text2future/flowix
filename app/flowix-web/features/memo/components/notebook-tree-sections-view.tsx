'use client';

import type { CSSProperties, ReactNode, Ref } from 'react';

import type { WorkspaceAgentRepository } from '@features/agent/public/workspace-api';
import type { TableViewType } from '@features/multidimensional-table/public/create-api';
import type { FolderTreeSort } from './use-folder-tree';
import type { PinnedTreeItem } from './use-notebook-pinned-notes';
import type { NotebookTreeRenderRow } from './notebook-tree-render-rows';
import type {
  NotebookTreeHiddenSection,
  NotebookTreeSection,
} from './use-notebook-tree-sections';
import type { NotebookTreeSectionMenuProps } from './notebook-tree-section-menu';
import { AgentTasksSection } from '@features/agent/public/shell-api';
import { NotebookPinnedSection } from './notebook-file-tree-sections';
import { NotebookFilesSection, type NotebookFilesVirtualRow } from './notebook-files-section';
import { AgentRepositoriesSection } from './notebook-repositories-section';
import { NotebookMoreSection } from './notebook-more-section';
import { NotebookTreeSectionMenu } from './notebook-tree-section-menu';
import { TREE_EDGE_GUTTER } from './notebook-tree-layout';

interface NotebookTreeSectionsViewProps {
  layout: {
    order: NotebookTreeSection[];
    hidden: NotebookTreeHiddenSection[];
    visible: NotebookTreeSection[];
    onMove: (section: NotebookTreeSection, direction: -1 | 1) => void;
    onHide: (section: NotebookTreeSection) => void;
    onCustomize: (rect: DOMRect) => void;
  };
  agents: {
    notebookId: string | null;
    selectedConversationId: string | null;
    onHeightChange: (height: number) => void;
    onSelectConversation: (instanceId: string) => void;
    onShowAll: () => void;
    onConfigureCount: () => void;
  };
  pinned: {
    items: PinnedTreeItem[];
    hasPrevious: boolean;
    hasMore: boolean;
    loading: boolean;
    collapsed: boolean;
    onLoadPrevious: () => void;
    onLoadMore: () => void;
    onToggleCollapsed: () => void;
    renderItem: (item: PinnedTreeItem) => ReactNode;
  };
  files: {
    notebookName: string;
    collapsed: boolean;
    onToggleCollapsed: () => void;
    isRootDropTarget: boolean;
    headerRef: Ref<HTMLDivElement>;
    rootRef: Ref<HTMLDivElement>;
    hasError: boolean;
    onRetry: () => void;
    hasVisibleItems: boolean;
    loading: boolean;
    hasDraft: boolean;
    virtualSize: number;
    contentClassName?: string;
    folderDropHighlight: CSSProperties | null;
    virtualRows: readonly NotebookFilesVirtualRow[];
    renderRow: (row: NotebookTreeRenderRow) => ReactNode;
    sort: FolderTreeSort;
    onSort: (sort: FolderTreeSort) => void;
    onCreateFolder?: () => void;
    onCreateNote: () => void;
    onCreateTable: (viewType?: TableViewType) => void;
    onCreateMediaLibrary: () => void;
    onCreateWorkDocuments: () => void;
    onImportFiles: () => void;
    onImportFolder: () => void;
  };
  repositories: {
    items: WorkspaceAgentRepository[];
    introEnabled: boolean;
    onHeightChange: (height: number) => void;
    onAdd: () => void;
    onRemove: (repository: WorkspaceAgentRepository) => void;
    canAdd: boolean;
    onOpenFile: (path: string, scopePath: string) => void;
    onOpenFileInBrowserColumn: (path: string, scopePath: string) => void;
    onOpenList: () => void;
  };
  more: {
    onHeightChange: (height: number) => void;
    compactTopSpacing: boolean;
  };
}

/** Composes the independent sections shown inside the notebook file-tree tab. */
export function NotebookTreeSectionsView({
  layout,
  agents,
  pinned,
  files,
  repositories,
  more,
}: NotebookTreeSectionsViewProps) {
  const sectionMenu = (
    section: NotebookTreeSection,
    extra: Partial<Omit<NotebookTreeSectionMenuProps,
      'canMoveUp' | 'canMoveDown' | 'onMoveUp' | 'onMoveDown' | 'onHideSection' | 'onCustomizeDisplay'>> = {},
  ) => {
    const visibleIndex = layout.visible.indexOf(section);
    return (
      <NotebookTreeSectionMenu
        onHideSection={() => layout.onHide(section)}
        canMoveUp={visibleIndex > 0}
        canMoveDown={visibleIndex < layout.visible.length - 1}
        onMoveUp={() => layout.onMove(section, -1)}
        onMoveDown={() => layout.onMove(section, 1)}
        onCustomizeDisplay={layout.onCustomize}
        {...extra}
      />
    );
  };

  return (
    <>
      {agents.notebookId && !layout.hidden.includes('agents') && (
        <AgentTasksSection
          key={agents.notebookId}
          notebookId={agents.notebookId}
          edgeGutter={TREE_EDGE_GUTTER}
          order={layout.order.indexOf('agents') + 1}
          onHeightChange={agents.onHeightChange}
          onConversationSelect={agents.onSelectConversation}
          selectedConversationId={agents.selectedConversationId}
          onHideSection={() => layout.onHide('agents')}
          onShowAllConversations={agents.onShowAll}
          sectionActions={sectionMenu('agents', { onConfigureAgentConversationCount: agents.onConfigureCount })}
        />
      )}
      {(pinned.items.length > 0 || pinned.hasPrevious || pinned.hasMore) && !layout.hidden.includes('pinned') && (
        <NotebookPinnedSection
          order={layout.order.indexOf('pinned') + 1}
          items={pinned.items}
          hasPreviousPage={pinned.hasPrevious}
          hasMoreItems={pinned.hasMore}
          loadingMore={pinned.loading}
          onLoadPrevious={pinned.onLoadPrevious}
          onLoadMore={pinned.onLoadMore}
          collapsed={pinned.collapsed}
          onToggleCollapsed={pinned.onToggleCollapsed}
          sectionActions={sectionMenu('pinned')}
          renderItem={pinned.renderItem}
        />
      )}
      {!layout.hidden.includes('files') && (
        <NotebookFilesSection
          order={layout.order.indexOf('files') + 1}
          fillsRemainingSpace={layout.visible[layout.visible.length - 1] === 'files'}
          collapsed={files.collapsed}
          onToggleCollapsed={files.onToggleCollapsed}
          sectionActions={sectionMenu('files', {
            onCreateFolder: files.onCreateFolder,
            onCreateNote: files.onCreateNote,
            onCreateTable: files.onCreateTable,
            onCreateMediaLibrary: files.onCreateMediaLibrary,
            onCreateWorkDocuments: files.onCreateWorkDocuments,
            onImportFiles: files.onImportFiles,
            onImportFolder: files.onImportFolder,
            sort: files.sort,
            onSort: files.onSort,
          })}
          isRootDropTarget={files.isRootDropTarget}
          headerRef={files.headerRef}
          rootRef={files.rootRef}
          notebookName={files.notebookName}
          hasError={files.hasError}
          onRetry={files.onRetry}
          hasVisibleItems={files.hasVisibleItems}
          loading={files.loading}
          hasDraft={files.hasDraft}
          virtualTreeSize={files.virtualSize}
          contentClassName={files.contentClassName}
          folderDropHighlight={files.folderDropHighlight}
          virtualRows={files.virtualRows}
          renderRow={files.renderRow}
        />
      )}
      {!layout.hidden.includes('repositories') && (
        <AgentRepositoriesSection
          repositories={repositories.items}
          introEnabled={repositories.introEnabled}
          order={layout.order.indexOf('repositories') + 1}
          onHeightChange={repositories.onHeightChange}
          onHideSection={() => layout.onHide('repositories')}
          sectionActions={sectionMenu('repositories')}
          onAddRepository={repositories.onAdd}
          onRemoveRepository={repositories.onRemove}
          onExpandRepository={() => {}}
          canAddRepository={repositories.canAdd}
          onOpenFile={repositories.onOpenFile}
          onOpenFileInBrowserColumn={repositories.onOpenFileInBrowserColumn}
          viewMode="links"
          onOpenRepositoryList={repositories.onOpenList}
        />
      )}
      {!layout.hidden.includes('more') && (
        <NotebookMoreSection
          order={layout.order.indexOf('more') + 1}
          onHeightChange={more.onHeightChange}
          compactTopSpacing={more.compactTopSpacing}
          sectionActions={sectionMenu('more')}
        />
      )}
    </>
  );
}
