'use client';

import { useState, useEffect, useRef, useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import { MenuBoard } from '@features/shell/components/menu-board';
import { DocumentContainer } from '@features/document/components/document-container';
import { DocumentTitlebarWin } from '@features/document/components/document-titlebar-win';
import { DocumentTitlebarMac } from '@features/document/components/document-titlebar-mac';
import { MemoList } from '@features/memo/components/memo-list';
import { MemoListTitlebarWin } from '@features/memo/components/memo-list-titlebar-win';
import { MemoListTitlebarMac } from '@features/memo/components/memo-list-titlebar-mac';
import { NoteNavigationPanel } from '@features/memo/components/note-navigation-panel';
import { useTauriRpc } from '@platform/tauri/use-tauri-rpc';
import { useDocumentHistoryStore, useDocumentStore, type DocumentHistoryEntry, type MemoDocumentSession } from '@features/document/store';
import { useMemoStore, type MemoItem, type Notebook } from '@features/memo';
import { useSettingsStore } from '@features/shell';
import { useShallow } from 'zustand/react/shallow';
import { notebooks as notebooksClient, windows } from '@platform/tauri/client';
import { notebookDeleteErrorMessage } from '@platform/tauri/errors';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import { toast } from '@/lib/toast';
import { canonicalPath, getDocumentInstanceKey } from '@/lib/path';
import { navigateDocumentHistory } from '@/lib/document-navigation';
import { StatusBar } from '@features/shell/components/status-bar/status-bar';
import { NotebookDeleteDialog } from '@features/shell/components/notebook-delete-dialog';
import { FullscreenDragOverlay } from '@features/shell/components/drag-overlay/fullscreen-drag-overlay';
import { useDocumentCommands } from '@features/document/components/use-document-commands';
import { useExternalDocumentOpen } from '@features/document/components/use-external-document-open';
import { useNotebookTodoCount } from '@features/memo/components/use-notebook-todo-count';
import { useResizablePanels } from '@features/shell/hooks/use-resizable-panels';
import { useMacosTrackpadSwipe, type MacosTrackpadSwipeDirection } from '@features/shell/hooks/use-macos-trackpad-swipe';
import backgroundImage from '@/assets/bg.document.png';
import { useI18n } from '@features/i18n';

const NOTE_NAVIGATION_PANEL_WIDTH = 192;
const NOTE_NAVIGATION_PANEL_MIN_WIDTH = 180;
const NOTE_NAVIGATION_PANEL_MAX_WIDTH = 420;
const DOCUMENT_PANEL_MIN_WIDTH = 420;
const PANEL_DIVIDER_WIDTH = 1;

function isWindowsPlatform(): boolean {
  return /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform);
}

