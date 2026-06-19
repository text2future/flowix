'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { MenuBoard } from './menu-board';
import { DocumentContainer } from './document-pane/document-container';
import { DocumentTitlebarWin } from './document-pane/document-titlebar-win';
import { DocumentTitlebarMac } from './document-pane/document-titlebar-mac';
import { MemoList } from './memo-pane/memo-list';
import { MemoListTitlebarWin } from './memo-pane/memo-list-titlebar-win';
import { MemoListTitlebarMac } from './memo-pane/memo-list-titlebar-mac';
import { LazyAgentPanel } from './agent-panel/lazy-agent-panel';
import { useTauriRpc } from '../../lib/hooks/useTauriRpc';
import { useMemoStore, useDocumentStore, useDocumentHistoryStore, useSettingsStore, type DocumentHistoryEntry, type MemoDocumentSession, type Notebook, type MemoItem } from '../../lib/store';
import { useShallow } from 'zustand/react/shallow';
import { notebooks as notebooksClient, windows } from '../../lib/tauri/client';
import { WindowsTitlebarControls } from '../../components/windows-titlebar-controls';
import { toast } from '../../lib/toast';
import { canonicalPath, getDocumentInstanceKey } from '../../lib/path';
import { navigateDocumentHistory } from '../../lib/document-navigation';
import { StatusBar } from './status-bar/status-bar';
import { NotebookDeleteDialog } from './notebook-delete-dialog';
import { FullscreenDragOverlay } from './drag-overlay/fullscreen-drag-overlay';
import { useDocumentCommands } from './document-pane/use-document-commands';
import { useExternalDocumentOpen } from './document-pane/use-external-document-open';
import { useNotebookTodoCount } from './memo-pane/use-notebook-todo-count';
import backgroundImage from '../../assets/bg.document.png';

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

