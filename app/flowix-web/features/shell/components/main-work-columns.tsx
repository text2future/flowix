import { useWorkspaceSessionStore } from '@features/workspace/public/session-api';
import { useBrowserColumnViewModel } from '@features/workspace/public/browser-column-api';
import { SessionHostProvider, type SessionHostEnvironment } from './session-host-environment';
import { ColumnResizeHandle } from './column-resize-handle';
import { resolveWorkspaceHeaderModel } from '@features/workspace/public/header-api';
import { lazy, Suspense, type CSSProperties } from 'react';

import { isWindowsPlatform } from '@/lib/path';
import { useI18n } from '@/lib/i18n';
import { useCollectionBannerControl } from '@/lib/collection-banner-visibility';
import { focusWorkspaceHostFromEvent } from '@features/workspace/public/host-api';
import { workspaceSurfaceUsesCollectionFrame } from '@features/workspace/public/surface-api';
import {
  DocumentTitlebarWin,
  DocumentTitlebarMac,
  type DocumentTitlebarProps,
} from '@features/document/public/shell-api';
import {
  collectionIndexPath,
  WorkColumnContentHost,
  type WorkColumnPresentation,
} from '@features/surface/public/shell-api';
import type {
  useShellWorkspaceViewModel,
} from '@features/workspace/public/shell-api';
import { BROWSER_COLUMN_MIN_WIDTH } from '@features/workspace/public/shell-api';
import { WorkColumnTitlebar } from './work-column-titlebar';
import { WorkColumnSelectionView } from './work-column-selection-view';
import { MainLayoutExportNotice } from './main-layout-export-notice';
import { MemoListPreviewEdgeTrigger } from './memo-list-preview-edge-trigger';
import { SurfaceBoundary } from '@shared/surface-boundary';
import { CenteredLoadingSpinner } from '@shared/ui/centered-loading-spinner';
import type { useMainPanelController } from '@features/shell/hooks/use-main-panel-controller';
import type { useAccessSpaceSelectedPaths, useAccessSpaceSelectionContentKinds } from '@features/memo/public/shell-api';

// Agent 标题栏按需加载：只在工作区当前目标是 Agent 会话时渲染，冷启动打开
// 文档时用不到。它背后是 agent-session-store（约 220 文件 / 3.3 万行）。
const AgentConversationTitlebar = lazy(() =>
  import('@features/agent/public/titlebar-api').then((module) => ({
    default: module.AgentConversationTitlebar,
  })),
);

const BrowserColumn = lazy(() =>
  import('./browser-column').then((module) => ({
    default: module.BrowserColumn,
  })),
);

const DOCUMENT_PANEL_MIN_WIDTH = BROWSER_COLUMN_MIN_WIDTH;

type WorkspaceNavigation = ReturnType<typeof useShellWorkspaceViewModel>['navigation'];

export interface MainWorkColumnsProps {
  navigationState: WorkspaceNavigation;
  browserColumnVisible: boolean;
  browserColumnLayout: ReturnType<typeof useMainPanelController>['browserColumnLayout'];
  browserColumnLayoutKey: ReturnType<typeof useMainPanelController>['browserColumnLayoutKey'];
  handleBrowserColumnResize: ReturnType<typeof useMainPanelController>['handleBrowserColumnResize'];
  toolbarCollapsed: boolean;
  setToolbarCollapsed: (value: boolean) => void;
  focusedHostId: ReturnType<typeof useShellWorkspaceViewModel>['focusedHostId'];
  isMemoListHidden: boolean;
  isMemoListAnimating: boolean;
  noteNavigationPhase: ReturnType<typeof useMainPanelController>['noteNavigationPhase'];
  handleMemoListPreviewTriggerEnter: () => void;
  handleMemoListPreviewTriggerLeave: () => void;
  handleMemoListPreviewEnter: () => void;
  hasMultipleDocumentsSelected: boolean;
  accessSpaceSelectionCount: number;
  accessSpaceSelectedPaths: ReturnType<typeof useAccessSpaceSelectedPaths>;
  accessSpaceSelectionContentKinds: ReturnType<typeof useAccessSpaceSelectionContentKinds>;
  workColumnPresentation: WorkColumnPresentation;
  documentTitlebarProps: DocumentTitlebarProps;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  handleNavigateBack: () => void;
  handleNavigateForward: () => void;
  handleToggleMemoList: () => void;
  recentExportPath: string | null;
  onDismissExportNotice: () => void;
  isDocumentTransitioning: boolean;
  workSurfaceBlockingLoading: boolean;
  workSurfaceFailed: boolean;
  notebookSwitching: boolean;
  language: 'zh-CN' | 'en-US';
}

/**
 * Work area of the main layout: the memo detail column (titlebar switch,
 * content host, export notice, loading state) and the optional browser
 * column. Owns the startup-chunk boundaries for the lazily loaded agent
 * titlebar and browser column.
 */
