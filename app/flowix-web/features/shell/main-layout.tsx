'use client';

import { MainListColumnSection } from './components/main-list-column-section';
import { MainWorkColumns } from './components/main-work-columns';
import { MainLayoutStartupFailureOverlay } from './components/main-layout-startup-failure-overlay';

import { setMemoListViewPreference, useMemoListViewPreference } from '@features/preferences/public/runtime-api';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  navigateDocumentHistory,
  useDocumentCommands,
  useShellDocumentHistory,
  useShellDocumentViewModel,
  captureLatestDocumentContent,
  setDocumentEditorMode,
  useDocumentEditorMode,
  type DocumentEditorMode,
  type DocumentHistoryEntry,
} from '@features/document/public/shell-api';
import {
  MemoListServicesHost,
  useShellMemoViewModel,
  useAccessSpaceSelectionCount,
  useAccessSpaceSelectedPaths,
  useAccessSpaceSelectionContentKinds,
  type Notebook,
} from '@features/memo/public/shell-api';
import { useSettingsStore } from '@/lib/store/settings-store';
import { useWorkspaceStartupStore, isWorkspaceInteractive } from '@/lib/store/workspace-startup-store';
import { useShallow } from 'zustand/react/shallow';
import { isWindowsPlatform } from '@/lib/path';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import { SurfaceBoundary } from '@shared/surface-boundary';
import { NotebookDeleteDialog } from '@features/shell/components/notebook-delete-dialog';
import { ExternalFileDropOverlay } from '@features/shell/components/drag-overlay/external-file-drop-overlay';
import { useMainMiddleColumnController } from '@features/shell/hooks/use-main-middle-column-controller';
import { useMainPanelController } from '@features/shell/hooks/use-main-panel-controller';
import { useDefaultCreateFolder } from '@features/shell/hooks/use-default-create-folder';
import { useExternalFileDeletion } from '@features/shell/hooks/use-external-file-deletion';
import { useMediaActions } from '@features/shell/hooks/use-media-actions';
import { useWorkColumnPresentation } from '@features/shell/hooks/use-work-column-presentation';
import { useDocumentTitlebarProps } from '@features/shell/hooks/use-document-titlebar-props';
import { useProductIntro } from '@features/shell/hooks/use-product-intro';
import { useI18n } from '@/lib/i18n';
import type { AppUpdaterState } from '@features/shell/hooks/use-app-updater';
import type { DocumentSurfaceContext } from '@features/surface/public/shell-api';
import type { PluginDescriptor } from '@platform/tauri/client';
import {
  useShellWorkspaceViewModel,
  BROWSER_COLUMN_MIN_WIDTH,
  type WorkColumnTarget,
} from '@features/workspace/public/shell-api';
import type { Editor } from '@tiptap/core';
import { MainStatusBarHost } from '@features/shell/components/main-status-bar-host';
import { OnboardingScreen } from '@features/onboarding';
import { finishOnboardingNotebook } from '@features/shell/use-cases/finish-onboarding';
import { documentHistoryEntryKey } from '@features/document/public/shell-api';
import { historyEntryFromWorkColumnTarget } from '@features/workspace/public/shell-api';

const DOCUMENT_PANEL_MIN_WIDTH = BROWSER_COLUMN_MIN_WIDTH;

function isDifferentHistoryTarget(
  entry: DocumentHistoryEntry,
  currentWorkColumnTarget: WorkColumnTarget,
): boolean {
  return documentHistoryEntryKey(entry)
    !== documentHistoryEntryKey(historyEntryFromWorkColumnTarget(currentWorkColumnTarget));
}

export interface MainLayoutBusinessController {
  notebookToDelete: Notebook | null;
  notebookCreateRequest: number;
  cancelDeleteNotebook(): void;
  confirmDeleteNotebook(deleteLocalFiles: boolean): Promise<void>;
  createNotebook(): void;
  deleteNotebook(notebook: Notebook): void;
  editNotebook(notebook: Notebook): void;
  openPlugin(plugin: PluginDescriptor): Promise<void>;
  switchFolderCollectionType(target: {
    filePath: string;
    notebookPath: string;
    notebookId: string;
  }, type: 'table' | 'media_library'): Promise<void>;
  selectNotebook(notebook: Notebook): void;
}