function isDifferentHistoryTarget(entry: DocumentHistoryEntry, activeMemoSession: MemoDocumentSession | null): boolean {
  if (entry.kind !== 'memo') return true;
  if (!activeMemoSession) return true;
  return (
    entry.memoId !== activeMemoSession.memoId ||
    canonicalPath(entry.path) !== canonicalPath(activeMemoSession.path)
  );
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
  const activeSort = useMemoStore((s) => s.activeSort);

  const memoActions = useMemoStore(
    useShallow((s) => ({
      setActiveFilter: s.setActiveFilter,
      loadMemos: s.loadMemos,
      setSelectedMemo: s.setSelectedMemo,
      setSelectedNotebook: s.setSelectedNotebook,
      setNotebooks: s.setNotebooks,
      triggerRefresh: s.triggerRefresh,
      updateMemoMeta: s.updateMemoMeta,
      setMemoColors: s.setMemoColors,
    })),
  );
  const {
    setActiveFilter,
    loadMemos,
    setSelectedMemo,
    setSelectedNotebook,
    setNotebooks,
    triggerRefresh,
    updateMemoMeta,
    setMemoColors,
  } = memoActions;

  const {
    currentDocumentPath,
    currentDocumentSource,
    activeMemoSession,
    activeExternalSession,
    isDocumentTransitioning,
    openExternalDocument: openExternalDocumentSession,
    clearDocument,
  } = useDocumentStore(
    useShallow((s) => ({
      currentDocumentPath: s.currentDocumentPath,
      currentDocumentSource: s.currentDocumentSource,
      activeMemoSession: s.activeMemoSession,
      activeExternalSession: s.activeExternalSession,
      isDocumentTransitioning: s.isDocumentTransitioning,
      openExternalDocument: s.openExternalDocument,
      clearDocument: s.clearDocument,
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
  const canNavigateBack = useDocumentHistoryStore((s) => (
    s.backStack.some((entry) => isDifferentHistoryTarget(entry, activeMemoSession))
  ));
  const canNavigateForward = useDocumentHistoryStore((s) => (
    s.forwardStack.some((entry) => isDifferentHistoryTarget(entry, activeMemoSession))
  ));
  const [isMenuBoardOpen, setIsMenuBoardOpen] = useState(false);
  const [notebookPopupOpen, setNotebookPopupOpen] = useState(false);
  const [notebookToDelete, setNotebookToDelete] = useState<Notebook | null>(null);
  const { request } = useTauriRpc();
  const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(false);
  const [charCount, setCharCount] = useState(0);
  const [noteNavigationPanelWidth, setNoteNavigationPanelWidth] = useState(NOTE_NAVIGATION_PANEL_WIDTH);
  const [isDraggingNoteNavigationDivider, setIsDraggingNoteNavigationDivider] = useState(false);
  const currentDocumentContentRef = useRef('');
  const noteNavigationDividerStartRef = useRef({
    x: 0,
    width: NOTE_NAVIGATION_PANEL_WIDTH,
  });
  const noteNavigationPanelWidthRef = useRef(NOTE_NAVIGATION_PANEL_WIDTH);
  // tags 面板独立成最左列, 宽度走自己的 state。
  const noteNavigationColumnWidth = noteNavigationVisible ? noteNavigationPanelWidth : 0;
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

  // document 顶栏的侧栏 toggle: 打开走纯开, 关闭走级联 (带笔记导航),
  // 行为与 memo-list 顶栏的折叠按钮对齐 ── 任一入口关闭都同步收起左侧
  // 两列。
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
  const { isDraggingFiles } = useExternalDocumentOpen({
    openExternalDocumentSession,
    setSelectedMemo,
  });
  const getCurrentDocumentContent = useCallback(() => currentDocumentContentRef.current, []);
  const {
    handleCopyFullText,
    handleCopyLink,
    handleCopyExternalPath,
    handleTogglePin,
    handleColorsChange,
    handleExportMarkdown,
    handleSaveAsTemplate,
    handleExportWord,
  } = useDocumentCommands({
    currentDocumentPath,
    getCurrentDocumentContent,
    currentMemo,
    isExternalDocument,
    updateMemoMeta,
    setMemoColors,
  });

  // The DocumentContainer owns the import hook (it needs the editor's
  // contentRef + saveDoc) but the titlebar renders the file path and the
  // "保存为笔记" button. We bridge them: container publishes its api upward
  // via onExternalImportApiChange, we hold it here, and feed it to the
  // titlebar. The setter is memoized so the container's effect doesn't
  // re-fire on every parent render.
  const [externalImportApi, setExternalImportApi] = useState<{
    isSaving: boolean;
    save: () => void;
  } | null>(null);
  const handleExternalImportApiChange = useCallback(
    (api: { isSaving: boolean; save: () => void } | null) => {
      setExternalImportApi(api);
    },
    [],
  );

  useEffect(() => {
    currentDocumentContentRef.current = '';
  }, [currentDocumentInstanceKey]);

  // 切换 memo 时关闭搜索面板 — 搜索/替换的 matches 是基于当前 editor state,
  // 切到新 memo 后旧结果毫无意义, 应当随切换重置。
  useEffect(() => {
    setIsSearchPanelOpen(false);
  }, [currentDocumentInstanceKey]);

  // 监听 ⌘⇧N 切换笔记本下拉面板 — 状态留在 MainLayout 内部,
  // 走与 memo-list.tsx 的 `flowix:toggle-palette` 同款 CustomEvent 解耦模式。
  // setNotebookPopupOpen 用 prev 回调实现 toggle 语义, 二次触发即关闭。
  useEffect(() => {
    const handleToggle = () => setNotebookPopupOpen(prev => !prev);
    window.addEventListener('flowix:toggle-notebook-switcher', handleToggle);
    return () => window.removeEventListener('flowix:toggle-notebook-switcher', handleToggle);
  }, []);

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
    setMemoListVisible(true);
    setActiveFilter('todos');
    await loadMemos({
      notebookId: selectedNotebook?.id,
      filter: 'todos',
      sort: activeSort,
    });
  }, [activeSort, loadMemos, selectedNotebook?.id, setActiveFilter, setMemoListVisible]);

  const handleNavigateBack = useCallback(() => {
    void navigateDocumentHistory('back');
  }, []);

  const handleNavigateForward = useCallback(() => {
    void navigateDocumentHistory('forward');
  }, []);

  const handleSelectNotebook = useCallback(
    (notebook: Notebook) => {
      if (selectedNotebook?.id === notebook.id) return;
      setSelectedNotebook(notebook);
      setSelectedMemo(null);
      clearDocument();
      triggerRefresh();
      void request('set_current_notebook', { notebookId: notebook.id }).catch((error) => {
        console.warn('[MainLayout] Failed to sync current notebook:', error);
      });
    },
    [clearDocument, request, selectedNotebook?.id, setSelectedMemo, setSelectedNotebook, triggerRefresh]
  );

  const handleEditNotebook = useCallback(
    (notebook: Notebook) => {
      // Close the dropdown first so it doesn't overlap the dialog.
      setNotebookPopupOpen(false);
      // Defer to next tick so the dropdown finishes closing before the dialog opens.
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent<Notebook>('flowix:open-edit-notebook', { detail: notebook }));
      }, 0);
    },
    []
  );

  const handleDeleteNotebook = useCallback(
    (notebook: Notebook) => {
      // Close the dropdown so the confirmation dialog isn't visually stacked
      // on top of the popup, then open the confirmation dialog on the next
      // tick (the dropdown needs a frame to start its close transition).
      setNotebookPopupOpen(false);
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
      const ok = await notebooksClient.delete(target.id);
      if (ok) {
        toast.success(t('shell.notebook.deleted'));
        const nbList = await notebooksClient.getAll();
        if (nbList) {
          setNotebooks(nbList);
          if (selectedNotebook?.id === target.id) {
            const nextNotebook = nbList[0] ?? null;
            setSelectedNotebook(nextNotebook);
            setSelectedMemo(null);
            clearDocument();
            await notebooksClient.setCurrent(nextNotebook?.id ?? null);
            triggerRefresh();
          }
        }
      } else {
        toast.error(t('shell.notebook.deleteFailed'));
      }
    } catch (error) {
      console.warn('[MainLayout] Failed to delete notebook:', error);
      toast.error(notebookDeleteErrorMessage(error));
    } finally {
      setNotebookToDelete(null);
    }
  }, [clearDocument, notebookToDelete, selectedNotebook?.id, setNotebooks, setSelectedMemo, setSelectedNotebook, triggerRefresh]);

  // Document titlebar's more → delete menu: hand off to MemoList, which owns
  // the delete-memo confirmation dialog. We use a custom event (same pattern
  // as the notebook edit dialog) so MainLayout doesn't need to lift MemoList's
  // state up.
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

  return (
    <div className="flex h-screen w-screen overflow-hidden" style={{ backgroundColor: 'var(--document-bg)' }}>
      <WindowsTitlebarControls />
      <FullscreenDragOverlay visible={isDraggingFiles} />
      <MenuBoard open={isMenuBoardOpen} onOpenChange={setIsMenuBoardOpen} />
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="flex flex-1 h-full overflow-hidden">
          {/* Tags column (leftmost) */}
          <div
            className={`flex flex-col overflow-hidden will-change-[width] ${
              isDraggingNoteNavigationDivider ? 'transition-none' : 'transition-[width] duration-150 ease-out'
            }`}
            style={{ width: noteNavigationColumnWidth, flexShrink: 0 }}
            aria-hidden={!noteNavigationVisible}
          >
            <div
              className="flex flex-col overflow-hidden h-full bg-[var(--agent-bg)] border-[var(--border)] border-r"
              style={{ width: noteNavigationPanelWidth }}
            >
              {noteNavigationVisible && (
                <NoteNavigationPanel
                  notebooks={notebooks}
                  selectedNotebook={selectedNotebook}
                  onSelectNotebook={handleSelectNotebook}
                  onEditNotebook={handleEditNotebook}
                  onTogglePanel={handleToggleNoteNavigation}
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
            className={`flex flex-col overflow-hidden will-change-[width] ${
              isDraggingListDivider ? 'transition-none' : 'transition-[width] duration-150 ease-out'
            }`}
            style={{ width: memoListWidth, flexShrink: 0 }}
            aria-hidden={isMemoListHidden}
          >
            <div
              className="flex flex-col overflow-hidden h-full bg-[var(--card)] border-[var(--border)] border-r"
              style={{ width: memoColWidth }}
            >
              {isWindowsPlatform() ? (
                <MemoListTitlebarWin
                  onCollapseSidebar={closeMemoListAndNoteNavigation}
                  onToggleNoteNavigation={handleToggleNoteNavigation}
                  onOpenPreferences={() => windows.openPreferences()}
                />
              ) : (
                <MemoListTitlebarMac
                  noteNavigationVisible={noteNavigationVisible}
                  onCollapseSidebar={closeMemoListAndNoteNavigation}
                  onToggleNoteNavigation={handleToggleNoteNavigation}
                  onOpenPreferences={() => windows.openPreferences()}
                />
              )}
              <div className="flex-1 min-h-0">
                <MemoList />
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
          {/* Memo detail */}
            <div className="h-full min-w-0 relative flex flex-col" style={{ minWidth: DOCUMENT_PANEL_MIN_WIDTH, flex: 1 }}>
            {/* Fixed top navigation bar */}
            {isWindowsPlatform() ? (
              <DocumentTitlebarWin
                currentMemo={currentMemo}
                isSidebarHidden={isMemoListHidden}
                onToggleSidebar={handleToggleMemoList}
                canNavigateBack={canNavigateBack}
                canNavigateForward={canNavigateForward}
                onNavigateBack={handleNavigateBack}
                onNavigateForward={handleNavigateForward}
                onOpenSearch={() => setIsSearchPanelOpen(true)}
                onCopyLink={handleCopyLink}
                onCopyFullText={handleCopyFullText}
                onOpenProperties={handleOpenNoteProperties}
                onTogglePin={handleTogglePin}
                onExportMarkdown={handleExportMarkdown}
                onSaveAsTemplate={handleSaveAsTemplate}
                onExportWord={handleExportWord}
                onRequestDeleteMemo={handleRequestDeleteMemo}
                onColorsChange={handleColorsChange}
                externalFilePath={isExternalDocument ? currentDocumentPath : null}
                isExternalSaving={externalImportApi?.isSaving ?? false}
                onSaveExternalToMemo={externalImportApi?.save}
                onCopyExternalPath={isExternalDocument ? handleCopyExternalPath : undefined}
              />
            ) : (
              <DocumentTitlebarMac
                currentMemo={currentMemo}
                isSidebarHidden={isMemoListHidden}
                onToggleSidebar={handleToggleMemoList}
                canNavigateBack={canNavigateBack}
                canNavigateForward={canNavigateForward}
                onNavigateBack={handleNavigateBack}
                onNavigateForward={handleNavigateForward}
                onOpenSearch={() => setIsSearchPanelOpen(true)}
                onCopyLink={handleCopyLink}
                onCopyFullText={handleCopyFullText}
                onOpenProperties={handleOpenNoteProperties}
                onTogglePin={handleTogglePin}
                onExportMarkdown={handleExportMarkdown}
                onSaveAsTemplate={handleSaveAsTemplate}
                onExportWord={handleExportWord}
                onRequestDeleteMemo={handleRequestDeleteMemo}
                onColorsChange={handleColorsChange}
                externalFilePath={isExternalDocument ? currentDocumentPath : null}
                isExternalSaving={externalImportApi?.isSaving ?? false}
                onSaveExternalToMemo={externalImportApi?.save}
                onCopyExternalPath={isExternalDocument ? handleCopyExternalPath : undefined}
              />
            )}

            {/* Content area */}
            <div className="relative flex-1 min-w-0 overflow-hidden">
              {currentDocumentPath ? (
                <DocumentContainer
                  key={currentDocumentInstanceKey}
                  filePath={currentDocumentPath}
                  memoId={activeMemoSession?.memoId ?? null}
                  notebookId={activeMemoSession?.notebookId ?? null}
                  notebookPath={activeMemoSession?.notebookPath ?? null}
                  transitionId={activeMemoSession?.transitionId ?? activeExternalSession?.transitionId ?? null}
                  isExternalDocument={isExternalDocument}
                  searchPanelOpen={isSearchPanelOpen}
                  onSearchPanelOpenChange={setIsSearchPanelOpen}
                  toolbarCollapsed={toolbarCollapsed}
                  onToolbarCollapsedChange={setToolbarCollapsed}
                  onMetainfoData={(data) => {
                    currentDocumentContentRef.current = data.memoContent;
                  }}
                  onCharCountChange={setCharCount}
                  onExternalImportApiChange={handleExternalImportApiChange}
                />
              ) : (
                <div className="relative flex h-full w-full items-center justify-center">
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 bg-no-repeat bg-bottom bg-[length:auto_800px] opacity-[0.32]"
                    style={{ backgroundImage: `url(${backgroundImage})` }}
                  />
                  <span className="relative text-center text-[var(--muted-foreground)] text-sm">
                    {t('shell.emptyDocument')}
                  </span>
                </div>
              )}
              {isDocumentTransitioning && (
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
          </div>
          {/* Status bar */}
          <StatusBar
            memoColWidth={memoColWidth}
            notebooks={notebooks}
            selectedNotebook={selectedNotebook}
            notebookPopupOpen={notebookPopupOpen}
            setNotebookPopupOpen={setNotebookPopupOpen}
            onSelectNotebook={handleSelectNotebook}
            onEditNotebook={handleEditNotebook}
            onDeleteNotebook={handleDeleteNotebook}
            onRefreshNotebooks={(nbList) => setNotebooks(nbList)}
            todoCount={todoCount}
            onOpenTodos={handleOpenTodos}
            charCount={charCount}
            onToggleNoteNavigation={handleToggleNoteNavigation}
            onOpenPreferences={() => windows.openPreferences()}
          />
        </div>
      </div>

      <NotebookDeleteDialog
        target={notebookToDelete ? { id: notebookToDelete.id, name: notebookToDelete.name } : null}
        onCancel={() => setNotebookToDelete(null)}
        onConfirm={handleConfirmDeleteNotebook}
      />
    </div>
  );
}
