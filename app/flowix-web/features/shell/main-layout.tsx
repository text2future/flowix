'use client';

import { lazy, Suspense, useState, useEffect, useLayoutEffect, useRef, useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import { ArrowUp, Check, Loader2, Plug } from 'lucide-react';
import { DocumentTitlebarWin } from '@features/document/components/document-titlebar-win';
import { DocumentTitlebarMac } from '@features/document/components/document-titlebar-mac';
import { MemoList } from '@features/memo/components/memo-list';
import { AgentConversationTitlebar } from '@features/agent/components/agent-conversation-titlebar';
import { useMemoListHoverPreview } from '@features/memo/components/use-memo-list-hover-preview';
import { MemoListTitlebarWin } from '@features/memo/components/memo-list-titlebar-win';
import { MemoListTitlebarMac } from '@features/memo/components/memo-list-titlebar-mac';
import { NoteNavigationPanel } from '@features/memo/components/note-navigation-panel';
import { useDocumentHistoryStore, useDocumentStore, type DocumentHistoryEntry, type MemoDocumentSession } from '@features/document/store';
import { useMemoStore, type MemoItem, type Notebook } from '@features/memo';
import { useSettingsStore } from '@features/shell';
import { useShallow } from 'zustand/react/shallow';
import {
  agent,
  dshIntegration,
  boot,
  notebooks as notebooksClient,
  windows,
  type DshDownloadProgress,
} from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import { notebookDeleteErrorMessage } from '@platform/tauri/errors';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import { toast } from '@/lib/toast';
import iconCodex from '@/assets/codex.svg';
import iconClaudeCode from '@/assets/icon-claude-code.svg';
import iconFlowixAgent from '@/assets/flowix-agent.svg';
import iconOpenCode from '@/assets/icon-opencode.svg';
import { canonicalPath, getDocumentInstanceKey } from '@/lib/path';
import { navigateDocumentHistory } from '@features/document/use-cases/document-navigation';
import { StatusBar } from '@features/shell/components/status-bar/status-bar';
import { NotebookDeleteDialog } from '@features/shell/components/notebook-delete-dialog';
import { MemoListServicesHost } from '@features/memo/components/memo-list-services-host';
import { MarkdownFileDropOverlay } from '@features/shell/components/drag-overlay/markdown-file-drop-overlay';
import { resolveBrowserColumnLayout } from '@features/shell/hooks/browser-column-layout';
import { useDocumentCommands } from '@features/document/components/use-document-commands';
import { useNotebookTodoCount } from '@features/memo/components/use-notebook-todo-count';
import { useResizablePanels } from '@features/shell/hooks/use-resizable-panels';
import { useDeferredUnmount } from '@features/shell/hooks/use-deferred-unmount';
import { useMacosTrackpadSwipe, type MacosTrackpadSwipeDirection } from '@features/shell/hooks/use-macos-trackpad-swipe';
import { useI18n } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { Button } from '@shared/ui/button';
import { DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { UpdateProgress } from '@shared/ui/update-progress';
import { useDshRuntimeInstaller } from '@features/preferences/hooks/use-dsh-runtime-installer';
import { useUserSettings } from '@features/preferences/hooks/use-user-settings';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { useCliLinkStatusStore } from '@features/preferences/store';
import { useAppUpdater, type AppUpdaterState } from '@features/shell/hooks/use-app-updater';
import { AgentIcon } from '@features/agent/components/agent-icon';
import { FloatingPrompt, FloatingPromptStack } from '@features/shell/components/floating-prompt';
import {
  WorkColumnSurfaceHost,
  getWorkColumnSurfaceDefinition,
  resolveWorkColumnSurface,
  surfaceSupports,
} from '@features/surface';
import type { PluginDescriptor } from '@platform/tauri/client';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import type { WorkColumnTarget } from '@features/workspace/store/work-column-target';
import {
  clearPluginWorkbenchTarget,
  dismissNavigationFailure,
  flushWorkspaceDocument,
  openPluginWorkbench,
  reconcileDeletedNotebook,
  retryLastNavigation,
  selectNotebook,
} from '@features/workspace/use-cases/workspace-navigation';
import { useBrowserColumnStore, BROWSER_COLUMN_MIN_WIDTH } from '@features/workspace/store/browser-column-store';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';

const NOTE_NAVIGATION_PANEL_WIDTH = 238;
const NOTE_NAVIGATION_PANEL_MIN_WIDTH = 180;
const NOTE_NAVIGATION_PANEL_MAX_WIDTH = 420;
const DOCUMENT_PANEL_MIN_WIDTH = BROWSER_COLUMN_MIN_WIDTH;
const PANEL_DIVIDER_WIDTH = 1;
const logger = createLogger('main-layout');

const BrowserColumn = lazy(() =>
  import('@features/shell/components/browser-column').then((module) => ({
    default: module.BrowserColumn,
  })),
);

// The Memo list is the default navigation surface. The module is still loaded
// lazily, but its promise is shared by the idle prefetch and React.lazy so the
// first visible switch does not start a second import.
let agentConversationListModulePromise: ReturnType<typeof importAgentConversationList> | null = null;

function importAgentConversationList() {
  return import('@features/agent/components/agent-conversation-list').then((module) => ({
    default: module.AgentConversationList,
  }));
}

function loadAgentConversationList() {
  agentConversationListModulePromise ??= importAgentConversationList();
  return agentConversationListModulePromise;
}

const AgentConversationList = lazy(loadAgentConversationList);

function AgentConversationListReadySignal({
  onReady,
  isActive,
}: {
  onReady: () => void;
  isActive: boolean;
}) {
  useLayoutEffect(() => {
    onReady();
  }, [onReady]);
  return <AgentConversationList isActive={isActive} />;
}

const LOCAL_AGENT_INTRO_OPTIONS = [
  { key: 'codex', nameKey: 'agent.types.codex.name', icon: iconCodex },
  { key: 'claude', nameKey: 'agent.types.claude.name', icon: iconClaudeCode },
  { key: 'opencode', nameKey: 'agent.types.opencode.name', icon: iconOpenCode },
] as const;
type LocalAgentIntroOption = (typeof LOCAL_AGENT_INTRO_OPTIONS)[number];

function isActiveDshDownload(progress: DshDownloadProgress | null): boolean {
  return progress?.phase === 'checking'
    || progress?.phase === 'downloading'
    || progress?.phase === 'downloaded'
    || progress?.phase === 'installing';
}

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

type PanelVisibilityState = {
  memoListVisible: boolean;
  noteNavigationVisible: boolean;
};

type PanelVisibilityTransition = Partial<PanelVisibilityState>;

function resolvePanelSwipeTransition(
  state: PanelVisibilityState,
  direction: MacosTrackpadSwipeDirection,
): PanelVisibilityTransition | null {
  // 左滑: 从左到右遍历左侧两列 (tags → memolist), 关闭第一个可见的。
  // 右滑: 反向遍历 (memolist → tags), 打开第一个隐藏的。
  if (direction === 'left') {
    if (state.noteNavigationVisible) return { noteNavigationVisible: false };
    if (state.memoListVisible) return { memoListVisible: false };
    return null;
  }
  if (!state.memoListVisible) return { memoListVisible: true };
  if (!state.noteNavigationVisible) return { noteNavigationVisible: true };
  return null;
}

export function MainLayout() {
  const { t } = useI18n();
  // 切片订阅：每个 useStore 只取真正用到的字段，setter 走 useShallow 聚合。
  // 替代原来的 `useMemoStore()` / `useDocumentStore()` / `useSettingsStore()`
  // 全量订阅 —— 任何 set 都会让 MainLayout 整树重渲，跨菜单栏 / 状态栏 /
  // document 容器一起抖。切到 selector 后, 只在用到的字段变化时本组件
  // 才重渲, memo-list / document-container 各自独立订阅, 互不污染。
  const memos = useMemoStore((s) => s.memos);
  const notebooks = useMemoStore((s) => s.notebooks);
  const selectedMemo = useMemoStore((s) => s.selectedMemo);
  const selectedNotebook = useMemoStore((s) => s.selectedNotebook);
  const middleColumnView = useMemoStore((s) => s.middleColumnView);
  const activeFilter = useMemoStore((s) => s.activeFilter);
  const activePluginId = useMemoStore((s) => s.activePluginId);
  const activeSort = useMemoStore((s) => s.activeSort);
  const isAgentConversationView = middleColumnView === 'conversations';
  const [agentConversationListMounted, setAgentConversationListMounted] = useState(
    () => middleColumnView === 'conversations',
  );
  const [agentConversationListReady, setAgentConversationListReady] = useState(false);
  const handleAgentConversationListReady = useCallback(() => {
    setAgentConversationListReady(true);
  }, []);
  const [dshDownload, setDshDownload] = useState<DshDownloadProgress | null>(null);
  const productUpdatesEnabled = useUserSettings((settings) => settings.productUpdates.enabled);
  const userSettingsLoading = useUserSettingsStore((state) => state.isLoading);
  const updater = useAppUpdater({
    autoCheck: !userSettingsLoading,
    enabled: productUpdatesEnabled,
  });

  // Mount the conversation list once it is first requested, but never tear it
  // down again. Its local pagination, filters, and scroll position then remain
  // available for the next view switch.
  useEffect(() => {
    if (isAgentConversationView) setAgentConversationListMounted(true);
  }, [isAgentConversationView]);

  // Warm the lazy chunk after the initial surface has settled. The promise is
  // shared with React.lazy, so a user switching earlier still uses the same
  // in-flight import.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAgentConversationList().catch((error) => {
        logger.warn('prefetch conversation list failed', { error });
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const applyProgress = (progress: DshDownloadProgress) => {
      setDshDownload(isActiveDshDownload(progress) ? progress : null);
    };
    const unsubscribe = subscribe<DshDownloadProgress>('dsh-download-progress', applyProgress);
    void dshIntegration.downloadStatus()
      .then((progress) => {
        if (progress) applyProgress(progress);
      })
      .catch(() => {
        // The Preferences window remains the detailed recovery surface.
      });
    return unsubscribe;
  }, []);

  const memoActions = useMemoStore(
    useShallow((s) => ({
      setActiveFilter: s.setActiveFilter,
      setActivePluginId: s.setActivePluginId,
      loadMemos: s.loadMemos,
      triggerRefresh: s.triggerRefresh,
      updateMemoMeta: s.updateMemoMeta,
      setMemoColors: s.setMemoColors,
    })),
  );
  const {
    setActiveFilter,
    setActivePluginId,
    loadMemos,
    triggerRefresh,
    updateMemoMeta,
    setMemoColors,
  } = memoActions;

  const {
    currentDocumentPath,
    currentDocumentSource,
    activeAgentConversationId,
    activeMemoSession,
    activeExternalSession,
    isDocumentTransitioning,
  } = useDocumentStore(
    useShallow((s) => ({
      currentDocumentPath: s.currentDocumentPath,
      currentDocumentSource: s.currentDocumentSource,
      activeAgentConversationId: s.activeAgentConversationId,
      activeMemoSession: s.activeMemoSession,
      activeExternalSession: s.activeExternalSession,
      isDocumentTransitioning: s.isDocumentTransitioning,
    })),
  );

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
  const navigationState = useWorkColumnStore((state) => state.navigation);
  const canNavigateBack = useDocumentHistoryStore((s) => (
    s.backStack.some((entry) => isDifferentHistoryTarget(
      entry,
      navigationState.target,
      activeMemoSession,
      currentDocumentSource,
      currentDocumentPath,
      activeAgentConversationId,
    ))
  ));
  const canNavigateForward = useDocumentHistoryStore((s) => (
    s.forwardStack.some((entry) => isDifferentHistoryTarget(
      entry,
      navigationState.target,
      activeMemoSession,
      currentDocumentSource,
      currentDocumentPath,
      activeAgentConversationId,
    ))
  ));
  const [notebookToDelete, setNotebookToDelete] = useState<Notebook | null>(null);
  const [notebookCreateRequest, setNotebookCreateRequest] = useState(0);
  const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(false);
  const workColumnTarget = navigationState.target;
  const activePlugin = workColumnTarget.kind === 'plugin-workbench'
    ? workColumnTarget.plugin
    : null;
  const [noteNavigationPanelWidth, setNoteNavigationPanelWidth] = useState(NOTE_NAVIGATION_PANEL_WIDTH);
  const [isDraggingNoteNavigationDivider, setIsDraggingNoteNavigationDivider] = useState(false);
  const currentDocumentContentRef = useRef('');
  const syncedNotebookIdRef = useRef<string | null | undefined>(undefined);
  const noteNavigationDividerStartRef = useRef({
    x: 0,
    width: NOTE_NAVIGATION_PANEL_WIDTH,
  });
  const noteNavigationPanelWidthRef = useRef(NOTE_NAVIGATION_PANEL_WIDTH);

  const [dshInstallPromptOpen, setDshInstallPromptOpen] = useState(false);

  // The boot record is the single source of truth for whether the DSH
  // introduction has already been displayed. Missing values deserialize as
  // false, so fresh installs show the prompt.
  useEffect(() => {
    let cancelled = false;

    void boot.getFeatures().then((features) => {
      if (cancelled) return;
      if (!features.isIntroductDisplayed) setDshInstallPromptOpen(true);
    }).catch(() => {
      // Do not show the prompt when the boot state cannot be read.
    });
    return () => { cancelled = true; };
  }, []);

  const handleDshPromptClose = useCallback(() => {
    void boot.setIntroDisplayed().catch((error) => {
      logger.warn('persist DSH intro display state failed', { error });
    });
    setDshInstallPromptOpen(false);
  }, []);

  const handleDshInstalled = useCallback(() => {
    setDshInstallPromptOpen(false);
  }, []);

  const handleDshIntroDisplayed = useCallback(() => {
    void boot.setIntroDisplayed().catch((error) => {
      logger.warn('persist DSH intro display state failed', { error });
    });
  }, []);
  const memoListMounted = useDeferredUnmount(memoListVisible);
  const shouldRenderAgentConversationList =
    agentConversationListMounted || isAgentConversationView;
  const showMemoListSurface = !isAgentConversationView || !agentConversationListReady;
  const showAgentConversationSurface = isAgentConversationView && agentConversationListReady;
  // tags 面板独立成最左列, 宽度走自己的 state。
  const noteNavigationColumnWidth = noteNavigationVisible ? noteNavigationPanelWidth : 0;
  const browserColumnVisible = useBrowserColumnStore((state) => state.visible);
  const browserColumnSplitRatio = useBrowserColumnStore((state) => state.splitRatio);
  const setBrowserColumnSplitRatio = useBrowserColumnStore((state) => state.setSplitRatio);
  const focusWorkspaceHost = useWorkspaceFocusStore((state) => state.focusHost);
  const focusedHostId = useWorkspaceFocusStore((state) => state.focusedHostId);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  const {
    handleListDividerMouseDown,
    isDraggingListDivider,
    isMemoListHidden,
    memoColWidth,
    memoListWidth,
  } = useResizablePanels({
    documentPanelMinWidth: DOCUMENT_PANEL_MIN_WIDTH,
    memoListVisible,
    noteNavigationWidth: noteNavigationColumnWidth,
  });
  const browserColumnLayout = resolveBrowserColumnLayout({
    viewportWidth,
    noteNavigationWidth: noteNavigationColumnWidth,
    memoListWidth,
    memoListVisible: !isMemoListHidden,
    dividerCount: (noteNavigationVisible ? 1 : 0) + (!isMemoListHidden ? 1 : 0),
    splitRatio: browserColumnSplitRatio,
  });
  const browserColumnLayoutKey = [
    viewportWidth,
    noteNavigationColumnWidth,
    memoListWidth,
    browserColumnLayout.mainColumnWidth,
    browserColumnLayout.browserColumnWidth,
    isMemoListHidden ? 'memo-hidden' : 'memo-visible',
  ].join(':');
  const handleBrowserColumnResize = useCallback((nextWidth: number) => {
    if (!browserColumnLayout.canSplit || browserColumnLayout.availableDocumentWidth <= 0) return;
    setBrowserColumnSplitRatio(nextWidth / browserColumnLayout.availableDocumentWidth);
  }, [
    browserColumnLayout.availableDocumentWidth,
    browserColumnLayout.canSplit,
    setBrowserColumnSplitRatio,
  ]);
  const {
    phase: memoListPreviewPhase,
    handleTriggerEnter: handleMemoListPreviewTriggerEnter,
    handleTriggerLeave: handleMemoListPreviewTriggerLeave,
    handlePreviewEnter: handleMemoListPreviewEnter,
    handlePreviewLeave: handleMemoListPreviewLeave,
  } = useMemoListHoverPreview(isMemoListHidden);
  const memoListPreviewVisible =
    isMemoListHidden && memoListPreviewPhase !== 'closed';
  const documentTitlebarHeight = isWindowsPlatform() ? 36 : 48;

  useEffect(() => {
    // Notebook changes initiated by the navigation facade already update the
    // backend before publishing the new selection. Waiting here avoids a
    // duplicate IPC call and, more importantly, keeps the facade's rollback
    // decision authoritative.
    if (useWorkColumnStore.getState().navigation.phase === 'loading') return;
    const notebookId = selectedNotebook?.id ?? null;
    if (syncedNotebookIdRef.current === notebookId) return;
    syncedNotebookIdRef.current = notebookId;

    void notebooksClient.setCurrent(notebookId).catch((error) => {
      logger.warn('sync current notebook failed', { error });
      syncedNotebookIdRef.current = undefined;
    });
  }, [selectedNotebook?.id]);

  const getNoteNavigationPanelMaxWidth = useCallback(() => {
    const visibleDividerWidth =
      (noteNavigationVisible ? PANEL_DIVIDER_WIDTH : 0) +
      (!isMemoListHidden ? PANEL_DIVIDER_WIDTH : 0);
    const availableWidth =
      window.innerWidth -
      memoListWidth -
      DOCUMENT_PANEL_MIN_WIDTH -
      visibleDividerWidth;

    return Math.min(
      NOTE_NAVIGATION_PANEL_MAX_WIDTH,
      Math.max(NOTE_NAVIGATION_PANEL_MIN_WIDTH, availableWidth),
    );
  }, [isMemoListHidden, memoListWidth, noteNavigationVisible]);

  const handleNoteNavigationDividerMouseDown = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    setIsDraggingNoteNavigationDivider(true);
    noteNavigationDividerStartRef.current = {
      x: event.clientX,
      width: noteNavigationPanelWidth,
    };
    noteNavigationPanelWidthRef.current = noteNavigationPanelWidth;
  }, [noteNavigationPanelWidth]);

  useEffect(() => {
    if (!isDraggingNoteNavigationDivider) return;

    const handleMouseMove = (event: MouseEvent) => {
      // tags 列在最左, divider 在面板的右侧; 向右拖 → 面板变宽, 向左拖 → 变窄。
      const diff = event.clientX - noteNavigationDividerStartRef.current.x;
      const nextWidth = noteNavigationDividerStartRef.current.width + diff;
      const clampedWidth = Math.min(
        getNoteNavigationPanelMaxWidth(),
        Math.max(NOTE_NAVIGATION_PANEL_MIN_WIDTH, nextWidth),
      );
      noteNavigationPanelWidthRef.current = clampedWidth;
      setNoteNavigationPanelWidth(clampedWidth);
    };

    const handleMouseUp = () => {
      setIsDraggingNoteNavigationDivider(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [getNoteNavigationPanelMaxWidth, isDraggingNoteNavigationDivider]);

  useEffect(() => {
    if (!noteNavigationVisible || isDraggingNoteNavigationDivider) return;
    const maxWidth = getNoteNavigationPanelMaxWidth();
    if (noteNavigationPanelWidth <= maxWidth) return;
    noteNavigationPanelWidthRef.current = maxWidth;
    setNoteNavigationPanelWidth(maxWidth);
  }, [
    getNoteNavigationPanelMaxWidth,
    isDraggingNoteNavigationDivider,
    noteNavigationPanelWidth,
    noteNavigationVisible,
  ]);

  const handlePanelSwipe = useCallback((direction: MacosTrackpadSwipeDirection) => {
    const transition = resolvePanelSwipeTransition(
      { memoListVisible, noteNavigationVisible },
      direction,
    );
    if (!transition) return;
    if (transition.memoListVisible !== undefined && transition.memoListVisible !== memoListVisible) {
      setMemoListVisible(transition.memoListVisible);
    }
    if (transition.noteNavigationVisible !== undefined && transition.noteNavigationVisible !== noteNavigationVisible) {
      setNoteNavigationVisible(transition.noteNavigationVisible);
    }
  }, [
    memoListVisible,
    noteNavigationVisible,
  ]);

  // 双指横向滑动 → 切换左侧两列面板 (macOS only, hook 内部已判定平台)。
  // 手势矩阵 (tags × memolist):
  //   开 × 开   左滑 → 关闭 tags; 右滑 → no-op (两列都已开)
  //   开 × 关   左滑 → 关闭 tags; 右滑 → 打开 memolist
  //   关 × 开   左滑 → 关闭 memolist; 右滑 → 打开 tags
  //   关 × 关   左滑 → no-op (无可见面板可关); 右滑 → 打开 memolist
  // 守卫防止 set 在已是目标值时仍触发订阅者重渲 ── useSettingsStore
  // 没有 subscribeWithSelector, set 会通知所有订阅者。
  useMacosTrackpadSwipe({ onSwipe: handlePanelSwipe });

  const handleToggleNoteNavigation = useCallback(() => {
    setNoteNavigationVisible(!noteNavigationVisible);
  }, [noteNavigationVisible, setNoteNavigationVisible]);

  // 关闭 memo-list 侧栏时同步收起笔记导航 ── 避免左侧两列同时打开占满
  // 视口宽度。手势 (左滑) 走 resolvePanelSwipeTransition, 不经过此路径,
  // 不会触发级联关闭, 与手势的「只关一个」语义保持一致。
  const closeMemoListAndNoteNavigation = useCallback(() => {
    setMemoListVisible(false);
    if (noteNavigationVisible) {
      setNoteNavigationVisible(false);
    }
  }, [noteNavigationVisible, setMemoListVisible, setNoteNavigationVisible]);

  const collapseMemoList = useCallback(() => {
    setMemoListVisible(false);
  }, [setMemoListVisible]);

  // document 顶栏的侧栏 toggle: 打开走纯开, 关闭走级联 (带笔记导航)。
  // 中间列自己的标题栏按钮使用 collapseMemoList, 只折叠中间列并保留
  // 最左侧的笔记本/标签导航。
  const handleToggleMemoList = useCallback(() => {
    if (memoListVisible) {
      closeMemoListAndNoteNavigation();
    } else {
      setMemoListVisible(true);
    }
  }, [closeMemoListAndNoteNavigation, memoListVisible, setMemoListVisible]);

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

  // 监听 Edit notebook 弹窗内「移除笔记本」按钮 — 派发
  // `flowix:request-delete-notebook` 即可复用下方 NotebokDeleteDialog
  // 走标准的删除确认流程。 Edit 弹窗自己会先关掉, 这里只需要 set 一次。
  useEffect(() => {
    const handleRequest = (event: Event) => {
      const ce = event as CustomEvent<Notebook>;
      const notebook = ce.detail;
      if (!notebook) return;
      setNotebookToDelete(notebook);
    };
    window.addEventListener('flowix:request-delete-notebook', handleRequest as EventListener);
    return () => window.removeEventListener('flowix:request-delete-notebook', handleRequest as EventListener);
  }, []);

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

  const handleOpenPlugin = useCallback(async (plugin: PluginDescriptor) => {
    if (plugin.manifest.kind === 'artifact-tool') {
      // Mindmap and other artifact tools behave like list filters: update the
      // second column only and preserve the currently open work-column
      // document until the user selects an artifact from the list.
      if (workColumnTarget.kind === 'plugin-workbench') {
        clearPluginWorkbenchTarget();
      }
      setActiveFilter('all');
      setActivePluginId(plugin.manifest.id);
      setMemoListVisible(true);
      return;
    }
    // A pointer memo is rendered in the document area with higher priority
    // than the plugin workbench. Close the previous memo session first so a
    // plugin switch cannot leave the previous canvas mounted over the new
    // configuration panel.
    try {
      await openPluginWorkbench(plugin);
    } catch (error) {
      logger.warn('open plugin failed to clear document', { error });
      return;
    }
    setMemoListVisible(true);
  }, [setActiveFilter, setActivePluginId, setMemoListVisible, workColumnTarget.kind]);

  const handleNavigateBack = useCallback(() => {
    void navigateDocumentHistory('back');
  }, []);

  const handleNavigateForward = useCallback(() => {
    void navigateDocumentHistory('forward');
  }, []);

  const handleSelectNotebook = useCallback(
    (notebook: Notebook) => {
      if (selectedNotebook?.id === notebook.id) return;
      void selectNotebook(notebook).then(() => {
        triggerRefresh();
      }).catch((error) => {
        logger.warn('select notebook failed', { error });
      });
    },
    [selectedNotebook?.id, triggerRefresh]
  );

  const handleCreateNotebook = useCallback(() => {
    setNotebookCreateRequest((request) => request + 1);
  }, []);

  const handleEditNotebook = useCallback(
    (notebook: Notebook) => {
      // StatusBar closes its dropdown before invoking this callback. Defer the
      // dialog one tick so the close transition can start first.
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent<Notebook>('flowix:open-edit-notebook', { detail: notebook }));
      }, 0);
    },
    []
  );

  const handleDeleteNotebook = useCallback(
    (notebook: Notebook) => {
      // StatusBar already closed the popup; wait one tick before the dialog.
      setTimeout(() => {
        setNotebookToDelete(notebook);
      }, 0);
    },
    []
  );

  const handleConfirmDeleteNotebook = useCallback(async () => {
    const target = notebookToDelete;
    if (!target) return;
    try {
      if (selectedNotebook?.id === target.id) {
        // Deleting the active notebook is irreversible. Refuse the delete if
        // its current document cannot be durably flushed first.
        await flushWorkspaceDocument();
      }
      const ok = await notebooksClient.delete(target.id);
      if (ok) {
        const nbList = await notebooksClient.getAll();
        if (!nbList) throw new Error('Notebook list is unavailable after deletion');
        await reconcileDeletedNotebook(target.id, nbList);
        toast.success(t('shell.notebook.deleted'));
        triggerRefresh();
      } else {
        toast.error(t('shell.notebook.deleteFailed'));
      }
    } catch (error) {
      logger.warn('delete notebook failed', { error });
      toast.error(notebookDeleteErrorMessage(error, t));
    } finally {
      setNotebookToDelete(null);
    }
  }, [notebookToDelete, selectedNotebook?.id, triggerRefresh]);

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
          {/* Tags column (leftmost) */}
          <div
            className={`flex flex-col overflow-hidden will-change-[width] ${
              isDraggingNoteNavigationDivider ? 'transition-none' : 'transition-[width] duration-150 ease-out'
            }`}
            style={{ width: noteNavigationColumnWidth, flexShrink: 0 }}
            aria-hidden={!noteNavigationVisible}
            onPointerDown={() => focusWorkspaceHost('main-third')}
          >
            <div
              className="flex flex-col overflow-hidden h-full bg-[var(--agent-bg)] border-[var(--divider)] border-r"
              style={{ width: noteNavigationPanelWidth }}
            >
              {noteNavigationVisible && (
                <NoteNavigationPanel
                  notebooks={notebooks}
                  selectedNotebook={selectedNotebook}
                  onSelectNotebook={handleSelectNotebook}
                  onEditNotebook={handleEditNotebook}
                  onDeleteNotebook={handleDeleteNotebook}
                  onCreateNotebook={handleCreateNotebook}
                  onTogglePanel={handleToggleNoteNavigation}
                  onOpenPreferences={(tab) => void windows.openPreferences(tab)}
                  activePluginId={activePluginId}
                  onOpenPlugin={handleOpenPlugin}
                />
              )}
            </div>
          </div>
          {/* Tags <-> Memo list divider */}
          {noteNavigationVisible && (
            <div
              className="relative w-[1px] h-full cursor-col-resize group z-10"
              onMouseDown={handleNoteNavigationDividerMouseDown}
            >
              <div className="absolute inset-0 -translate-x-1/2 w-[12px] left-1/2 bg-transparent z-11" />
              <div className={`w-[1px] h-full transition-colors ${isDraggingNoteNavigationDivider ? 'bg-transparent' : 'group-hover:bg-transparent bg-transparent'}`} />
            </div>
          )}
          {/* Memo list column */}
          <div
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
                      ? 'absolute z-[1200] mb-1 flex w-[280px] flex-col overflow-hidden rounded-xl border border-[var(--border-popup)] bg-[var(--card)] pt-3 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)] ' +
                      (memoListPreviewPhase === 'open'
                        ? 'flowix-hover-preview-enter'
                        : 'flowix-hover-preview-leave')
                    : 'relative flex flex-1 flex-col min-h-0 min-w-0 w-full'
                }
                style={memoListPreviewVisible ? {
                  left: noteNavigationColumnWidth + 2,
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
                      navigationDrawerEnabled={!noteNavigationVisible}
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
                      <Suspense fallback={null}>
                        <AgentConversationListReadySignal
                          onReady={handleAgentConversationListReady}
                          isActive={isAgentConversationView}
                        />
                      </Suspense>
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
            <div className="relative flex-1 min-w-0 overflow-hidden">
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
          <StatusBar
            onSelectNotebook={handleSelectNotebook}
            onEditNotebook={handleEditNotebook}
            onDeleteNotebook={handleDeleteNotebook}
            onCreateNotebook={handleCreateNotebook}
            todoCount={todoCount}
            onOpenTodos={handleOpenTodos}
            onToggleNoteNavigation={handleToggleNoteNavigation}
            onOpenPreferences={() => windows.openPreferences()}
            onOpenMcpPreferences={() => windows.openPreferences('mcp')}
            onOpenDshPreferences={() => windows.openPreferences('dsh')}
            onOpenAgentConversationView={handleOpenAgentConversationView}
            dshDownload={dshDownload}
            updater={updater}
          />
        </div>
      </div>

      <NotebookDeleteDialog
        target={notebookToDelete ? { id: notebookToDelete.id, name: notebookToDelete.name } : null}
        onCancel={() => setNotebookToDelete(null)}
        onConfirm={handleConfirmDeleteNotebook}
      />

      <MemoListServicesHost
        notebookCreateRequest={notebookCreateRequest}
        onRefresh={triggerRefresh}
      />

      <FloatingPromptStack>
        <NavigationFailurePrompt />
        <AppUpdatePrompt updater={updater} />
        <DshInstallPrompt
          open={dshInstallPromptOpen}
          onClose={handleDshPromptClose}
          onIntroDisplayed={handleDshIntroDisplayed}
          onInstalled={handleDshInstalled}
        />
      </FloatingPromptStack>
    </div>
  );
}

