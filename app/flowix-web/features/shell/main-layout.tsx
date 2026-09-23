'use client';

import { lazy, Suspense, useState, useEffect, useRef, useCallback } from 'react';
import {
  DocumentTitlebarWin,
  DocumentTitlebarMac,
  NotePropertiesHost,
  navigateDocumentHistory,
  useDocumentCommands,
  useShellDocumentHistory,
  useShellDocumentViewModel,
  captureLatestDocumentContent,
  setDocumentEditorMode,
  useDocumentEditorMode,
  type DocumentHistoryEntry,
  type MemoDocumentSession,
} from '@features/document/public/shell-api';
import {
  MemoList,
  MemoListServicesHost,
  NoteNavigationDrawer,
  useShellMemoViewModel,
  startNotebookImportWithMonitoring,
  type MemoItem,
  type Notebook,
} from '@features/memo/public/shell-api';
import { AgentConversationTitlebar } from '@features/agent/public/shell-api';
import { useSettingsStore } from '@/lib/store/settings-store';
import { useShallow } from 'zustand/react/shallow';
import {
  product,
  windows,
  boot,
  type StartupStatus,
  type DshDownloadProgress,
} from '@platform/tauri/client';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import { canonicalPath, getDocumentInstanceKey } from '@/lib/path';
import { NotebookDeleteDialog } from '@features/shell/components/notebook-delete-dialog';
import { MarkdownFileDropOverlay } from '@features/shell/components/drag-overlay/markdown-file-drop-overlay';
import { useMainMiddleColumnController } from '@features/shell/hooks/use-main-middle-column-controller';
import { useMainPanelController } from '@features/shell/hooks/use-main-panel-controller';
import { ListColumn } from '@features/shell/components/list-column';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import type { DshRuntimeInstallerState } from '@features/preferences/public/system-api';
import type { AppUpdaterState } from '@features/shell/hooks/use-app-updater';
import {
  WorkColumnContentHost,
  resolveWorkColumnPresentation,
} from '@features/surface/public/shell-api';
import type { PluginDescriptor } from '@platform/tauri/client';
import {
  useShellWorkspaceViewModel,
  selectNotebook as selectNotebookInWorkspace,
  BROWSER_COLUMN_MIN_WIDTH,
  type WorkColumnTarget,
} from '@features/workspace/public/shell-api';
import { MainStatusBarHost } from '@features/shell/components/main-status-bar-host';
import { CenteredLoadingSpinner } from '@shared/ui/centered-loading-spinner';
import { MainPromptHost } from '@features/shell/components/main-prompt-host';
import type { Editor } from '@tiptap/core';
import { OnboardingScreen } from '@features/onboarding';

const DOCUMENT_PANEL_MIN_WIDTH = BROWSER_COLUMN_MIN_WIDTH;

const BrowserColumn = lazy(() =>
  import('@features/shell/components/browser-column').then((module) => ({
    default: module.BrowserColumn,
  })),
);

