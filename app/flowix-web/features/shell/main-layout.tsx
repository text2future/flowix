'use client';

import { lazy, Suspense, useState, useEffect, useRef, useCallback } from 'react';
import {
  DocumentTitlebarWin,
  DocumentTitlebarMac,
  navigateDocumentHistory,
  useDocumentCommands,
  useShellDocumentHistory,
  useShellDocumentViewModel,
  type DocumentHistoryEntry,
  type MemoDocumentSession,
} from '@features/document/public/shell-api';
import {
  MemoList,
  MemoListServicesHost,
  MemoListTitlebarMac,
  MemoListTitlebarWin,
  NoteNavigationDrawer,
  useNotebookTodoCount,
  useShellMemoViewModel,
  type MemoItem,
  type Notebook,
} from '@features/memo/public/shell-api';
import { AgentConversationTitlebar } from '@features/agent/public/shell-api';
import { useSettingsStore } from '@features/shell';
import { useShallow } from 'zustand/react/shallow';
import {
  windows,
  type DshDownloadProgress,
} from '@platform/tauri/client';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import { canonicalPath, getDocumentInstanceKey } from '@/lib/path';
import { NotebookDeleteDialog } from '@features/shell/components/notebook-delete-dialog';
import { MarkdownFileDropOverlay } from '@features/shell/components/drag-overlay/markdown-file-drop-overlay';
import { useDeferredUnmount } from '@features/shell/hooks/use-deferred-unmount';
import { useMainMiddleColumnController } from '@features/shell/hooks/use-main-middle-column-controller';
import { useMainPanelController } from '@features/shell/hooks/use-main-panel-controller';
import { useI18n } from '@/lib/i18n';
import type { DshRuntimeInstallerState } from '@features/preferences/public/system-api';
import type { AppUpdaterState } from '@features/shell/hooks/use-app-updater';
import {
  WorkColumnSurfaceHost,
  getWorkColumnSurfaceDefinition,
  resolveWorkColumnSurface,
  surfaceSupports,
} from '@features/surface/public/shell-api';
import type { PluginDescriptor } from '@platform/tauri/client';
import {
  useShellWorkspaceViewModel,
  BROWSER_COLUMN_MIN_WIDTH,
  type WorkColumnTarget,
} from '@features/workspace/public/shell-api';
import { MainStatusBarHost } from '@features/shell/components/main-status-bar-host';
import { MainPromptHost } from '@features/shell/components/main-prompt-host';

const DOCUMENT_PANEL_MIN_WIDTH = BROWSER_COLUMN_MIN_WIDTH;

const BrowserColumn = lazy(() =>
  import('@features/shell/components/browser-column').then((module) => ({
    default: module.BrowserColumn,
  })),
);

function isWindowsPlatform(): boolean {
  return /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform);
}

function isDifferentHistoryTarget(
  entry: DocumentHistoryEntry,
  currentWorkColumnTarget: WorkColumnTarget,
  activeMemoSession: MemoDocumentSession | null,
  currentDocumentSource: 'memo' | 'external' | null,
  currentDocumentPath: string | null,
  activeAgentConversationId: string | null,
): boolean {
  if (currentWorkColumnTarget.kind === 'artifact') {
    return entry.kind !== 'artifact'
      || entry.pointerMemoId !== currentWorkColumnTarget.pointerMemoId;
  }
  if (entry.kind === 'artifact') return true;
  if (currentWorkColumnTarget.kind === 'agent-conversation') {
    return entry.kind !== 'agent-conversation'
      || entry.instanceId !== currentWorkColumnTarget.instanceId;
  }
  if (entry.kind === 'agent-conversation') {
    return entry.instanceId !== activeAgentConversationId;
  }
  if (entry.kind === 'memo') {
    return !activeMemoSession || (
      entry.memoId !== activeMemoSession.memoId ||
      canonicalPath(entry.path) !== canonicalPath(activeMemoSession.path)
    );
  }
  return currentDocumentSource !== 'external' || canonicalPath(entry.path) !== canonicalPath(currentDocumentPath ?? '');
}