export function MainWorkColumns({
  navigationState,
  browserColumnVisible,
  browserColumnLayout,
  browserColumnLayoutKey,
  handleBrowserColumnResize,
  toolbarCollapsed,
  setToolbarCollapsed,
  focusedHostId,
  isMemoListHidden,
  isMemoListAnimating,
  noteNavigationPhase,
  handleMemoListPreviewTriggerEnter,
  handleMemoListPreviewTriggerLeave,
  handleMemoListPreviewEnter,
  hasMultipleDocumentsSelected,
  accessSpaceSelectionCount,
  accessSpaceSelectedPaths,
  accessSpaceSelectionContentKinds,
  workColumnPresentation,
  documentTitlebarProps,
  canNavigateBack,
  canNavigateForward,
  handleNavigateBack,
  handleNavigateForward,
  handleToggleMemoList,
  recentExportPath,
  onDismissExportNotice,
  isDocumentTransitioning,
  workSurfaceBlockingLoading,
  workSurfaceFailed,
  notebookSwitching,
  language,
}: MainWorkColumnsProps) {
  const { t } = useI18n();
  const primaryAtWork = useWorkspaceSessionStore((state) => state.hosts['main-third'] === 'primary-session');
  const { current: browserCurrent } = useBrowserColumnViewModel();
  const environment = (host: SessionHostEnvironment['host']): SessionHostEnvironment => ({
    host, browserVisible: browserColumnVisible, sidebarHidden: isMemoListHidden,
    navigationVisible: noteNavigationPhase !== 'closed', onToggleSidebar: handleToggleMemoList,
  });
  const selectionLabel = t('memo.fileTree.selectedDocumentCount', { count: accessSpaceSelectionCount });
  /**
   * 集合头图可见时，内容区上穿共享标题栏高度，让头图
   * 顶部从标题栏下方经过；隐藏头图后撤掉上移，集合内容从标题栏下方正常开始。
   * 集合内部的吸顶偏移（tab 条 / 表头）引用 `--work-titlebar-h`，随负 margin 一起开关。
   */
  const isCollectionShellSurface = workColumnPresentation.content.status === 'surface'
    && workspaceSurfaceUsesCollectionFrame(workColumnPresentation.contentKind);
  const collectionPath = collectionIndexPath(workColumnPresentation.content.status === 'surface'
    ? workColumnPresentation.content.surface : null);
  const collectionBanner = useCollectionBannerControl(collectionPath);
  // Registry 尚未就绪时按默认可见处理，避免集合初次渲染时内容短暂跳位。
  const collectionBannerVisible = !collectionBanner.available || collectionBanner.visible;
  const workTitlebarH = isCollectionShellSurface && collectionBannerVisible
    ? 'var(--window-titlebar-height)'
    : null;
  const contentHostStyle: CSSProperties | undefined = hasMultipleDocumentsSelected
    ? { display: 'none' }
    : workTitlebarH
      ? ({ marginTop: `calc(0px - ${workTitlebarH})`, '--work-titlebar-h': workTitlebarH } as CSSProperties)
      : undefined;
  return (
    <>
    {/* Keep the drop overlay outside the scrolling columns so it covers the viewport. */}
    <div
      data-workspace-drop-overlay-host
      className="relative isolate flex min-h-0 min-w-0 flex-1 overflow-hidden"
    >
    <div
      data-document-columns-layout="split"
      className="relative isolate grid min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
      style={{ gridTemplateColumns: browserColumnVisible
        ? `${browserColumnLayout.mainColumnWidth}px ${browserColumnLayout.browserColumnWidth}px`
        : 'minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1fr)' }}
    >
    {isMemoListHidden && (
      <MemoListPreviewEdgeTrigger
        onTriggerEnter={handleMemoListPreviewTriggerEnter}
        onTriggerLeave={handleMemoListPreviewTriggerLeave}
        onPreviewOpen={handleMemoListPreviewEnter}
        ariaLabel={t('document.titlebar.showSidebar')}
        title={t('document.titlebar.showSidebarTooltip')}
      />
    )}
    <SessionHostProvider value={environment(primaryAtWork ? 'main-third' : 'browser-column')}>
      <div
        className={`relative h-full min-w-0 flex flex-col bg-[var(--document-bg)]${
          browserColumnVisible && isMemoListAnimating
            ? ' transition-[flex-basis] flowix-motion'
            : ''
        }`}
        style={{
          minWidth: DOCUMENT_PANEL_MIN_WIDTH, gridColumn: primaryAtWork ? 1 : 2, gridRow: 1,
          display: !primaryAtWork && !browserColumnVisible ? 'none' : undefined,
          borderLeft: !primaryAtWork ? '1px solid var(--divider)' : undefined,
        }}
        data-workspace-host={primaryAtWork ? 'main-third' : 'browser-column'}
        data-workspace-session="primary-session"
        data-workspace-focused={focusedHostId === 'main-third' ? '' : undefined}
        onPointerDown={(event) => {
          focusWorkspaceHostFromEvent(event, 'main-third');
        }}
        onFocusCapture={(event) => focusWorkspaceHostFromEvent(event, 'main-third')}
      >
      {/* Fixed top navigation bar */}
      {hasMultipleDocumentsSelected ? (
        <WorkColumnTitlebar
          isWindows={isWindowsPlatform()}
          reserveWindowsControls={!browserColumnVisible}
          showTrafficLightSpacer={isMemoListHidden && noteNavigationPhase === 'closed'}
        >
          {null}
        </WorkColumnTitlebar>
      ) : workColumnPresentation.header.kind === 'agent' ? (
        // 占位用同一套 titlebar 容器（含 Windows 控件预留与红绿灯 spacer），
        // 保证 chunk 到达前后没有高度跳变；内容为空即可。
        <Suspense
          fallback={(
            <WorkColumnTitlebar
              isWindows={isWindowsPlatform()}
              reserveWindowsControls={!browserColumnVisible}
              showTrafficLightSpacer={isMemoListHidden && noteNavigationPhase === 'closed'}
              className="agent-conversation-titlebar"
              header={resolveWorkspaceHeaderModel({ chrome: 'agent' })}
            >
              {null}
            </WorkColumnTitlebar>
          )}
        >
          <AgentConversationTitlebar
            instanceId={workColumnPresentation.header.instanceId}
            reserveWindowsControls={!browserColumnVisible}
            isMiddleColumnCollapsed={isMemoListHidden}
            isSidebarVisible={noteNavigationPhase !== 'closed'}
            onExpandSidebar={handleToggleMemoList}
            canNavigateBack={canNavigateBack}
            canNavigateForward={canNavigateForward}
            onNavigateBack={handleNavigateBack}
            onNavigateForward={handleNavigateForward}
          />
        </Suspense>
      ) : isWindowsPlatform() ? (
        <DocumentTitlebarWin {...documentTitlebarProps} />
      ) : (
        <DocumentTitlebarMac {...documentTitlebarProps} />
      )}

      {/* Content area */}
      {hasMultipleDocumentsSelected && (
        <WorkColumnSelectionView paths={accessSpaceSelectedPaths} contentKinds={accessSpaceSelectionContentKinds} label={selectionLabel} />
      )}
      <div className="relative isolate flex-1 min-w-0 overflow-hidden" hidden={hasMultipleDocumentsSelected}
        style={contentHostStyle}>
        {recentExportPath && workColumnPresentation.header.kind === 'document' && (
          <MainLayoutExportNotice
            recentExportPath={recentExportPath}
            onDismiss={onDismissExportNotice}
          />
        )}
        <SurfaceBoundary
          name="work-column"
          language={language}
          resetKeys={[JSON.stringify(navigationState.target)]}
        >
          <WorkColumnContentHost
            webAddressBarVisible={documentTitlebarProps.webAddressBarVisible ?? false}
            content={workColumnPresentation.content}
            focused={!hasMultipleDocumentsSelected && focusedHostId === 'main-third'}
            startupIdentity={JSON.stringify(navigationState.target)}
          />
        </SurfaceBoundary>
        {((isDocumentTransitioning && !workSurfaceFailed)
          || workSurfaceBlockingLoading
          || (navigationState.phase === 'loading' && navigationState.showWorkColumnLoading)) && (
          <CenteredLoadingSpinner
            className="pointer-events-none absolute inset-0 z-40"
            label={notebookSwitching ? t('memo.navigation.preparingNotebook') : undefined}
          />
        )}
      </div>
    </div>
    </SessionHostProvider>
    {(browserColumnVisible || !primaryAtWork || browserCurrent !== null) && (
      <Suspense fallback={null}>
        <SurfaceBoundary
          name="browser-column"
          language={language}
          resetKeys={[browserColumnLayoutKey]}
        >
          <SessionHostProvider value={environment(primaryAtWork ? 'browser-column' : 'main-third')}>
          <BrowserColumn
            width={primaryAtWork ? browserColumnLayout.browserColumnWidth : browserColumnLayout.mainColumnWidth}
            layoutKey={browserColumnLayoutKey}
            onResize={handleBrowserColumnResize}
            toolbarCollapsed={toolbarCollapsed}
            onToolbarCollapsedChange={setToolbarCollapsed}
            animated={isMemoListAnimating}
          />
          </SessionHostProvider>
        </SurfaceBoundary>
      </Suspense>
    )}
    {browserColumnVisible && (
      <div className="absolute inset-y-0 z-[70]" style={{ left: browserColumnLayout.mainColumnWidth }}>
        <ColumnResizeHandle label="调整浏览器列宽度" width={browserColumnLayout.browserColumnWidth}
          direction={-1} onResize={handleBrowserColumnResize} />
      </div>
    )}
    </div>
    </div>
    </>
  );
}
