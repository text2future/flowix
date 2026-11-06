import type { ReactNode } from 'react';

import { windows } from '@platform/tauri/client';
import { setMemoListViewPreference } from '@features/preferences/public/runtime-api';
import { focusWorkspaceColumnFromEvent } from '@features/workspace/public/host-api';
import { MemoList } from '@features/memo/public/shell-api';
import type { Notebook } from '@features/memo/public/shell-api';
import { ColumnResizeHandle } from './column-resize-handle';
import { ListColumn } from './list-column';
import { ListColumnContent } from './list-column-content';
import { SurfaceBoundary } from '@shared/surface-boundary';
import type { useMainPanelController } from '@features/shell/hooks/use-main-panel-controller';
import type { useMemoListViewPreference } from '@features/preferences/public/runtime-api';
import type { useShellMemoViewModel } from '@features/memo/public/shell-api';

type MiddleColumnView = ReturnType<typeof useShellMemoViewModel>['middleColumnView'];
type MemoListView = ReturnType<typeof useMemoListViewPreference>;
type Language = 'zh-CN' | 'en-US';

export interface MainListColumnSectionProps {
  selectedNotebook: Notebook | null;
  isMemoListHidden: boolean;
  memoListPreviewVisible: boolean;
  memoListPreviewPhase: string;
  memoColWidth: number;
  isDraggingListDivider: boolean;
  collapseMemoList: () => void;
  expandSidebar: () => void;
  resizeMemoList: ReturnType<typeof useMainPanelController>['resizeMemoList'];
  setIsDraggingListDivider: (value: boolean) => void;
  handleMemoListPreviewEnter: () => void;
  handleMemoListPreviewLeave: () => void;
  language: Language;
  middleColumnView: MiddleColumnView;
  memoListView: MemoListView;
  setMiddleColumnView: (view: MiddleColumnView) => void;
  isAgentConversationView: boolean;
  shouldRenderAgentConversationList: boolean;
  agentConversationListNode: ReactNode;
}

/**
 * Left section of the main layout: the list column (one mounted subtree shared by the docked sidebar and hover
 * preview), and the list <-> detail divider.
 */
export function MainListColumnSection({
  selectedNotebook,
  isMemoListHidden,
  memoListPreviewVisible,
  memoListPreviewPhase,
  memoColWidth,
  isDraggingListDivider,
  collapseMemoList,
  expandSidebar,
  resizeMemoList,
  setIsDraggingListDivider,
  handleMemoListPreviewEnter,
  handleMemoListPreviewLeave,
  language,
  middleColumnView,
  memoListView,
  setMiddleColumnView,
  isAgentConversationView,
  shouldRenderAgentConversationList,
  agentConversationListNode,
}: MainListColumnSectionProps) {
  return (
    <>
    {/* List column: one mounted subtree shared by the docked sidebar and hover preview. */}
    <ListColumn
      hidden={isMemoListHidden}
      previewVisible={memoListPreviewVisible}
      previewPhase={memoListPreviewPhase === 'open' ? 'open' : 'closing'}
      memoColWidth={memoColWidth}
      isDraggingListDivider={isDraggingListDivider}
      selectedNotebook={selectedNotebook}
      onCollapseMemoList={collapseMemoList}
      onExpandSidebar={expandSidebar}
      onOpenPreferences={(tab) => void windows.openPreferences(tab)}
      onPreviewEnter={handleMemoListPreviewEnter}
      onPreviewLeave={handleMemoListPreviewLeave}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const target = event.target;
        if (target instanceof Element && target.closest('[data-folder-selection]')) return;
        focusWorkspaceColumnFromEvent(event, 'column-1');
      }}
    >
      <SurfaceBoundary
        name="memo-list"
        language={language}
        resetKeys={[selectedNotebook?.id ?? null]}
      >
      <ListColumnContent
        activeView={middleColumnView === 'conversations'
          ? 'conversations'
          : memoListView === 'folders' ? 'folders' : 'cards'}
        onViewChange={(view) => {
          if (view === 'conversations') {
            setMiddleColumnView('conversations');
            return;
          }
          void setMemoListViewPreference(view === 'folders' ? 'folders' : 'detailed');
          setMiddleColumnView('notes');
        }}
        conversationList={shouldRenderAgentConversationList ? agentConversationListNode : undefined}
      >
        <MemoList
          isActive={!isAgentConversationView}
          dataLoadingEnabled={!isAgentConversationView}
        />
      </ListColumnContent>
      </SurfaceBoundary>
    </ListColumn>
    {/* List <-> Memo detail divider */}
    {!isMemoListHidden && (
      <div className="relative z-[60] h-full w-px shrink-0 bg-[var(--divider)]">
        <ColumnResizeHandle label="调整列表列宽度" width={memoColWidth} onResize={resizeMemoList} onDraggingChange={setIsDraggingListDivider} />
      </div>
    )}
    </>
  );
}