function isWindowsPlatform(): boolean {
  return /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform);
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
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
  if (currentWorkColumnTarget.kind === 'media') {
    return entry.kind !== 'media'
      || canonicalPath(entry.filePath) !== canonicalPath(currentWorkColumnTarget.filePath);
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
  if (entry.kind !== 'external') return true;
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
  onboardingOpen: boolean;
  updater: AppUpdaterState;
  dshInstaller: DshRuntimeInstallerState;
  closeDshInstallPrompt(): void;
  markDshIntroDisplayed(): void;
  completeDshInstallPrompt(): void;
  completeOnboarding(): Promise<void>;
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
    onboardingOpen,
    updater,
    dshInstaller,
    closeDshInstallPrompt: handleDshPromptClose,
    markDshIntroDisplayed: handleDshIntroDisplayed,
    completeDshInstallPrompt: handleDshInstalled,
    completeOnboarding,
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
    notebookSwitching,
  } = useShellWorkspaceViewModel();
  const [startupStatus, setStartupStatus] = useState<StartupStatus>({
    phase: 'pending',
    step: 'initializing',
    error: null,
  });
  useEffect(() => {
    if (!isTauriRuntime()) {
      setStartupStatus({ phase: 'ready', step: 'ready', error: null });
      return;
    }

    let active = true;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const next = await boot.getStartupStatus();
        if (!active) return;
        setStartupStatus(next);
        if (next.phase === 'ready' || next.phase === 'failed') {
          if (timer !== undefined) window.clearInterval(timer);
          timer = undefined;
        }
      } catch {
        // Browser preview and older native shells have no startup coordinator;
        // they should retain the existing interactive behavior.
        if (active) setStartupStatus({ phase: 'ready', step: 'ready', error: null });
        if (timer !== undefined) window.clearInterval(timer);
        timer = undefined;
      }
    };

    void refresh();
    timer = window.setInterval(() => void refresh(), 250);
    return () => {
      active = false;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, []);
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
    handleListDividerMouseDown,
    handleToggleMemoList,
    handleToggleNoteNavigation,
    closeNoteNavigation,
    completeNoteNavigationClose,
    isDraggingListDivider,
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
    handleMemoListPreviewCompanionEnter,
    handleMemoListPreviewCompanionLeave,
    agentConversationListNode,
  } = useMainMiddleColumnController({
    isAgentConversationView,
    isMemoListHidden,
    noteNavigationPhase,
  });
  const currentMemo = currentDocumentPath && currentDocumentSource === 'memo' && activeMemoSession
    ? memos.find((memo) => memo.id === activeMemoSession.memoId)
      ?? (selectedMemo?.id === activeMemoSession.memoId ? selectedMemo : null)
    : null;
  const isExternalDocument = currentDocumentSource === 'external';
  const currentDocumentInstanceKey =
    currentDocumentSource === 'memo' && activeMemoSession
      ? activeMemoSession.id
      : activeExternalSession?.id ?? (currentDocumentPath ? getDocumentInstanceKey(currentDocumentPath) : null);
  const mainMemoEditorIdentity = activeMemoSession
    ? { kind: 'memo' as const, id: activeMemoSession.memoId }
    : null;
  const mainEditorMode = useDocumentEditorMode(
    'main-third',
    mainMemoEditorIdentity ?? { kind: 'external', path: currentDocumentPath ?? '' },
  );
  const getCurrentDocumentContent = useCallback(() => currentDocumentContentRef.current, []);
  const getCurrentDocumentEditor = useCallback(() => currentDocumentEditorRef.current, []);
  const handleDocumentEditorReady = useCallback((editor: Editor | null) => {
    currentDocumentEditorRef.current = editor;
  }, []);
  const {
    handleCopyFullText,
    handleCopyLink,
    handleTogglePin,
    handleColorsChange,
    handleExportMarkdown,
    handleSaveAsTemplate,
    handleExportWord,
    handleExportPdf,
  } = useDocumentCommands({
    currentDocumentPath,
    getCurrentDocumentContent,
    getCurrentDocumentEditor,
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
    currentDocumentEditorRef.current = null;
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

  const handleCopyMediaLink = useCallback(async () => {
    if (!mediaTarget) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(mediaTarget.filePath);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = mediaTarget.filePath;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      toast.success(t('document.command.copySuccess'));
    } catch (error) {
      console.warn('[MainLayout] Failed to copy media link:', error);
      toast.error(t('document.command.copyFailed'));
    }
  }, [mediaTarget, t]);

  const handleRevealMedia = useCallback(() => {
    if (!mediaTarget) return;
    void product.revealInFileManager(mediaTarget.filePath).catch((error) => {
      console.warn('[MainLayout] Failed to reveal media in file manager:', error);
      toast.error(t('memo.fileTree.openFailed'));
    });
  }, [mediaTarget, t]);

  const handleRequestDeleteMedia = useCallback(() => {
    if (!mediaTarget?.notebookPath) return;
    window.dispatchEvent(new CustomEvent('flowix:request-delete-media', {
      detail: {
        filePath: mediaTarget.filePath,
        notebookPath: mediaTarget.notebookPath,
      },
    }));
  }, [mediaTarget]);

  const handleToggleEditorMode = useCallback(() => {
    if (!currentMemo || !activeMemoSession) return;
    const identity = { kind: 'memo' as const, id: activeMemoSession.memoId };
    // Publish the active editor's latest serialized content before replacing
    // its React subtree. The autosave pipeline continues asynchronously from
    // the shared document buffer; mode switching itself must stay immediate.
    captureLatestDocumentContent(identity, 'main-third');
    const nextMode = mainEditorMode === 'source' ? 'rich' : 'source';
    setDocumentEditorMode('main-third', identity, nextMode);
  }, [activeMemoSession, currentMemo, mainEditorMode]);

  const handleViewSourceMode = useCallback(() => {
    if (!currentMemo || !activeMemoSession || mainEditorMode === 'source') return;
    const identity = { kind: 'memo' as const, id: activeMemoSession.memoId };
    captureLatestDocumentContent(identity, 'main-third');
    setDocumentEditorMode('main-third', identity, 'source');
  }, [activeMemoSession, currentMemo, mainEditorMode]);

  useEffect(() => {
    const handleViewSource = () => handleViewSourceMode();
    window.addEventListener('flowix:view-source-mode', handleViewSource);
    return () => window.removeEventListener('flowix:view-source-mode', handleViewSource);
  }, [handleViewSourceMode]);

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
            onEditorReady: handleDocumentEditorReady,
          },
        },
      }
    : null;
  const workColumnPresentation = resolveWorkColumnPresentation({
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
  const isAgentConversationDetail = workColumnPresentation.header.kind === 'agent';
  const workColumnLoadingTone = navigationState.phase === 'loading'
    ? navigationState.pendingTarget?.kind === 'agent-conversation'
      ? 'agent'
      : navigationState.pendingTarget?.kind === 'media'
        ? 'media'
        : 'document'
    : workColumnPresentation.chrome;
  const documentTitlebarProps = {
    reserveWindowsControls: !browserColumnVisible,
    surfaceChrome: workColumnPresentation.chrome === 'media' ? 'media' as const : 'document' as const,
    document: {
      // An artifact is allowed to sit above an existing editable session.
      // Do not expose that underlying memo's actions in the artifact chrome;
      // the workColumn target, not the DocumentStore session, owns the view.
      currentMemo: workColumnPresentation.header.kind === 'document'
        ? workColumnPresentation.header.document.currentMemo
        : null,
      externalFilePath: workColumnPresentation.header.kind === 'document'
        ? workColumnPresentation.header.document.externalFilePath
        : null,
    },
    sidebar: {
      hidden: isMemoListHidden,
      noteNavigationVisible,
      onToggle: handleToggleMemoList,
    },
    navigation: {
      canNavigateBack,
      canNavigateForward,
      onNavigateBack: handleNavigateBack,
      onNavigateForward: handleNavigateForward,
    },
    contentCapabilities: {
      copyFullText: workColumnPresentation.capabilities.includes('copy-content'),
      exportContent: workColumnPresentation.capabilities.includes('export-content'),
      saveAsTemplate: workColumnPresentation.capabilities.includes('save-template'),
      versionHistory: workColumnPresentation.capabilities.includes('version-history'),
    },
    actions: {
      onCopyLink: handleCopyLink,
      onCopyFullText: handleCopyFullText,
      onTogglePin: handleTogglePin,
      onExportMarkdown: handleExportMarkdown,
      onSaveAsTemplate: handleSaveAsTemplate,
      onExportWord: handleExportWord,
      onExportPdf: handleExportPdf,
      onRequestDeleteMemo: handleRequestDeleteMemo,
      onColorsChange: handleColorsChange,
      editorMode: mainEditorMode,
      onToggleEditorMode: handleToggleEditorMode,
    },
    mediaActions: mediaTarget ? {
      onCopyLink: handleCopyMediaLink,
      onRevealInFileManager: handleRevealMedia,
      onRequestDelete: handleRequestDeleteMedia,
    } : undefined,
  };

  return (
    <div
      className="flowix-main-layout relative flex h-screen w-screen overflow-hidden"
      data-agent-conversation-view={isAgentConversationView || undefined}
      data-agent-conversation-detail={isAgentConversationDetail || undefined}
      style={{ backgroundColor: 'var(--frame-bg)' }}
    >
      <WindowsTitlebarControls />
      <MarkdownFileDropOverlay />
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="relative flex flex-1 h-full overflow-hidden rounded-b-[18px] border-b border-[var(--divider)]">
          <NoteNavigationDrawer
            phase={noteNavigationPhase}
            notebooks={notebooks}
            selectedNotebook={selectedNotebook}
            onSelectNotebook={handleSelectNotebook}
            onEditNotebook={handleEditNotebook}
            onDeleteNotebook={handleDeleteNotebook}
            onCreateNotebook={handleCreateNotebook}
            onOpenPreferences={(tab) => void windows.openPreferences(tab)}
            activePluginId={activePluginId}
            onOpenPlugin={handleOpenPlugin}
            onRequestClose={closeNoteNavigation}
            onCloseComplete={completeNoteNavigationClose}
            onCompanionSurfaceEnter={handleMemoListPreviewCompanionEnter}
            onCompanionSurfaceLeave={handleMemoListPreviewCompanionLeave}
          />
          {/* List column: one mounted subtree shared by the docked sidebar and hover preview. */}
          <ListColumn
            hidden={isMemoListHidden}
            previewVisible={memoListPreviewVisible}
            previewPhase={memoListPreviewPhase === 'open' ? 'open' : 'closing'}
            memoColWidth={memoColWidth}
            isDraggingListDivider={isDraggingListDivider}
            selectedNotebook={selectedNotebook}
            noteNavigationPhase={noteNavigationPhase}
            onCollapseMemoList={collapseMemoList}
            onToggleNoteNavigation={handleToggleNoteNavigation}
            onOpenPreferences={(tab) => void windows.openPreferences(tab)}
            onPreviewEnter={handleMemoListPreviewEnter}
            onPreviewLeave={handleMemoListPreviewLeave}
            onPointerDown={() => focusWorkspaceHost('main-third')}
          >
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
                navigationDrawerOpen={noteNavigationPhase !== 'closed'}
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
          </ListColumn>
          {/* List <-> Memo detail divider */}
          {!isMemoListHidden && (
            <div className="relative z-10 h-full w-px shrink-0 cursor-col-resize bg-[var(--divider)]" onMouseDown={handleListDividerMouseDown}>
              <div className="absolute inset-y-0 -left-[5px] w-[11px] bg-transparent" />
            </div>
          )}
          <div
            data-document-columns-layout="split"
            className="flex min-h-0 min-w-0 flex-1 flex-row overflow-x-auto overflow-y-hidden"
          >
          {/* Memo detail */}
            <div
              className="relative h-full min-w-0 flex flex-col bg-[var(--document-bg)]"
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
                // Clicking the collapsed edge follows the hover interaction:
                // open the floating preview instead of restoring the full
                // list column.
                onClick={handleMemoListPreviewEnter}
                aria-label={t('document.titlebar.showSidebar')}
                title={t('document.titlebar.showSidebarTooltip')}
                className="group absolute bottom-0 left-0 top-0 z-[60] flex w-4 items-center justify-center text-[var(--muted-foreground)] opacity-30 transition-[color,opacity] duration-150 hover:text-[var(--foreground)] hover:opacity-50 focus-visible:outline-none focus-visible:text-[var(--brand)] focus-visible:opacity-100"
              >
                <span className="flex translate-x-0 flex-col items-center gap-[6px]" aria-hidden="true">
                  <span className="h-1 w-1 rounded-full bg-current" />
                  <span className="h-1 w-1 rounded-full bg-current" />
                  <span className="h-1 w-1 rounded-full bg-current" />
                </span>
              </button>
            )}
            {/* Fixed top navigation bar */}
            {workColumnPresentation.header.kind === 'agent' ? (
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
            ) : isWindowsPlatform() ? (
              <DocumentTitlebarWin {...documentTitlebarProps} />
            ) : (
              <DocumentTitlebarMac {...documentTitlebarProps} />
            )}

            {/* Content area */}
            <div className="relative isolate flex-1 min-w-0 overflow-hidden">
              <WorkColumnContentHost content={workColumnPresentation.content} />
              {(isDocumentTransitioning
                || (navigationState.phase === 'loading' && navigationState.showWorkColumnLoading)) && (
                <CenteredLoadingSpinner
                  className={workColumnLoadingTone === 'agent' || workColumnLoadingTone === 'media'
                    ? 'absolute inset-0 z-40 bg-[var(--agent-bg,var(--document-bg))]'
                    : 'absolute inset-0 z-40 bg-[var(--document-bg)]'}
                  label={notebookSwitching ? t('memo.navigation.preparingNotebook') : undefined}
                />
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
            onOpenTodos={handleOpenTodos}
            onToggleNoteNavigation={handleToggleNoteNavigation}
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

      <NotePropertiesHost />

      <MainPromptHost
        updater={updater}
        dshInstallPromptOpen={dshInstallPromptOpen}
        dshInstaller={dshInstaller}
        onCloseDshInstallPrompt={handleDshPromptClose}
        onDshIntroDisplayed={handleDshIntroDisplayed}
        onDshInstalled={handleDshInstalled}
      />

      {startupStatus.phase !== 'ready' && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-[var(--frame-bg)]">
          {startupStatus.phase === 'failed' ? (
            <div className="max-w-md px-6 text-center text-sm text-[var(--muted-foreground)]" role="alert">
              {t('memo.navigation.startupMigrationFailed')}
            </div>
          ) : (
            <CenteredLoadingSpinner label={t('memo.navigation.preparingWorkspace')} />
          )}
        </div>
      )}

      {onboardingOpen && (
        <OnboardingScreen
          dshInstaller={dshInstaller}
          onFinish={async (notebook, { startImport }) => {
            await selectNotebookInWorkspace(notebook);
            if (startImport) {
              await startNotebookImportWithMonitoring(notebook.id, (status) => {
                if (status.status === 'failed') {
                  toast.error(status.message ?? '笔记本导入失败，请重试');
                }
              });
            }
            await completeOnboarding();
          }}
        />
      )}
    </div>
  );
}