export function MainLayout() {
  // 切片订阅：每个 useStore 只取真正用到的字段，setter 走 useShallow 聚合。
  // 替代原来的 `useMemoStore()` / `useDocumentStore()` / `useSettingsStore()`
  // 全量订阅 —— 任何 set 都会让 MainLayout 整树重渲，跨菜单栏 / 状态栏 /
  // document 容器一起抖。切到 selector 后, 只在用到的字段变化时本组件
  // 才重渲, memo-list / document-container 各自独立订阅, 互不污染。
  const memos = useMemoStore((s) => s.memos);
  const notebooks = useMemoStore((s) => s.notebooks);
  const selectedMemo = useMemoStore((s) => s.selectedMemo);
  const selectedNotebook = useMemoStore((s) => s.selectedNotebook);
  const refreshTrigger = useMemoStore((s) => s.refreshTrigger);
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
    agentPanelVisible,
    agentColWidth,
    setMemoListVisible,
    toggleMemoListVisible,
    toggleAgentPanelVisible,
    setAgentColWidth,
  } = useSettingsStore(
    useShallow((s) => ({
      memoListVisible: s.memoListVisible,
      agentPanelVisible: s.agentPanelVisible,
      agentColWidth: s.agentColWidth,
      setMemoListVisible: s.setMemoListVisible,
      toggleMemoListVisible: s.toggleMemoListVisible,
      toggleAgentPanelVisible: s.toggleAgentPanelVisible,
      setAgentColWidth: s.setAgentColWidth,
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
  const [memoColWidth, setMemoColWidth] = useState(320);
  const [agentPanelDraftWidth, setAgentPanelDraftWidth] = useState(agentColWidth);
  const [isDraggingListDivider, setIsDraggingListDivider] = useState(false);
  const [isDraggingAgentDivider, setIsDraggingAgentDivider] = useState(false);
  const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(false);
  // Toolbar collapsed — owned here, controlled by the toolbar's own collapse/expand
  // buttons. Session-only.
  const [isToolbarCollapsed, setIsToolbarCollapsed] = useState(false);
  const [charCount, setCharCount] = useState(0);
  const currentDocumentContentRef = useRef('');
  const listDividerStartRef = useRef({ x: 0, width: 0 });
  const agentDividerStartRef = useRef({ x: 0, width: agentColWidth });
  const agentPanelDraftWidthRef = useRef(agentColWidth);
  const isMemoListHidden = !memoListVisible;
  const memoListWidth = isMemoListHidden ? 0 : memoColWidth;
  const agentPanelWidth = agentPanelVisible ? agentPanelDraftWidth : 0;

  useEffect(() => {
    if (isDraggingAgentDivider) return;
    setAgentPanelDraftWidth(agentColWidth);
    agentPanelDraftWidthRef.current = agentColWidth;
  }, [agentColWidth, isDraggingAgentDivider]);

  // Memo list divider drag
  const handleListDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingListDivider(true);
    listDividerStartRef.current = { x: e.clientX, width: memoColWidth };
  }, [memoColWidth]);

  // Agent panel divider drag
  const handleAgentDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingAgentDivider(true);
    agentDividerStartRef.current = { x: e.clientX, width: agentPanelDraftWidth };
    agentPanelDraftWidthRef.current = agentPanelDraftWidth;
  }, [agentPanelDraftWidth]);

  useEffect(() => {
    if (!isDraggingListDivider && !isDraggingAgentDivider) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingListDivider) {
        const diff = e.clientX - listDividerStartRef.current.x;
        const newW = listDividerStartRef.current.width + diff;
        if (newW >= 150 && newW <= 500) setMemoColWidth(newW);
      }
      if (isDraggingAgentDivider) {
        const diff = agentDividerStartRef.current.x - e.clientX;
        const newW = agentDividerStartRef.current.width + diff;
        if (newW >= 200 && newW <= 600) {
          agentPanelDraftWidthRef.current = newW;
          setAgentPanelDraftWidth(newW);
        }
      }
    };

    const handleMouseUp = () => {
      if (isDraggingAgentDivider) {
        setAgentColWidth(agentPanelDraftWidthRef.current);
      }
      setIsDraggingListDivider(false);
      setIsDraggingAgentDivider(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingListDivider, isDraggingAgentDivider, setAgentColWidth]);

  // Narrow window: opening the agent panel auto-collapses the memo list to
  // reclaim horizontal space. We only act on the false→true transition, so
  // once the agent panel is open the user can freely re-open the memo list
  // without us fighting them.
  const prevAgentPanelVisibleRef = useRef(agentPanelVisible);
  useEffect(() => {
    if (
      agentPanelVisible &&
      !prevAgentPanelVisibleRef.current &&
      window.innerWidth < 1100 &&
      memoListVisible
    ) {
      setMemoListVisible(false);
    }
    prevAgentPanelVisibleRef.current = agentPanelVisible;
  }, [agentPanelVisible, memoListVisible, setMemoListVisible]);

  const currentMemo = currentDocumentPath && currentDocumentSource === 'memo' && activeMemoSession
    ? memos.find((memo) => memo.id === activeMemoSession.memoId)
      ?? (selectedMemo?.id === activeMemoSession.memoId ? selectedMemo : null)
    : null;
  const isExternalDocument = currentDocumentSource === 'external';
  const currentDocumentInstanceKey =
    currentDocumentSource === 'memo' && activeMemoSession
      ? activeMemoSession.id
      : activeExternalSession?.id ?? (currentDocumentPath ? getDocumentInstanceKey(currentDocumentPath) : null);
  const todoCount = useNotebookTodoCount(selectedNotebook?.path, refreshTrigger, memos.length);
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
    async (notebook: Notebook) => {
      if (selectedNotebook?.id === notebook.id) return;
      setSelectedNotebook(notebook);
      setSelectedMemo(null);
      clearDocument();
      try {
        await request('set_current_notebook', { notebookId: notebook.id });
      } catch (error) {
        console.warn('[MainLayout] Failed to sync current notebook:', error);
      }
      triggerRefresh();
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
      if (notebook.isDefault) {
        toast.error('默认笔记本不可删除');
        return;
      }
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
        toast.success('已删除');
        const nbList = await notebooksClient.getAll();
        if (nbList) setNotebooks(nbList);
      } else {
        toast.error('删除失败');
      }
    } catch (error) {
      console.warn('[MainLayout] Failed to delete notebook:', error);
      toast.error('删除失败');
    } finally {
      setNotebookToDelete(null);
    }
  }, [notebookToDelete, setNotebooks]);

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

  return (
    <div className="flex h-screen w-screen overflow-hidden" style={{ backgroundColor: 'var(--document-bg)' }}>
      <WindowsTitlebarControls />
      <FullscreenDragOverlay visible={isDraggingFiles} />
      <MenuBoard open={isMenuBoardOpen} onOpenChange={setIsMenuBoardOpen} />
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="flex flex-1 h-full overflow-hidden">
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
                  onCollapseSidebar={() => setMemoListVisible(false)}
                  onOpenPreferences={() => windows.openPreferences()}
                />
              ) : (
                <MemoListTitlebarMac
                  onCollapseSidebar={() => setMemoListVisible(false)}
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
            <div className="h-full min-w-0 relative flex flex-col" style={{ minWidth: 200, flex: 1 }}>
            {/* Fixed top navigation bar */}
            {isWindowsPlatform() ? (
              <DocumentTitlebarWin
                currentMemo={currentMemo}
                isSidebarHidden={isMemoListHidden}
                isAgentPanelVisible={agentPanelVisible}
                onToggleSidebar={toggleMemoListVisible}
                canNavigateBack={canNavigateBack}
                canNavigateForward={canNavigateForward}
                onNavigateBack={handleNavigateBack}
                onNavigateForward={handleNavigateForward}
                onOpenSearch={() => setIsSearchPanelOpen(true)}
                onCopyLink={handleCopyLink}
                onCopyFullText={handleCopyFullText}
                onTogglePin={handleTogglePin}
                onExportMarkdown={handleExportMarkdown}
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
                onToggleSidebar={toggleMemoListVisible}
                canNavigateBack={canNavigateBack}
                canNavigateForward={canNavigateForward}
                onNavigateBack={handleNavigateBack}
                onNavigateForward={handleNavigateForward}
                onOpenSearch={() => setIsSearchPanelOpen(true)}
                onCopyLink={handleCopyLink}
                onCopyFullText={handleCopyFullText}
                onTogglePin={handleTogglePin}
                onExportMarkdown={handleExportMarkdown}
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
                  toolbarCollapsed={isToolbarCollapsed}
                  onToolbarCollapsedChange={setIsToolbarCollapsed}
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
                    请选择一个文档
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
          {/* Agent chat panel divider */}
            <div
              className={`relative h-full group z-10 overflow-hidden ${
                isDraggingAgentDivider ? 'transition-none' : 'transition-[width,opacity] duration-150 ease-out'
              } ${
                agentPanelVisible ? 'cursor-col-resize opacity-100' : 'pointer-events-none opacity-0'
              }`}
              style={{ width: agentPanelVisible ? 1 : 0, flexShrink: 0 }}
              onMouseDown={agentPanelVisible ? handleAgentDividerMouseDown : undefined}
            >
              <div className="absolute inset-0 -translate-x-1/2 w-[12px] left-1/2 bg-transparent z-11" />
              <div className="w-[1px] h-full transition-colors bg-transparent" />
            </div>
          {/* Agent chat panel */}
            <div
              className={`h-full flex-shrink-0 overflow-hidden will-change-[width] ${
                isDraggingAgentDivider ? 'transition-none' : 'transition-[width] duration-150 ease-out'
              }`}
              style={{ width: agentPanelWidth }}
              aria-hidden={!agentPanelVisible}
            >
              <div
                className="h-full overflow-hidden bg-[var(--agent-bg)] border-[var(--border)] border-l"
                style={{ width: agentPanelDraftWidth }}
              >
                {agentPanelVisible && <LazyAgentPanel onClosePanel={toggleAgentPanelVisible} />}
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
            onToggleAgentPanel={toggleAgentPanelVisible}
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