function NavigationFailurePrompt() {
  const { t } = useI18n();
  const navigation = useWorkColumnStore((state) => state.navigation);
  const [retrying, setRetrying] = useState(false);
  const failure = navigation.phase === 'failed' ? navigation.failure : null;

  useEffect(() => {
    setRetrying(false);
  }, [failure?.requestId]);

  const handleRetry = async () => {
    if (!failure || retrying) return;
    setRetrying(true);
    try {
      await retryLastNavigation();
    } catch {
      // The coordinator publishes the new failure; keep this prompt open.
    } finally {
      setRetrying(false);
    }
  };

  return (
    <FloatingPrompt
      open={failure !== null}
      onClose={dismissNavigationFailure}
      className="p-4 pr-12"
    >
      <div className="space-y-3">
        <div>
          <div className="text-sm font-semibold text-[var(--foreground)]">
            {t('shell.navigation.failed')}
          </div>
          <div className="mt-1 break-words text-xs text-[var(--muted-foreground)]">
            {failure?.message}
          </div>
        </div>
        <Button type="button" size="sm" disabled={retrying} onClick={() => void handleRetry()}>
          {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {t('error.retry')}
        </Button>
      </div>
    </FloatingPrompt>
  );
}

function AppUpdatePrompt({ updater }: { updater: AppUpdaterState }) {
  const { t } = useI18n();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [installError, setInstallError] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const update = updater.update;
  const isDownloading = updater.status === 'downloading';
  const isInstalling = updater.status === 'installing';
  const isUpdating = isDownloading || isInstalling;

  useEffect(() => {
    if (update?.version && update.version !== dismissedVersion) {
      setInstallError(false);
    }
  }, [dismissedVersion, update?.version]);

  if (!update || (updater.status !== 'available' && !isUpdating) || update.version === dismissedVersion) {
    return null;
  }

  const handleInstall = async () => {
    setInstallError(false);
    try {
      await updater.installNow();
    } catch {
      setInstallError(true);
    }
  };

  const handleCancel = async () => {
    if (isCancelling) return;
    setIsCancelling(true);
    try {
      if (isUpdating) await updater.cancelNow();
      setDismissedVersion(update.version);
    } finally {
      setIsCancelling(false);
    }
  };

  const downloadPercent = updater.progress?.phase === 'progress' && updater.progress.contentLength
    ? Math.min(100, Math.round((updater.progress.downloadedBytes / updater.progress.contentLength) * 100))
    : null;

  return (
    <FloatingPrompt open onClose={() => void handleCancel()} className="p-0">
        <div className="px-5 py-5 text-left">
          <DialogHeader className="mb-0">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[color-mix(in_oklch,var(--primary)_12%,transparent)] text-[var(--primary)]">
              <ArrowUp className="h-7 w-7" aria-hidden="true" />
            </div>
            <DialogTitle className="mt-3 text-base">{t('appUpdates.available')}</DialogTitle>
            <DialogDescription className="mt-1 whitespace-pre-line text-xs leading-5">
              {update.body || t('appUpdates.description', { version: update.version })}
            </DialogDescription>
          </DialogHeader>

          <p className="mt-2 text-xs text-[var(--muted-foreground)]">
            {t('productUpdates.version', { version: update.version })}
          </p>

          {isUpdating && updater.progress && (
            <UpdateProgress
              className="mt-5"
              value={{
                percent: downloadPercent,
                downloadedBytes: updater.progress.phase === 'progress' ? updater.progress.downloadedBytes : undefined,
                totalBytes: updater.progress.phase === 'progress' ? updater.progress.contentLength : undefined,
              }}
              label={t(isDownloading ? 'appUpdates.downloading' : 'appUpdates.installing')}
            />
          )}

          {installError && <p className="mt-3 text-xs text-[var(--destructive)]">{t('appUpdates.installFailed')}</p>}

          <div className="mt-6 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => void handleCancel()} disabled={isCancelling}>
              {t('dialog.cancel')}
            </Button>
            <Button type="button" onClick={() => void handleInstall()} disabled={isUpdating}>
              {isUpdating && <Loader2 className="h-4 w-4 animate-spin" />}
              {isDownloading ? t('appUpdates.downloading') : isInstalling ? t('appUpdates.installing') : t('appUpdates.install')}
            </Button>
          </div>
        </div>
    </FloatingPrompt>
  );
}

function DshInstallPrompt({
  open,
  onClose,
  onIntroDisplayed,
  onInstalled,
}: {
  open: boolean;
  onClose: () => void;
  onIntroDisplayed: () => void;
  onInstalled: () => void;
}) {
  const { t } = useI18n();
  const { busy, error, progress, install, cancel } = useDshRuntimeInstaller();
  const canCancel = busy && progress?.phase !== 'downloaded' && progress?.phase !== 'installing';
  const [slide, setSlide] = useState<'mcp' | 'intro' | 'download'>('mcp');
  const [mcpCopied, setMcpCopied] = useState(false);
  const [checkingLocalAgents, setCheckingLocalAgents] = useState(false);
  const [localAgent, setLocalAgent] = useState<LocalAgentIntroOption | null>(null);
  const lastToastedInstallErrorRef = useRef<string | null>(null);
  const cliStatus = useCliLinkStatusStore((state) => state.status);
  const refreshCliStatus = useCliLinkStatusStore((state) => state.refreshIfStale);

  useEffect(() => {
    if (!open) return;
    void refreshCliStatus();
  }, [open, refreshCliStatus]);

  useEffect(() => {
    if (!open || !error) {
      lastToastedInstallErrorRef.current = null;
      return;
    }
    if (error && error !== lastToastedInstallErrorRef.current) {
      lastToastedInstallErrorRef.current = error;
      toast.error(`${t('preferences.dsh.setup.error')}: ${error}`);
    }
  }, [error, open, t]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCheckingLocalAgents(true);
    setLocalAgent(null);
    void agent.runtimeStatus()
      .then((status) => {
        if (cancelled) return;
        const detected = LOCAL_AGENT_INTRO_OPTIONS.find(({ key }) => status[key]?.available);
        setLocalAgent(detected ?? null);
      })
      .catch(() => {
        if (!cancelled) setLocalAgent(null);
      })
      .finally(() => {
        if (!cancelled) setCheckingLocalAgents(false);
      });
    return () => { cancelled = true; };
  }, [open]);

  const handleInstall = async () => {
    onIntroDisplayed();
    const status = await install();
    if (status) {
      toast.success(t('preferences.dsh.setup.installSuccess'));
      onInstalled();
    }
  };

  const handleCancel = async () => {
    if (await cancel()) toast.info(t('preferences.dsh.setup.cancelled'));
  };

  const handleCopyMcp = async () => {
    try {
      await navigator.clipboard.writeText(t('preferences.dsh.setup.mcp.copyContent', {
        command: cliStatus?.commandPath || 'flowix',
      }));
      setMcpCopied(true);
      toast.success(t('preferences.mcp.copied'));
      window.setTimeout(() => setMcpCopied(false), 1600);
    } catch {
      toast.error(t('preferences.mcp.copyFailed'));
    }
  };

  return (
    <FloatingPrompt open={open} onClose={onClose} className="max-h-[calc(100vh-2rem)] p-0">
        <div className="px-5 py-5 text-left">
          <div
            className="mb-5 flex items-center gap-1.5"
            role="tablist"
            aria-label={t('preferences.dsh.setup.carousel')}
          >
            <button
              type="button"
              role="tab"
              aria-selected={slide === 'mcp'}
              aria-label={t('preferences.dsh.setup.mcp.slide')}
              onClick={() => setSlide('mcp')}
              className={`h-1.5 rounded-full transition-[width,background-color] ${slide === 'mcp' ? 'w-7 bg-[var(--primary)]' : 'w-3 bg-[var(--muted)]'}`}
            />
            <button
              type="button"
              role="tab"
              aria-selected={slide === 'intro'}
              aria-label={t('preferences.dsh.setup.intro.slide')}
              onClick={() => setSlide('intro')}
              className={`h-1.5 rounded-full transition-[width,background-color] ${slide === 'intro' ? 'w-7 bg-[var(--primary)]' : 'w-3 bg-[var(--muted)]'}`}
            />
            <button
              type="button"
              role="tab"
              aria-selected={slide === 'download'}
              aria-label={t('preferences.dsh.setup.download.slide')}
              onClick={() => setSlide('download')}
              className={`h-1.5 rounded-full transition-[width,background-color] ${slide === 'download' ? 'w-7 bg-[var(--primary)]' : 'w-3 bg-[var(--muted)]'}`}
            />
          </div>

          <div
            className="relative overflow-hidden"
            aria-live="polite"
          >
            <div
              className="flex w-[300%] items-start transition-transform duration-300 ease-out will-change-transform"
              style={{
                transform: slide === 'mcp'
                  ? 'translateX(0)'
                  : slide === 'intro'
                    ? 'translateX(-33.333333%)'
                    : 'translateX(-66.666667%)',
              }}
            >
              <section className="w-1/3 shrink-0" aria-hidden={slide !== 'mcp'}>
                <DialogHeader className="mb-0">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[color-mix(in_oklch,var(--primary)_12%,transparent)] text-[var(--primary)]">
                    <Plug className="h-7 w-7" aria-hidden="true" />
                  </div>
                  <DialogTitle className="mt-3 text-base">
                    {t('preferences.dsh.setup.mcp.title')}
                  </DialogTitle>
                  <DialogDescription className="mt-1 whitespace-pre-line text-xs leading-5">
                    {t('preferences.dsh.setup.mcp.description')}
                  </DialogDescription>
                </DialogHeader>
              </section>

              <section className="w-1/3 shrink-0" aria-hidden={slide !== 'intro'}>
                <DialogHeader className="mb-0">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[color-mix(in_oklch,var(--primary)_12%,transparent)]">
                    <img
                      src={checkingLocalAgents ? iconFlowixAgent : localAgent?.icon ?? iconFlowixAgent}
                      alt=""
                      className="h-7 w-7 object-contain"
                    />
                  </div>
                  <DialogTitle className="mt-3 text-base">
                    {checkingLocalAgents
                      ? t('preferences.dsh.setup.intro.checking')
                      : localAgent
                        ? t('preferences.dsh.setup.intro.detected', { agent: t(localAgent.nameKey) })
                        : t('preferences.dsh.setup.intro.none')}
                  </DialogTitle>
                  {!checkingLocalAgents && (
                    <DialogDescription className="mt-1 whitespace-pre-line text-xs leading-5">
                      {t(
                        localAgent
                          ? 'preferences.dsh.setup.intro.description'
                          : 'preferences.dsh.setup.intro.noAgentDescription',
                      )}
                    </DialogDescription>
                  )}
                </DialogHeader>
              </section>

              <section className="w-1/3 shrink-0" aria-hidden={slide !== 'download'}>
                <DialogHeader className="mb-0">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[color-mix(in_oklch,var(--primary)_12%,transparent)]">
                    <AgentIcon typeKey="deepseek-harness" alt="" className="h-7 w-7" />
                  </div>
                  <DialogTitle className="mt-3 text-base">
                    {t('preferences.dsh.setup.promptTitle')}
                  </DialogTitle>
                  <DialogDescription className="mt-1 whitespace-pre-line text-xs leading-5">
                    {t('preferences.dsh.setup.promptDescription')}
                  </DialogDescription>
                </DialogHeader>

                {busy && progress && (
                  <UpdateProgress
                    className="mt-5 text-left"
                    value={progress}
                    label={t(progress.phase === 'installing' ? 'preferences.dsh.setup.installing' : 'preferences.dsh.setup.downloading')}
                    resumedLabel={t('preferences.dsh.setup.resumed')}
                  />
                )}

              </section>
            </div>
          </div>

          <div className="relative mt-6 min-h-8">
            <div
              className={`absolute inset-y-0 right-0 flex items-center gap-2 transition-opacity duration-200 ${slide === 'mcp' ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
              aria-hidden={slide !== 'mcp'}
            >
              <Button type="button" variant="outline" onClick={() => void handleCopyMcp()}>
                {mcpCopied && <Check className="h-4 w-4" />}
                {mcpCopied ? t('preferences.mcp.copied') : t('preferences.mcp.copy')}
              </Button>
              <Button type="button" onClick={() => setSlide('intro')}>
                {t('preferences.dsh.setup.next')}
              </Button>
            </div>
            <div
              className={`absolute inset-y-0 right-0 flex items-center gap-2 transition-opacity duration-200 ${slide === 'intro' ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
              aria-hidden={slide !== 'intro'}
            >
              <Button type="button" variant="outline" onClick={() => setSlide('mcp')}>
                {t('preferences.dsh.setup.previous')}
              </Button>
              <Button type="button" onClick={() => setSlide('download')}>
                {t('preferences.dsh.setup.next')}
              </Button>
            </div>
            <div
              className={`absolute inset-y-0 right-0 flex items-center gap-2 transition-opacity duration-200 ${slide === 'download' ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
              aria-hidden={slide !== 'download'}
            >
              <Button type="button" variant="outline" onClick={() => setSlide('intro')}>
                {t('preferences.dsh.setup.previous')}
              </Button>
              <Button type="button" onClick={() => void handleInstall()} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {busy ? t(progress?.phase === 'installing' ? 'preferences.dsh.setup.installing' : 'preferences.dsh.setup.downloading') : t('preferences.dsh.setup.install')}
              </Button>
              {canCancel && (
                <Button type="button" variant="outline" onClick={() => void handleCancel()}>
                  {t('preferences.dsh.setup.cancel')}
                </Button>
              )}
            </div>
          </div>
        </div>
    </FloatingPrompt>
  );
}