export interface MainLayoutBusinessController {
  notebookToDelete: Notebook | null;
  notebookCreateRequest: number;
  cancelDeleteNotebook(): void;
  confirmDeleteNotebook(): Promise<void>;
  createNotebook(): void;
  deleteNotebook(notebook: Notebook): void;
  editNotebook(notebook: Notebook): void;
  openPlugin(plugin: PluginDescriptor): Promise<void>;
  selectNotebook(notebook: Notebook): void;
}

export interface MainLayoutSystemController {
  dshDownload: DshDownloadProgress | null;
  dshInstallPromptOpen: boolean;
  updater: AppUpdaterState;
  dshInstaller: DshRuntimeInstallerState;
  closeDshInstallPrompt(): void;
  markDshIntroDisplayed(): void;
  completeDshInstallPrompt(): void;
}

export function MainLayout({
  business,
  system,
}: {
  business: MainLayoutBusinessController;
  system: MainLayoutSystemController;
}) {
  const { t } = useI18n();
  const {
    notebookToDelete,
    notebookCreateRequest,
    cancelDeleteNotebook,
    confirmDeleteNotebook,
    createNotebook: handleCreateNotebook,
    deleteNotebook: handleDeleteNotebook,
    editNotebook: handleEditNotebook,
    openPlugin: handleOpenPlugin,
    selectNotebook: handleSelectNotebook,
  } = business;
  const {
    dshDownload,
    dshInstallPromptOpen,
    updater,
    dshInstaller,
    closeDshInstallPrompt: handleDshPromptClose,
    markDshIntroDisplayed: handleDshIntroDisplayed,
    completeDshInstallPrompt: handleDshInstalled,
  } = system;
  // 切片订阅：每个 useStore 只取真正用到的字段，setter 走 useShallow 聚合。
  // 替代原来的 `useMemoStore()` / `useDocumentStore()` / `useSettingsStore()`
  // 全量订阅 —— 任何 set 都会让 MainLayout 整树重渲，跨菜单栏 / 状态栏 /
  // document 容器一起抖。切到 selector 后, 只在用到的字段变化时本组件
  // 才重渲, memo-list / document-container 各自独立订阅, 互不污染。
  const {
    memos,
    notebooks,
    selectedMemo,
    selectedNotebook,
    middleColumnView,
    activeFilter,
    activePluginId,
    activeSort,
    setActiveFilter,
    loadMemos,
    triggerRefresh,
    updateMemoMeta,
    setMemoColors,
  } = useShellMemoViewModel();
  const isAgentConversationView = middleColumnView === 'conversations';
  const {
    currentDocumentPath,
    currentDocumentSource,
    activeAgentConversationId,
    activeMemoSession,
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
    focusWorkspaceHost,
    focusedHostId,
  } = useShellWorkspaceViewModel();
  const documentHistory = useShellDocumentHistory();
  const canNavigateBack = documentHistory.backStack.some((entry) => (
    isDifferentHistoryTarget(
      entry,
      navigationState.target,
      activeMemoSession,
      currentDocumentSource,
      currentDocumentPath,
      activeAgentConversationId,
    )
  ));
  const canNavigateForward = documentHistory.forwardStack.some((entry) => (
    isDifferentHistoryTarget(
      entry,
      navigationState.target,
      activeMemoSession,
      currentDocumentSource,
      currentDocumentPath,
      activeAgentConversationId,
    )
  ));
  const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(false);
  const workColumnTarget = navigationState.target;
  const activePlugin = workColumnTarget.kind === 'plugin-workbench'
    ? workColumnTarget.plugin
    : null;
  const currentDocumentContentRef = useRef('');
  const memoListMounted = useDeferredUnmount(memoListVisible);
  const {
    browserColumnLayout,
    browserColumnLayoutKey,
    collapseMemoList,
    handleBrowserColumnResize,
    handleListDividerMouseDown,
    handleToggleMemoList,
    handleToggleNoteNavigation,
    isDraggingListDivider,
    isMemoListHidden,
    memoColWidth,
    memoListWidth,
  } = useMainPanelController({
    browserColumnSplitRatio,
    documentPanelMinWidth: DOCUMENT_PANEL_MIN_WIDTH,
    memoListVisible,
    noteNavigationVisible,
    setBrowserColumnSplitRatio,
    setMemoListVisible,
    setNoteNavigationVisible,
  });
  const {
    agentConversationListReady,
    shouldRenderAgentConversationList,
    showMemoListSurface,
    showAgentConversationSurface,
    memoListPreviewVisible,
    memoListPreviewPhase,
    handleMemoListPreviewTriggerEnter,
    handleMemoListPreviewTriggerLeave,
    handleMemoListPreviewEnter,
    handleMemoListPreviewLeave,
    agentConversationListNode,
  } = useMainMiddleColumnController({
    isAgentConversationView,
    isMemoListHidden,
  });
  const documentTitlebarHeight = isWindowsPlatform() ? 36 : 48;

  const currentMemo = currentDocumentPath && currentDocumentSource === 'memo' && activeMemoSession
    ? memos.find((memo) => memo.id === activeMemoSession.memoId)
      ?? (selectedMemo?.id === activeMemoSession.memoId ? selectedMemo : null)
    : null;
  const isExternalDocument = currentDocumentSource === 'external';
  const currentDocumentInstanceKey =
    currentDocumentSource === 'memo' && activeMemoSession
      ? activeMemoSession.id
      : activeExternalSession?.id ?? (currentDocumentPath ? getDocumentInstanceKey(currentDocumentPath) : null);
  const todoCount = useNotebookTodoCount(selectedNotebook?.id);
  const getCurrentDocumentContent = useCallback(() => currentDocumentContentRef.current, []);
  const {
    handleCopyFullText,
    handleCopyLink,
    handleTogglePin,
    handleColorsChange,
    handleExportMarkdown,
    handleSaveAsTemplate,
    handleExportWord,
  } = useDocumentCommands({
    currentDocumentPath,
    getCurrentDocumentContent,
    currentMemo,
    updateMemoMeta,
    setMemoColors,
  });

  // The DocumentContainer owns the import hook (it needs the editor's
  // contentRef + saveDoc) but the titlebar renders the file path and the
  // "保存为笔记" button. We bridge them: container publishes its api upward
  // via onExternalImportApiChange, we hold it here, and feed it to the
  // titlebar. The setter is memoized so the container's effect doesn't
  // re-fire on every parent render.
  useEffect(() => {
    currentDocumentContentRef.current = '';
  }, [currentDocumentInstanceKey]);

  // 切换 memo 时关闭搜索面板 — 搜索/替换的 matches 是基于当前 editor state,
  // 切到新 memo 后旧结果毫无意义, 应当随切换重置。
  useEffect(() => {
    setIsSearchPanelOpen(false);
  }, [currentDocumentInstanceKey]);

  const handleOpenTodos = useCallback(async () => {
    const nextFilter = activeFilter === 'todos' ? 'all' : 'todos';
    setMemoListVisible(true);
    setActiveFilter(nextFilter);
    await loadMemos({
      notebookId: selectedNotebook?.id,
      filter: nextFilter,
      sort: activeSort,
    });
  }, [activeFilter, activeSort, loadMemos, selectedNotebook?.id, setActiveFilter, setMemoListVisible]);

  // 状态栏 Agents 星标: 打开中间列展示 AgentConversationList,
  // 已在 agents 视图则 no-op, 不再回退。
  const handleOpenAgentConversationView = useCallback(() => {
    if (isAgentConversationView) return;
    setActiveFilter('agents');
    setMemoListVisible(true);
  }, [isAgentConversationView, setActiveFilter, setMemoListVisible]);

  const handleNavigateBack = useCallback(() => {
    void navigateDocumentHistory('back');
  }, []);

  const handleNavigateForward = useCallback(() => {
    void navigateDocumentHistory('forward');
  }, []);

  // Document titlebar's more → delete menu: hand off to the application-level
  // MemoListServicesHost through a custom event. MainLayout stays independent
  // from the dialog state and MemoList remains a visual list only.
  const handleRequestDeleteMemo = useCallback(() => {
    if (!currentMemo) return;
    window.dispatchEvent(
      new CustomEvent<MemoItem>('flowix:request-delete-memo', { detail: currentMemo })
    );
  }, [currentMemo]);

  const handleOpenNoteProperties = useCallback(() => {
    if (!currentMemo) return;
    window.dispatchEvent(
      new CustomEvent('flowix:open-note-properties', { detail: { memoId: currentMemo.id } })
    );
  }, [currentMemo]);

  const workColumnDocument = currentDocumentPath
    ? {
        identity: activeMemoSession
          ? {
              kind: 'memo' as const,
              memoId: activeMemoSession.memoId,
              path: activeMemoSession.path,
              notebookId: activeMemoSession.notebookId,
              notebookPath: activeMemoSession.notebookPath,
              transitionId: activeMemoSession.transitionId,
            }
          : {
              kind: 'external' as const,
              path: activeExternalSession?.path ?? currentDocumentPath,
              scopePath: activeExternalSession?.scopePath ?? null,
              transitionId: activeExternalSession?.transitionId ?? null,
            },
        memo: currentMemo,
        markdown: {
          kind: 'markdown' as const,
          instanceKey: currentDocumentInstanceKey ?? getDocumentInstanceKey(currentDocumentPath),
          props: {
            filePath: currentDocumentPath,
            memoId: activeMemoSession?.memoId ?? null,
            notebookId: activeMemoSession?.notebookId ?? null,
            notebookPath: activeMemoSession?.notebookPath ?? null,
            transitionId: activeMemoSession?.transitionId ?? activeExternalSession?.transitionId ?? null,
            initialFocus: activeMemoSession?.initialFocus,
            isExternalDocument,
            externalScopePath: activeExternalSession?.scopePath ?? null,
            searchPanelOpen: isSearchPanelOpen,
            onSearchPanelOpenChange: setIsSearchPanelOpen,
            toolbarCollapsed,
            onToolbarCollapsedChange: setToolbarCollapsed,
            onMetainfoData: (data: { memoContent: string }) => {
              currentDocumentContentRef.current = data.memoContent;
            },
          },
        },
      }
    : null;
  const workColumnSurface = resolveWorkColumnSurface({
    navigation: navigationState,
    document: workColumnDocument,
    pluginWorkbench: activePlugin
      ? {
          plugin: activePlugin,
          notebookPath: selectedNotebook?.path,
          currentNotePath: currentDocumentPath,
          currentNoteContent: currentDocumentContentRef.current,
        }
      : null,
    emptyMessage: t('shell.emptyDocument'),
  });
  const workColumnSurfaceDefinition = getWorkColumnSurfaceDefinition(workColumnSurface);
  const isAgentConversationDetail = workColumnSurface.kind === 'agent-conversation';
  const isEditableDocumentSurface = workColumnSurface.kind === 'markdown';
  const documentTitlebarProps = {
    reserveWindowsControls: !browserColumnVisible,
    document: {
      // An artifact is allowed to sit above an existing editable session.
      // Do not expose that underlying memo's actions in the artifact chrome;
      // the workColumn target, not the DocumentStore session, owns the view.
      currentMemo: isEditableDocumentSurface ? currentMemo : null,
      externalFilePath: isEditableDocumentSurface && isExternalDocument ? currentDocumentPath : null,
    },
    sidebar: {
      hidden: isMemoListHidden,
      noteNavigationVisible,
      onToggle: handleToggleMemoList,
      onPreviewTriggerEnter: handleMemoListPreviewTriggerEnter,
      onPreviewTriggerLeave: handleMemoListPreviewTriggerLeave,
    },
    navigation: {
      canNavigateBack,
      canNavigateForward,
      onNavigateBack: handleNavigateBack,
      onNavigateForward: handleNavigateForward,
    },
    contentCapabilities: {
      search: surfaceSupports(workColumnSurface, 'search'),
      properties: surfaceSupports(workColumnSurface, 'properties'),
      copyFullText: surfaceSupports(workColumnSurface, 'copy-content'),
      exportContent: surfaceSupports(workColumnSurface, 'export-content'),
      saveAsTemplate: surfaceSupports(workColumnSurface, 'save-template'),
      versionHistory: surfaceSupports(workColumnSurface, 'version-history'),
    },
    actions: {
      onOpenSearch: () => setIsSearchPanelOpen(true),
      onCopyLink: handleCopyLink,
      onCopyFullText: handleCopyFullText,
      onOpenProperties: handleOpenNoteProperties,
      onTogglePin: handleTogglePin,
      onExportMarkdown: handleExportMarkdown,
      onSaveAsTemplate: handleSaveAsTemplate,
      onExportWord: handleExportWord,
      onRequestDeleteMemo: handleRequestDeleteMemo,
      onColorsChange: handleColorsChange,
    },
  };

  return (
    <div
      className="flowix-main-layout flex h-screen w-screen overflow-hidden"
      data-agent-conversation-view={isAgentConversationView || undefined}
      data-agent-conversation-detail={isAgentConversationDetail || undefined}
      style={{ backgroundColor: 'var(--document-bg)' }}
    >
      <WindowsTitlebarControls />
      <MarkdownFileDropOverlay />
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="relative flex flex-1 h-full overflow-hidden">
          <NoteNavigationDrawer
            open={noteNavigationVisible}
            notebooks={notebooks}
            selectedNotebook={selectedNotebook}
            onSelectNotebook={handleSelectNotebook}
            onEditNotebook={handleEditNotebook}
            onDeleteNotebook={handleDeleteNotebook}
            onCreateNotebook={handleCreateNotebook}
            onOpenPreferences={(tab) => void windows.openPreferences(tab)}
            activePluginId={activePluginId}
            onOpenPlugin={handleOpenPlugin}
            onClose={() => setNoteNavigationVisible(false)}
          />
          {/* Memo list column */}
          <div
            data-memo-list-swipe-area
            className={`flex flex-col ${
              memoListPreviewVisible ? 'overflow-visible' : 'overflow-hidden'
            } will-change-[width] ${
              isDraggingListDivider ? 'transition-none' : 'transition-[width] duration-150 ease-out'
            }`}
            style={{ width: memoListWidth, flexShrink: 0 }}
            aria-hidden={isMemoListHidden && !memoListPreviewVisible}
            onPointerDown={() => focusWorkspaceHost('main-third')}
          >
            <div
              className={`flex h-full min-w-0 flex-col ${
                memoListPreviewVisible
                  ? 'overflow-visible'
                  : 'overflow-hidden bg-[var(--card)] border-[var(--divider)] border-r'
              }`}
              style={{ width: memoListPreviewVisible ? 0 : memoColWidth }}
            >
              {memoListMounted && (
                isWindowsPlatform() ? (
                  <MemoListTitlebarWin
                    noteNavigationVisible={noteNavigationVisible}
                    selectedNotebook={selectedNotebook}
                    onCollapseMemoList={collapseMemoList}
                    onToggleNoteNavigation={handleToggleNoteNavigation}
                    onOpenPreferences={(tab) => void windows.openPreferences(tab)}
                  />
                ) : (
                  <MemoListTitlebarMac
                    noteNavigationVisible={noteNavigationVisible}
                    selectedNotebook={selectedNotebook}
                    onCollapseMemoList={collapseMemoList}
                    onToggleNoteNavigation={handleToggleNoteNavigation}
                    onOpenPreferences={(tab) => void windows.openPreferences(tab)}
                  />
                )
              )}
              <div
                data-memo-list-hover-preview={memoListPreviewVisible ? '' : undefined}
                data-preview-state={
                  memoListPreviewVisible ? memoListPreviewPhase : undefined
                }
                onMouseEnter={
                  memoListPreviewVisible ? handleMemoListPreviewEnter : undefined
                }
                onMouseLeave={
                  memoListPreviewVisible ? handleMemoListPreviewLeave : undefined
                }
                className={
                  memoListPreviewVisible
                      // Keep the hover preview below the click-opened note
                      // navigation drawer (z-index 100).
                      ? 'absolute z-[90] mb-1 flex w-[280px] flex-col overflow-hidden rounded-xl border border-[var(--border-popup)] bg-[var(--card)] pt-3 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)] ' +
                      (memoListPreviewPhase === 'open'
                        ? 'flowix-hover-preview-enter'
                        : 'flowix-hover-preview-leave')
                    : 'relative flex flex-1 flex-col min-h-0 min-w-0 w-full'
                }
                style={memoListPreviewVisible ? {
                  left: 2,
                  top: documentTitlebarHeight,
                  bottom: 0,
                } : undefined}
              >
                <div className="relative min-h-0 flex-1">
                  <div
                    className={`absolute inset-0 ${
                      showMemoListSurface
                        ? 'visible'
                        : 'invisible pointer-events-none'
                    }`}
                    aria-hidden={!showMemoListSurface}
                  >
                    <MemoList
                      navigationDrawerEnabled
                      navigationDrawerOpen={noteNavigationVisible}
                      onToggleNavigationDrawer={handleToggleNoteNavigation}
                      isActive={!isAgentConversationView}
                      dataLoadingEnabled={!isAgentConversationView}
                    />
                  </div>
                  {shouldRenderAgentConversationList && (
                    <div
                      className={`absolute inset-0 ${
                        showAgentConversationSurface
                          ? 'visible z-10'
                          : 'invisible pointer-events-none'
                      }`}
                      aria-hidden={!showAgentConversationSurface}
                    >
                      {agentConversationListNode}
                    </div>
                  )}
                  {isAgentConversationView && !agentConversationListReady && (
                    <div
                      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[color-mix(in_oklch,var(--card)_78%,transparent)] text-sm text-[var(--muted-foreground)] backdrop-blur-[1px]"
                      role="status"
                      aria-live="polite"
                    >
                      {t('status.agent.loadingConversations')}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
          {/* List <-> Memo detail divider */}
          {!isMemoListHidden && (
            <div className="relative w-[1px] h-full cursor-col-resize group z-10" onMouseDown={handleListDividerMouseDown}>
              <div className="absolute inset-0 -translate-x-1/2 w-[12px] left-1/2 bg-transparent z-11" />
              <div className={`w-[1px] h-full transition-colors ${isDraggingListDivider ? 'bg-transparent' : 'group-hover:bg-transparent bg-transparent'}`} />
            </div>
          )}
          <div
            data-document-columns-layout="split"
            className="flex min-h-0 min-w-0 flex-1 flex-row overflow-x-auto overflow-y-hidden"
          >
          {/* Memo detail */}
            <div
              className="h-full min-w-0 relative -left-px flex flex-col"
              style={browserColumnVisible
                ? {
                    minWidth: DOCUMENT_PANEL_MIN_WIDTH,
                    flex: `0 0 ${browserColumnLayout.mainColumnWidth}px`,
                  }
                : { minWidth: DOCUMENT_PANEL_MIN_WIDTH, flex: 1 }}
              data-workspace-host="main-third"
              data-workspace-focused={focusedHostId === 'main-third' ? '' : undefined}
              onPointerDown={() => focusWorkspaceHost('main-third')}
              onFocusCapture={() => focusWorkspaceHost('main-third')}
            >
            {isMemoListHidden && (
              <button
                type="button"
                data-memo-list-preview-edge-trigger
                onMouseEnter={handleMemoListPreviewTriggerEnter}
                onMouseLeave={handleMemoListPreviewTriggerLeave}
                onClick={handleToggleMemoList}
                aria-label={t('document.titlebar.showSidebar')}
                title={t('document.titlebar.showSidebarTooltip')}
                className="group absolute left-0 top-1/2 z-[60] flex h-14 w-5 -translate-y-1/2 items-center justify-center text-[var(--muted-foreground)] opacity-55 transition-[color,opacity] duration-150 hover:text-[var(--foreground)] hover:opacity-75 focus-visible:outline-none focus-visible:text-[var(--brand)] focus-visible:opacity-100"
              >
                <span className="flex flex-col items-center gap-[6px]" aria-hidden="true">
                  <span className="h-0.5 w-1.5 rounded-full bg-current transition-[width] group-hover:w-2" />
                  <span className="h-0.5 w-1.5 rounded-full bg-current transition-[width] group-hover:w-2" />
                  <span className="h-0.5 w-1.5 rounded-full bg-current transition-[width] group-hover:w-2" />
                </span>
              </button>
            )}
            {/* Fixed top navigation bar */}
            {workColumnSurfaceDefinition.chrome === 'agent' && workColumnSurface.kind === 'agent-conversation' ? (
              <AgentConversationTitlebar
                instanceId={workColumnSurface.instanceId}
                reserveWindowsControls={!browserColumnVisible}
                isMiddleColumnCollapsed={isMemoListHidden}
                isSidebarVisible={noteNavigationVisible}
                onExpandSidebar={handleToggleMemoList}
                onSidebarPreviewEnter={handleMemoListPreviewTriggerEnter}
                onSidebarPreviewLeave={handleMemoListPreviewTriggerLeave}
                canNavigateBack={canNavigateBack}
                canNavigateForward={canNavigateForward}
                onNavigateBack={handleNavigateBack}
                onNavigateForward={handleNavigateForward}
              />
            ) : isWindowsPlatform() ? (
              <DocumentTitlebarWin {...documentTitlebarProps} />
            ) : (
              <DocumentTitlebarMac {...documentTitlebarProps} />
            )}

            {/* Content area */}
            <div className="relative isolate flex-1 min-w-0 overflow-hidden">
              <WorkColumnSurfaceHost surface={workColumnSurface} />
              {(isDocumentTransitioning || navigationState.phase === 'loading') && (
                <div
                  className="absolute inset-0 z-40 flex items-center justify-center bg-[color-mix(in_oklch,var(--card)_78%,transparent)] backdrop-blur-[1px]"
                  role="status"
                  aria-label="Loading"
                >
                  <div
                    className="h-5 w-5 rounded-full border-2 border-[color-mix(in_oklch,var(--muted-foreground)_26%,transparent)] border-t-[var(--brand)] animate-spin"
                    aria-hidden="true"
                  />
                </div>
              )}
            </div>
          </div>
          {browserColumnVisible && (
            <Suspense fallback={null}>
              <BrowserColumn
                width={browserColumnLayout.browserColumnWidth}
                layoutKey={browserColumnLayoutKey}
                onResize={handleBrowserColumnResize}
                toolbarCollapsed={toolbarCollapsed}
                onToolbarCollapsedChange={setToolbarCollapsed}
              />
            </Suspense>
          )}
          </div>
          </div>
          {/* Status bar */}
          <MainStatusBarHost
            onSelectNotebook={handleSelectNotebook}
            onEditNotebook={handleEditNotebook}
            onDeleteNotebook={handleDeleteNotebook}
            onCreateNotebook={handleCreateNotebook}
            todoCount={todoCount}
            onOpenTodos={handleOpenTodos}
            onToggleNoteNavigation={handleToggleNoteNavigation}
            onOpenAgentConversationView={handleOpenAgentConversationView}
            dshDownload={dshDownload}
            updater={updater}
          />
        </div>
      </div>

      <NotebookDeleteDialog
        target={notebookToDelete ? { id: notebookToDelete.id, name: notebookToDelete.name } : null}
        onCancel={cancelDeleteNotebook}
        onConfirm={confirmDeleteNotebook}
      />

      <MemoListServicesHost
        notebookCreateRequest={notebookCreateRequest}
        onRefresh={triggerRefresh}
      />

      <MainPromptHost
        updater={updater}
        dshInstallPromptOpen={dshInstallPromptOpen}
        dshInstaller={dshInstaller}
        onCloseDshInstallPrompt={handleDshPromptClose}
        onDshIntroDisplayed={handleDshIntroDisplayed}
        onDshInstalled={handleDshInstalled}
      />
    </div>
  );
}