export interface MainLayoutSystemController {
  onboardingOpen: boolean;
  onboardingLoading: boolean;
  updater: AppUpdaterState;
  hasPendingAppUpdateResult: boolean;
  presentPendingAppUpdateResult(): void;
  completeOnboarding(): Promise<void>;
}

export function MainLayout({
  business,
  system,
}: {
  business: MainLayoutBusinessController;
  system: MainLayoutSystemController;
}) {
  const { t, language } = useI18n();
  const [recentExportPath, setRecentExportPath] = useState<string | null>(null);
  const {
    notebookToDelete,
    notebookCreateRequest,
    cancelDeleteNotebook,
    confirmDeleteNotebook,
    createNotebook: handleCreateNotebook,
    deleteNotebook: handleDeleteNotebook,
    editNotebook: handleEditNotebook,
    openPlugin: handleOpenPlugin,
    switchFolderCollectionType: handleSwitchFolderCollectionType,
    selectNotebook: handleSelectNotebook,
  } = business;
  const {
    onboardingOpen,
    onboardingLoading,
    updater,
    hasPendingAppUpdateResult,
    presentPendingAppUpdateResult,
    completeOnboarding,
  } = system;
  const { productIntroOpen, setProductIntroOpen, showProductIntroAfterOnboarding } =
    useProductIntro({
      hasPendingAppUpdateResult,
      onboardingLoading,
      onboardingOpen,
      presentPendingAppUpdateResult,
    });
  // 切片订阅：每个 useStore 只取真正用到的字段，setter 走 useShallow 聚合。
  // 替代原来的 `useNoteStore()` / `useDocumentStore()` / `useSettingsStore()`
  // 全量订阅 —— 任何 set 都会让 MainLayout 整树重渲，跨菜单栏 / 状态栏 /
  // document 容器一起抖。切到 selector 后, 只在用到的字段变化时本组件
  // 才重渲, memo-list / document-container 各自独立订阅, 互不污染。
  const {
    selectedNotebook,
    startupPhase: memoStartupPhase,
    middleColumnView,
    activeFilter,
    activePluginId,
    activeSort,
    setActiveFilter,
    setMiddleColumnView,
    loadNotes,
    triggerRefresh,
  } = useShellMemoViewModel();
  const { defaultCreateFolderState, defaultCreateFolder, handleToggleDefaultFolder } =
    useDefaultCreateFolder(selectedNotebook);
  const memoListView = useMemoListViewPreference();
  const isAgentConversationView = middleColumnView === 'conversations';
  const {
    currentDocumentPath,
    activeExternalSession,
    isDocumentTransitioning,
  } = useShellDocumentViewModel();

  const {
    memoListVisible,
    noteNavigationVisible,
    toolbarCollapsed,
    setMemoListVisible,
    setNoteNavigationVisible,
    setToolbarCollapsed,
  } = useSettingsStore(
    useShallow((s) => ({
      memoListVisible: s.memoListVisible,
      noteNavigationVisible: s.noteNavigationVisible,
      toolbarCollapsed: s.toolbarCollapsed,
      setMemoListVisible: s.setMemoListVisible,
      setNoteNavigationVisible: s.setNoteNavigationVisible,
      setToolbarCollapsed: s.setToolbarCollapsed,
    })),
  );
  const {
    navigation: navigationState,
    browserColumnVisible,
    browserColumnSplitRatio,
    setBrowserColumnSplitRatio,
    focusedHostId,
    notebookSwitching,
  } = useShellWorkspaceViewModel();
  const interactive = useWorkspaceStartupStore(isWorkspaceInteractive);
  const nativeStartup = useWorkspaceStartupStore(useShallow((state) => ({
    phase: state.nativePhase,
    stage: state.nativeStage,
    step: state.nativeStep,
    error: state.nativeError,
  })));
  // Only the failure banner reads this store. Subscribing to the whole store
  // re-rendered the entire layout (memo list, titlebar, status bar) on every
  // startup progress tick.
  const workspaceStartup = useWorkspaceStartupStore(useShallow((state) => ({
    status: state.status,
    error: state.error,
  })));
  // Native error UI remains in the layout; the root overlay owns all loading visuals.
  const startupStatus = nativeStartup;
  const documentHistory = useShellDocumentHistory();
  const canNavigateBack = documentHistory.backStack.some((entry) => (
    isDifferentHistoryTarget(
      entry,
      navigationState.target,
    )
  ));
  const canNavigateForward = documentHistory.forwardStack.some((entry) => (
    isDifferentHistoryTarget(
      entry,
      navigationState.target,
    )
  ));
  const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(false);
  const accessSpaceSelectionCount = useAccessSpaceSelectionCount();
  const accessSpaceSelectedPaths = useAccessSpaceSelectedPaths();
  const accessSpaceSelectionContentKinds = useAccessSpaceSelectionContentKinds();
  const hasMultipleDocumentsSelected = accessSpaceSelectionCount > 1;
  const workColumnTarget = navigationState.target;
  const mediaTarget = workColumnTarget.kind === 'media' ? workColumnTarget : null;
  const activePlugin = workColumnTarget.kind === 'plugin-workbench'
    ? workColumnTarget.plugin
    : null;
  const currentDocumentContentRef = useRef('');
  const currentDocumentEditorRef = useRef<Editor | null>(null);
  const {
    browserColumnLayout,
    browserColumnLayoutKey,
    collapseMemoList,
    handleBrowserColumnResize,
    resizeMemoList,
    setIsDraggingListDivider,
    handleToggleMemoList,
    handleToggleNoteNavigation,
    openNoteNavigation,
    closeNoteNavigation,
    completeNoteNavigationClose,
    isDraggingListDivider,
    isMemoListAnimating,
    isMemoListHidden,
    memoColWidth,
    noteNavigationPhase,
  } = useMainPanelController({
    browserColumnSplitRatio,
    documentPanelMinWidth: DOCUMENT_PANEL_MIN_WIDTH,
    memoListVisible,
    noteNavigationVisible,
    setBrowserColumnSplitRatio,
    setMemoListVisible,
    setNoteNavigationVisible,
  });
  const handleOpenTagPanel = useCallback(() => {
    void setMemoListViewPreference('detailed');
    setMiddleColumnView('notes');
    openNoteNavigation();
  }, [openNoteNavigation, setMiddleColumnView]);
  const {
    shouldRenderAgentConversationList,
    showMemoListSurface,
    memoListPreviewVisible,
    memoListPreviewPhase,
    handleMemoListPreviewTriggerEnter,
    handleMemoListPreviewTriggerLeave,
    handleMemoListPreviewEnter,
    handleMemoListPreviewLeave,
    handleMemoListPreviewCompanionEnter,
    handleMemoListPreviewCompanionLeave,
    agentConversationListNode,
  } = useMainMiddleColumnController({
    onConversationListBack: () => {
      void setMemoListViewPreference('folders');
      setMiddleColumnView('notes');
    },
    isAgentConversationView,
    isMemoListHidden,
    noteNavigationPhase,
  });
  const currentFileIdentity = activeExternalSession?.fileIdentity ?? null;
  const currentDocumentInstanceKey = currentFileIdentity?.displayId ?? null;
  const mainMemoEditorIdentity = activeExternalSession
    ? {
        kind: 'md' as const,
        path: activeExternalSession.fileIdentity.path,
        displayId: activeExternalSession.fileIdentity.displayId,
      }
    : null;
  const mainEditorMode = useDocumentEditorMode(
    'main-third',
    mainMemoEditorIdentity ?? {
      kind: 'md',
      path: currentDocumentPath ?? '',
      displayId: activeExternalSession?.fileIdentity.displayId ?? 'inactive-external-display',
    },
  );
  const getCurrentDocumentContent = useCallback(() => currentDocumentContentRef.current, []);
  const getCurrentDocumentEditor = useCallback(() => currentDocumentEditorRef.current, []);
  const handleDocumentEditorReady = useCallback((editor: Editor | null) => {
    currentDocumentEditorRef.current = editor;
  }, []);
  const handleDocumentExported = useCallback((filePath: string) => {
    setRecentExportPath(filePath);
  }, []);
  const {
    handleCopyFullText,
    handleCopyLink,
    handleExportMarkdown,
    handleSaveAsTemplate,
    handleExportWord,
    handleExportPdf,
  } = useDocumentCommands({
    currentDocumentPath,
    getCurrentDocumentContent,
    getCurrentDocumentEditor,
    onExported: handleDocumentExported,
  });

  const { handleDeleteExternalFile } = useExternalFileDeletion();

  // The DocumentContainer owns the import hook because it needs the editor's contentRef and saveDoc.
  // The titlebar renders the path, so it receives the container API through this bridge.
  // Keep the setter memoized so the container effect does not rerun on each parent render.
  useEffect(() => {
    currentDocumentContentRef.current = '';
    currentDocumentEditorRef.current = null;
    setRecentExportPath(null);
  }, [currentDocumentInstanceKey]);

  // Reset search when switching memos because results belong to the current editor state.
  // Results from the previous memo are no longer relevant after the switch.
  useEffect(() => {
    setIsSearchPanelOpen(false);
  }, [currentDocumentInstanceKey]);

  const handleOpenTodos = useCallback(async () => {
    const nextFilter = activeFilter === 'todos' ? 'all' : 'todos';
    setMemoListVisible(true);
    void setMemoListViewPreference('detailed');
    setMiddleColumnView('notes');
    setActiveFilter(nextFilter);
    await loadNotes({
      notebookId: selectedNotebook?.id,
      filter: nextFilter,
      sort: activeSort,
    });
  }, [
    activeFilter,
    activeSort,
    loadNotes,
    selectedNotebook?.id,
    setActiveFilter,
    setMemoListVisible,
    setMiddleColumnView,
  ]);

  const handleNavigateBack = useCallback(() => {
    void navigateDocumentHistory('back');
  }, []);

  const handleNavigateForward = useCallback(() => {
    void navigateDocumentHistory('forward');
  }, []);

  const {
    handleCopyMediaLink,
    handleRevealMedia,
    handleRequestDeleteMedia,
  } = useMediaActions(mediaTarget);

  const handleSetMainEditorMode = useCallback((mode: DocumentEditorMode) => {
    if (!mainMemoEditorIdentity || mainEditorMode === mode) return;
    captureLatestDocumentContent(mainMemoEditorIdentity, 'main-third');
    setDocumentEditorMode('main-third', mainMemoEditorIdentity, mode);
  }, [mainEditorMode, mainMemoEditorIdentity]);
  const handleViewSourceMode = useCallback(() => handleSetMainEditorMode('source'), [handleSetMainEditorMode]);

  useEffect(() => {
    const handleViewSource = () => handleViewSourceMode();
    window.addEventListener('flowix:view-source-mode', handleViewSource);
    return () => window.removeEventListener('flowix:view-source-mode', handleViewSource);
  }, [handleViewSourceMode]);

  const workColumnDocument: DocumentSurfaceContext | null = currentDocumentPath && currentFileIdentity
    ? activeExternalSession ? {
          identity: {
            kind: 'external' as const,
            fileIdentity: activeExternalSession.fileIdentity,
            scopePath: activeExternalSession.scopePath,
            indexable: activeExternalSession.indexable,
            transitionId: activeExternalSession.transitionId,
          },
          instanceKey: activeExternalSession.fileIdentity.displayId,
          documentProps: {
            notebookId: activeExternalSession.notebookId ?? null,
            notebookPath: activeExternalSession.notebookPath ?? null,
            transitionId: activeExternalSession.transitionId,
            initialFocus: activeExternalSession.initialFocus,
            isExternalDocument: true,
            externalScopePath: activeExternalSession.scopePath,
            searchPanelOpen: isSearchPanelOpen,
            onSearchPanelOpenChange: setIsSearchPanelOpen,
            toolbarCollapsed,
            onToolbarCollapsedChange: setToolbarCollapsed,
            onMetainfoData: (data: { memoContent: string }) => {
              currentDocumentContentRef.current = data.memoContent;
            },
            onEditorReady: handleDocumentEditorReady,
          },
        } : null
    : null;
  const {
    workColumnPresentation,
    workRuntimePresentation,
    workSurfaceBlockingLoading,
    workSurfaceFailed,
    workCapabilities,
    workHeaderStyle,
    isAgentConversationDetail,
  } = useWorkColumnPresentation({
    navigation: navigationState,
    selectedNotebook,
    workColumnDocument,
    activePlugin,
    currentDocumentPath,
    currentDocumentContentRef,
  });
  const documentTitlebarProps = useDocumentTitlebarProps({
    workColumnPresentation,
    workRuntimePresentation,
    workCapabilities,
    workHeaderStyle,
    navigationState,
    browserColumnVisible,
    mainEditorMode,
    handleSetMainEditorMode,
    isMemoListHidden,
    noteNavigationVisible,
    handleToggleMemoList,
    canNavigateBack,
    canNavigateForward,
    handleNavigateBack,
    handleNavigateForward,
    handleCopyLink,
    handleCopyFullText,
    handleExportMarkdown,
    handleSaveAsTemplate,
    handleExportWord,
    handleExportPdf,
    handleDeleteExternalFile,
    mediaActions: mediaTarget ? {
      onCopyLink: handleCopyMediaLink,
      onRevealInFileManager: handleRevealMedia,
      onRequestDelete: handleRequestDeleteMedia,
    } : undefined,
    defaultCreateFolderState,
    defaultCreateFolder,
    handleToggleDefaultFolder,
    handleSwitchFolderCollectionType,
    activeExternalSession,
    selectedNotebook,
  });

  return (
    <div
      className="flowix-main-layout relative flex h-screen w-screen overflow-hidden"
      data-tauri-drag-region={!interactive || undefined}
      data-agent-conversation-view={isAgentConversationView || undefined}
      data-agent-conversation-detail={isAgentConversationDetail || undefined}
      style={{ backgroundColor: 'var(--frame-bg)' }}
    >
      <WindowsTitlebarControls />
      {/* Keep window controls and startup retry UI outside the business barrier. */}
      <div className="contents" inert={!interactive} aria-busy={!interactive}>
      {interactive && <ExternalFileDropOverlay />}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className={`relative flex flex-1 h-full overflow-hidden ${isWindowsPlatform() ? 'rounded-b-[12px]' : 'rounded-b-[18px]'} border-b border-[var(--divider)]`}>
          <MainListColumnSection
            noteNavigationPhase={noteNavigationPhase}
            selectedNotebook={selectedNotebook}
            activePluginId={activePluginId}
            handleOpenPlugin={handleOpenPlugin}
            closeNoteNavigation={closeNoteNavigation}
            completeNoteNavigationClose={completeNoteNavigationClose}
            handleMemoListPreviewCompanionEnter={handleMemoListPreviewCompanionEnter}
            handleMemoListPreviewCompanionLeave={handleMemoListPreviewCompanionLeave}
            isMemoListHidden={isMemoListHidden}
            memoListPreviewVisible={memoListPreviewVisible}
            memoListPreviewPhase={memoListPreviewPhase}
            memoColWidth={memoColWidth}
            isDraggingListDivider={isDraggingListDivider}
            collapseMemoList={collapseMemoList}
            expandSidebar={handleToggleMemoList}
            resizeMemoList={resizeMemoList}
            setIsDraggingListDivider={setIsDraggingListDivider}
            handleToggleNoteNavigation={handleToggleNoteNavigation}
            handleMemoListPreviewEnter={handleMemoListPreviewEnter}
            handleMemoListPreviewLeave={handleMemoListPreviewLeave}
            language={language}
            middleColumnView={middleColumnView}
            memoListView={memoListView}
            setMiddleColumnView={setMiddleColumnView}
            isAgentConversationView={isAgentConversationView}
            shouldRenderAgentConversationList={shouldRenderAgentConversationList}
            agentConversationListNode={agentConversationListNode}
          />
          <MainWorkColumns
            navigationState={navigationState}
            browserColumnVisible={browserColumnVisible}
            browserColumnLayout={browserColumnLayout}
            browserColumnLayoutKey={browserColumnLayoutKey}
            handleBrowserColumnResize={handleBrowserColumnResize}
            toolbarCollapsed={toolbarCollapsed}
            setToolbarCollapsed={setToolbarCollapsed}
            focusedHostId={focusedHostId}
            isMemoListHidden={isMemoListHidden}
            isMemoListAnimating={isMemoListAnimating}
            noteNavigationPhase={noteNavigationPhase}
            handleMemoListPreviewTriggerEnter={handleMemoListPreviewTriggerEnter}
            handleMemoListPreviewTriggerLeave={handleMemoListPreviewTriggerLeave}
            handleMemoListPreviewEnter={handleMemoListPreviewEnter}
            hasMultipleDocumentsSelected={hasMultipleDocumentsSelected}
            accessSpaceSelectionCount={accessSpaceSelectionCount}
            accessSpaceSelectedPaths={accessSpaceSelectedPaths}
            accessSpaceSelectionContentKinds={accessSpaceSelectionContentKinds}
            workColumnPresentation={workColumnPresentation}
            documentTitlebarProps={documentTitlebarProps}
            canNavigateBack={canNavigateBack}
            canNavigateForward={canNavigateForward}
            handleNavigateBack={handleNavigateBack}
            handleNavigateForward={handleNavigateForward}
            handleToggleMemoList={handleToggleMemoList}
            recentExportPath={recentExportPath}
            onDismissExportNotice={() => setRecentExportPath(null)}
            isDocumentTransitioning={isDocumentTransitioning}
            workSurfaceBlockingLoading={workSurfaceBlockingLoading}
            workSurfaceFailed={workSurfaceFailed}
            notebookSwitching={notebookSwitching}
            language={language}
          />
          </div>
          {/* Status bar */}
          <SurfaceBoundary name="status-bar" language={language}>
            <MainStatusBarHost
              onSelectNotebook={handleSelectNotebook}
              onEditNotebook={handleEditNotebook}
              onDeleteNotebook={handleDeleteNotebook}
              onCreateNotebook={handleCreateNotebook}
              onOpenTodos={handleOpenTodos}
              onOpenTagPanel={handleOpenTagPanel}
              productIntroOpen={productIntroOpen}
              onProductIntroOpenChange={setProductIntroOpen}
              updater={updater}
            />
          </SurfaceBoundary>
        </div>
      </div>

      <NotebookDeleteDialog
        key={notebookToDelete?.id ?? 'closed'}
        target={notebookToDelete ? { id: notebookToDelete.id, name: notebookToDelete.name } : null}
        onCancel={cancelDeleteNotebook}
        onConfirm={confirmDeleteNotebook}
      />

      <MemoListServicesHost
        notebookCreateRequest={notebookCreateRequest}
        onRefresh={triggerRefresh}
        suppressEmptyNotebookPrompt={onboardingLoading || onboardingOpen}
      />

      </div>

      {(startupStatus.phase === 'failed'
        || workspaceStartup.status === 'failed'
        || (memoStartupPhase === 'error' && (!showMemoListSurface || isMemoListHidden))) && (
        <MainLayoutStartupFailureOverlay
          startupStatus={startupStatus}
          workspaceStartup={workspaceStartup}
        />
      )}

      {onboardingOpen && (
        <OnboardingScreen
          onFinish={async (notebook, { startImport, templateId }) => {
            await finishOnboardingNotebook(notebook, { startImport, templateId }, {
              completeOnboarding,
              failureTitle: t('notebook.setup.failed'),
              retryLabel: t('error.retry'),
              overwriteConfirmMessage: t('notebook.template.overwriteConfirm'),
            });
            showProductIntroAfterOnboarding();
          }}
        />
      )}
    </div>
  );
}
