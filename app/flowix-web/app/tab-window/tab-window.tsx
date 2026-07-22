'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useShallow } from 'zustand/react/shallow';
import { DocumentTitlebarMac } from '@features/document/components/document-titlebar-mac';
import { DocumentTitlebarWin } from '@features/document/components/document-titlebar-win';
import { useDocumentCommands } from '@features/document/components/use-document-commands';
import { useDocumentStore } from '@features/document/store';
import { useMemoStore } from '@features/memo';
import { registerMemoEventHandler } from '@/lib/memo-dispatcher';
import { displayTitleFromFilename } from '@/lib/utils';
import { errorMessage } from '@/lib/error-message';
import { toast } from '@/lib/toast';
import { windows, type WindowPosition, type WindowTab } from '@platform/tauri/client';
import { MarkdownFileDropOverlay } from '@features/shell/components/drag-overlay/markdown-file-drop-overlay';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Kbd } from '@shared/ui/kbd';
import { useI18n, type I18nParams } from '@features/i18n';
import type { MemoEvent } from '@/types/memo';
import { TabStrip } from './tab-strip';
import { FLOWIX_TAB_DRAG_TYPE } from './tab-tear-off';
import { adjacentTabId, useTabWindowStore } from './tab-window-store';
import { TabContent } from './tab-content';
import { TabActivationCoordinator } from './tab-activation-coordinator';
import {
  hydrateMemoTab,
  memoIdForTab,
  updateMemoTabMetadata,
  useMemoTabMetadataStore,
} from './memo-tab-adapter';

const WINDOW_FALLBACK_TITLE = 'Flowix';
const WINDOW_OPEN_TAB_EVENT = 'flowix:window-open-tab';
const WINDOW_MERGE_HOVER_EVENT = 'flowix:window-merge-hover';
const WINDOW_ROLLBACK_TAB_EVENT = 'flowix:window-rollback-tab';
const NOOP = () => {};

function isWindowsPlatform(): boolean {
  return /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform);
}

function unsupportedTarget(target: never): never {
  throw new Error(`Unsupported tab target: ${JSON.stringify(target)}`);
}

interface MergeHoverPayload {
  active: boolean;
  tab: WindowTab | null;
  targetLabel: string;
}

interface WindowOpenTabPayload {
  tab: WindowTab;
  transferId: string | null;
  targetLabel: string;
}

interface WindowRollbackTabPayload {
  tabId: string;
  transferId: string;
}

interface TabWindowError {
  message: string;
  tabId: string | null;
}

export function TabWindow() {
  const { t } = useI18n();
  const [error, setError] = useState<TabWindowError | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(false);
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
  const [mergePreview, setMergePreview] = useState<WindowTab | null>(null);
  const contentRef = useRef('');
  const closingWindowRef = useRef(false);
  const closingTabIdsRef = useRef(new Set<string>());
  const receivedLiveTabRef = useRef(false);
  const activationCoordinatorRef = useRef(new TabActivationCoordinator());
  const tabDragStartPromisesRef = useRef(new Map<string, Promise<void>>());
  const receivedTransfersRef = useRef(new Map<string, string>());

  const { tabs, activeTabId, requestedTabId } = useTabWindowStore(
    useShallow((state) => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      requestedTabId: state.requestedTabId,
    })),
  );
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs],
  );
  const windowTitle = useMemo(() => {
    const firstDocumentTab = tabs.find((tab) => tab.target.kind !== 'web');
    return displayTitleFromFilename(firstDocumentTab?.title) || WINDOW_FALLBACK_TITLE;
  }, [tabs]);
  const activeMemoId = memoIdForTab(activeTab);
  const currentMemo = useMemoTabMetadataStore((state) => (
    activeMemoId ? state.byMemoId[activeMemoId] ?? null : null
  ));

  const {
    currentDocumentPath,
    currentDocumentSource,
    activeMemoSession,
    activeExternalSession,
    isDocumentTransitioning,
    openMemoDocument,
    openExternalDocument,
    clearDocument,
    discardMemoDocument,
  } = useDocumentStore(useShallow((state) => ({
    currentDocumentPath: state.currentDocumentPath,
    currentDocumentSource: state.currentDocumentSource,
    activeMemoSession: state.activeMemoSession,
    activeExternalSession: state.activeExternalSession,
    isDocumentTransitioning: state.isDocumentTransitioning,
    openMemoDocument: state.openMemoDocument,
    openExternalDocument: state.openExternalDocument,
    clearDocument: state.clearDocument,
    discardMemoDocument: state.discardMemoDocument,
  })));

  const activateTab = useCallback((tabId: string): Promise<boolean> => {
    setError(null);
    useTabWindowStore.getState().request(tabId);
    return activationCoordinatorRef.current.request(tabId, async (requestedId, isLatest) => {
      const tab = useTabWindowStore.getState().tabs.find((candidate) => candidate.id === requestedId);
      if (!tab) return false;
      try {
        switch (tab.target.kind) {
          case 'memo': {
            const documentState = useDocumentStore.getState();
            if (
              useTabWindowStore.getState().activeTabId === requestedId
              && documentState.activeMemoSession?.memoId === tab.target.memoId
              && useMemoTabMetadataStore.getState().byMemoId[tab.target.memoId]
            ) {
              useTabWindowStore.getState().commit(requestedId);
              return true;
            }
            const session = await hydrateMemoTab(tab);
            if (!session) throw new Error(`Memo is unavailable: ${tab.target.memoId}`);

            const latestTab = useTabWindowStore.getState().tabs.find(
              (candidate) => candidate.id === requestedId,
            );
            if (latestTab?.target.kind === 'memo') {
              useTabWindowStore.getState().update(requestedId, {
                title: session.memo.filename,
                icon: session.memo.icon ?? null,
                target: {
                  ...latestTab.target,
                  notebookId: session.notebookId,
                  notebookPath: session.notebookPath,
                  filePath: session.path,
                },
              });
            }
            // Metadata remains useful if this request was superseded, but do
            // not flush or mount an editor for an obsolete user intent.
            if (!isLatest()) return false;
            await openMemoDocument({
              memoId: tab.target.memoId,
              path: session.path,
              notebookId: session.notebookId,
              notebookPath: session.notebookPath,
              history: 'skip',
              initialContent: session.content,
            });
            break;
          }
          case 'external_markdown':
            if (!isLatest()) return false;
            await openExternalDocument(tab.target.filePath);
            break;
          case 'web':
            if (!isLatest()) return false;
            await clearDocument();
            break;
          default:
            unsupportedTarget(tab.target);
        }
        useTabWindowStore.getState().commit(requestedId, !isLatest());
        setError(null);
        return true;
      } catch (err) {
        if (isLatest()) {
          setError({ message: errorMessage(err), tabId: requestedId });
        }
        return false;
      }
    });
  }, [clearDocument, openExternalDocument, openMemoDocument]);

  const closeWindowAfterFlush = useCallback(async () => {
    if (closingWindowRef.current) return;
    closingWindowRef.current = true;
    try {
      await activationCoordinatorRef.current.waitForIdle();
      await clearDocument();
      await getCurrentWindow().destroy();
    } catch (err) {
      closingWindowRef.current = false;
      setError({ message: errorMessage(err), tabId: activeTabId });
    }
  }, [activeTabId, clearDocument]);

  const closeTab = useCallback((tabId: string, sourceWasDeleted = false) => {
    if (closingTabIdsRef.current.has(tabId)) return;
    closingTabIdsRef.current.add(tabId);
    void (async () => {
      try {
        await activationCoordinatorRef.current.waitForIdle();
        const state = useTabWindowStore.getState();
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        if (!tab) return;
        let nextId: string | null = null;
        if (sourceWasDeleted && tab.target.kind === 'memo') {
          await discardMemoDocument(tab.target.memoId);
        }
        if (state.tabs.length === 1) {
          if (sourceWasDeleted) {
            closingWindowRef.current = true;
            await getCurrentWindow().destroy();
          } else {
            await closeWindowAfterFlush();
          }
          return;
        }
        if (state.activeTabId === tabId) {
          nextId = adjacentTabId(state.tabs, tabId);
          if (!nextId || !await activateTab(nextId)) return;
        }
        await windows.closeTabWindowTab(tabId);
        const store = useTabWindowStore.getState();
        if (nextId) store.removeAndSelect(tabId, nextId);
        else store.remove(tabId);
        const memoId = memoIdForTab(tab);
        if (memoId) useMemoTabMetadataStore.getState().remove(memoId);
        setError((current) => current?.tabId === tabId ? null : current);
        setDeleteDialogOpen(false);
        setIsSearchPanelOpen(false);
      } finally {
        closingTabIdsRef.current.delete(tabId);
      }
    })().catch((err) => toast.error(errorMessage(err)));
  }, [activateTab, closeWindowAfterFlush, discardMemoDocument]);

  const detachTab = useCallback((
    tabId: string,
    position: WindowPosition,
    dragId: string,
  ) => {
    if (closingTabIdsRef.current.has(tabId)) return;
    closingTabIdsRef.current.add(tabId);
    void (async () => {
      let clearedOnlyTab = false;
      try {
        await tabDragStartPromisesRef.current.get(dragId);
        await activationCoordinatorRef.current.waitForIdle();
        const state = useTabWindowStore.getState();
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        if (!tab) return;

        const isOnlyTab = state.tabs.length === 1;
        let nextId: string | null = null;
        if (state.activeTabId === tabId) {
          if (isOnlyTab) {
            // A new Webview cannot share this realm's in-memory editor. Flush
            // the document before the backend exposes the tab to that host.
            await clearDocument();
            clearedOnlyTab = true;
          } else {
            nextId = adjacentTabId(state.tabs, tabId);
            if (!nextId || !await activateTab(nextId)) return;
          }
        }

        const result = await windows.detachTabWindowTab(tabId, position, dragId);
        if (isOnlyTab && !result.merged) {
          // A single tab dropped outside another tab host is a no-op. Restore
          // the document that was flushed in case the drop became a transfer.
          await activateTab(tabId);
          return;
        }
        const store = useTabWindowStore.getState();
        if (nextId) store.removeAndSelect(tabId, nextId);
        else store.remove(tabId);
        const memoId = memoIdForTab(tab);
        if (memoId) useMemoTabMetadataStore.getState().remove(memoId);
        setDeleteDialogOpen(false);
        setIsSearchPanelOpen(false);

        if (isOnlyTab) {
          closingWindowRef.current = true;
          await getCurrentWindow().destroy();
        }
      } catch (err) {
        // Window creation is transactional in the backend. If this was the
        // only tab, restore the flushed document in the still-valid source UI.
        if (clearedOnlyTab) void activateTab(tabId);
        toast.error(errorMessage(err));
      } finally {
        tabDragStartPromisesRef.current.delete(dragId);
        closingTabIdsRef.current.delete(tabId);
      }
    })();
  }, [activateTab, clearDocument]);

  const beginTabItemDrag = useCallback((
    tabId: string,
    dragId: string,
  ) => {
    const start = windows.beginTabItemDrag(tabId, dragId);
    tabDragStartPromisesRef.current.set(dragId, start);
    void start.catch((err) => {
      toast.error(errorMessage(err));
    });
  }, []);

  const cancelTabItemDrag = useCallback((tabId: string, dragId: string) => {
    void (async () => {
      await tabDragStartPromisesRef.current.get(dragId);
      await windows.cancelTabItemDrag(tabId, dragId);
    })().catch(() => {}).finally(() => {
      tabDragStartPromisesRef.current.delete(dragId);
    });
  }, []);

  const reorderTab = useCallback((tabId: string, beforeTabId: string | null) => {
    void windows.reorderTabWindowTab(tabId, beforeTabId).then(() => {
      useTabWindowStore.getState().reorder(tabId, beforeTabId);
    }).catch((err) => {
      toast.error(errorMessage(err));
    });
  }, []);

  const updateTabRegion = useCallback((region: Parameters<typeof windows.setTabWindowRegion>[0]) => {
    void windows.setTabWindowRegion(region).catch((err) => {
      toast.error(errorMessage(err));
    });
  }, []);

  const handleTabDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(FLOWIX_TAB_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };

  const handleTabDrop = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes(FLOWIX_TAB_DRAG_TYPE)) event.preventDefault();
  };

  const updateMemoMeta = useMemoStore((state) => state.updateMemoMeta);
  const setMemoColors = useMemoStore((state) => state.setMemoColors);
  const commands = useDocumentCommands({
    currentDocumentPath,
    getCurrentDocumentContent: useCallback(() => contentRef.current, []),
    currentMemo,
    updateMemoMeta,
    setMemoColors,
  });

  useEffect(() => {
    let disposed = false;
    const unlistens: UnlistenFn[] = [];
    const retainListener = (unlisten: UnlistenFn) => {
      if (disposed) {
        unlisten();
        return false;
      }
      unlistens.push(unlisten);
      return true;
    };
    void (async () => {
      const currentWindowLabel = getCurrentWindow().label;
      const unlistenOpen = await listen<WindowOpenTabPayload>(WINDOW_OPEN_TAB_EVENT, (event) => {
        if (event.payload.targetLabel !== currentWindowLabel) return;
        receivedLiveTabRef.current = true;
        const { tab, transferId } = event.payload;
        useTabWindowStore.getState().add(tab);
        if (transferId) {
          receivedTransfersRef.current.set(tab.id, transferId);
          void windows.ackTabWindowTransfer(transferId, tab.id).catch((err) => {
            toast.error(errorMessage(err));
          });
        }
        void activateTab(tab.id);
      });
      if (!retainListener(unlistenOpen)) return;
      const unlistenRollback = await listen<WindowRollbackTabPayload>(WINDOW_ROLLBACK_TAB_EVENT, (event) => {
        const { tabId, transferId } = event.payload;
        if (receivedTransfersRef.current.get(tabId) !== transferId) return;
        receivedTransfersRef.current.delete(tabId);
        closeTab(tabId);
      });
      if (!retainListener(unlistenRollback)) return;
      const initialTabs = await windows.tabWindowReady();
      if (disposed) return;
      useTabWindowStore.getState().hydrate(initialTabs);
      const initialId = initialTabs[initialTabs.length - 1]?.id;
      if (!disposed && initialId && !receivedLiveTabRef.current) await activateTab(initialId);
    })().catch((err) => {
      if (!disposed) setError({ message: errorMessage(err), tabId: null });
    });
    return () => {
      disposed = true;
      for (const unlisten of unlistens) unlisten();
    };
  }, [activateTab, closeTab]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    const currentWindowLabel = getCurrentWindow().label;
    void listen<MergeHoverPayload>(WINDOW_MERGE_HOVER_EVENT, (event) => {
      if (!disposed && event.payload.targetLabel === currentWindowLabel) {
        setMergePreview(event.payload.active ? event.payload.tab : null);
      }
    }).then((next) => {
      if (disposed) next();
      else unlisten = next;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => registerMemoEventHandler((event: MemoEvent) => {
    if (event.kind === 'updated') {
      updateMemoTabMetadata(event.memo);
      const tabId = `memo:${event.id}`;
      const tab = useTabWindowStore.getState().tabs.find((candidate) => candidate.id === tabId);
      if (tab?.target.kind === 'memo') {
        useTabWindowStore.getState().update(tabId, {
          title: event.memo.filename,
          icon: event.memo.icon ?? null,
          target: { ...tab.target, filePath: event.path },
        });
      }
      useDocumentStore.getState().replaceActiveMemoPath(event.id, event.path);
    } else if (event.kind === 'deleted') {
      closeTab(`memo:${event.id}`, true);
    }
  }, (event) => {
    // tags_renamed 不动单 tab 的文档区 ── 它是 metadata 事件, tab 自己
    // 不持有 tag 状态, 跟 tab 关闭路径无关。 直接放行 (filter=false)。
    if (event.kind === 'tags_renamed') return false;
    const id = event.kind === 'created' ? event.memo.id : event.id;
    return event.kind !== 'created'
      && useTabWindowStore.getState().tabs.some((tab) => tab.id === `memo:${id}`);
  }), [closeTab]);

  useEffect(() => {
    document.title = windowTitle;
    void getCurrentWindow().setTitle(windowTitle).catch(() => {
      // Browser preview or unavailable Tauri window API.
    });
  }, [windowTitle]);

  useEffect(() => {
    const currentWindow = getCurrentWindow();
    let unlisten: UnlistenFn | undefined;
    void currentWindow.onCloseRequested((event) => {
      if (closingWindowRef.current) return;
      event.preventDefault();
      void closeWindowAfterFlush();
    }).then((next) => { unlisten = next; });
    return () => unlisten?.();
  }, [closeWindowAfterFlush]);

  const tabStrip = (
    <TabStrip
      tabs={tabs}
      selectedTabId={requestedTabId ?? activeTabId}
      onSelect={(id) => { void activateTab(id); }}
      onClose={closeTab}
      onDetach={detachTab}
      onTabDragStart={beginTabItemDrag}
      onTabDragCancel={cancelTabItemDrag}
      onReorder={reorderTab}
      onRegionChange={updateTabRegion}
      mergePreview={mergePreview}
    />
  );

  const errorTab = error?.tabId
    ? tabs.find((tab) => tab.id === error.tabId) ?? null
    : null;
  const errorView = error ? (
    <div
      role="alert"
      className="flex min-h-0 flex-1 items-center justify-center px-6 py-10"
    >
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <h2 className="text-base font-semibold text-[var(--foreground)]">{t('error.title')}</h2>
        {errorTab && (
          <p className="mt-1 max-w-full truncate text-sm text-[var(--muted-foreground)]">
            {displayTitleFromFilename(errorTab.title)}
          </p>
        )}
        <p className="mt-3 max-h-32 max-w-full overflow-auto break-words rounded-lg bg-[var(--muted)]/45 px-3 py-2 text-left text-sm leading-6 text-[var(--muted-foreground)]">
          {error.message}
        </p>
      </div>
    </div>
  ) : null;

  const loadingView = (
    <div className="flex min-h-0 flex-1 items-center justify-center" role="status" aria-label="Loading">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-[color-mix(in_oklch,var(--muted-foreground)_26%,transparent)] border-t-[var(--brand)]" />
    </div>
  );

  if (error && tabs.length === 0) {
    return (
      <div className="flex h-screen w-screen flex-col overflow-hidden text-[var(--foreground)]" style={{ backgroundColor: 'var(--document-bg)' }}>
        <WindowsTitlebarControls />
        <MarkdownFileDropOverlay />
        <div data-tauri-drag-region className={isWindowsPlatform() ? 'h-9 shrink-0 pr-[126px]' : 'h-12 shrink-0'} />
        {errorView}
      </div>
    );
  }

  const handleDelete = () => {
    if (!currentMemo) return;
    void useMemoStore.getState().deleteMemo(currentMemo.id).then((ok) => {
      if (ok) closeTab(`memo:${currentMemo.id}`, true);
    });
  };
  const titlebarProps = {
    currentMemo,
    isSidebarHidden: false,
    onToggleSidebar: NOOP,
    canNavigateBack: false,
    canNavigateForward: false,
    onNavigateBack: NOOP,
    onNavigateForward: NOOP,
    showNavigationButtons: false,
    onOpenSearch: () => setIsSearchPanelOpen(true),
    onCopyLink: commands.handleCopyLink,
    onCopyFullText: commands.handleCopyFullText,
    onOpenProperties: () => currentMemo && window.dispatchEvent(new CustomEvent('flowix:open-note-properties', { detail: { memoId: currentMemo.id } })),
    onTogglePin: commands.handleTogglePin,
    onExportMarkdown: commands.handleExportMarkdown,
    onSaveAsTemplate: commands.handleSaveAsTemplate,
    onExportWord: commands.handleExportWord,
    onRequestDeleteMemo: () => currentMemo && setDeleteDialogOpen(true),
    onColorsChange: commands.handleColorsChange,
    externalFilePath: currentDocumentSource === 'external' ? currentDocumentPath : null,
    windowTabs: tabStrip,
  };

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden text-[var(--foreground)]"
      style={{ backgroundColor: 'var(--document-bg)' }}
      onDragOver={handleTabDragOver}
      onDrop={handleTabDrop}
    >
      <WindowsTitlebarControls />
      <MarkdownFileDropOverlay />
      {isWindowsPlatform() ? <DocumentTitlebarWin {...titlebarProps} /> : <DocumentTitlebarMac {...titlebarProps} />}
      {error ? errorView : activeTab ? (
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <TabContent
            tab={activeTab}
            contentKey={activeMemoSession?.id ?? activeExternalSession?.id ?? activeTab.id}
            memoContentProps={{
              filePath: currentDocumentPath ?? (
                activeTab.target.kind === 'memo' || activeTab.target.kind === 'external_markdown'
                  ? activeTab.target.filePath
                  : ''
              ),
              notebookId: activeMemoSession?.notebookId ?? null,
              notebookPath: activeMemoSession?.notebookPath ?? null,
              transitionId:
                activeMemoSession?.transitionId
                ?? activeExternalSession?.transitionId
                ?? null,
              isExternalDocument: activeTab.target.kind === 'external_markdown',
              searchPanelOpen: isSearchPanelOpen,
              onSearchPanelOpenChange: setIsSearchPanelOpen,
              toolbarCollapsed,
              onToolbarCollapsedChange: setToolbarCollapsed,
              onMetainfoData: (data) => { contentRef.current = data.memoContent; },
            }}
          />
          {isDocumentTransitioning && <div className="absolute inset-0 z-40 flex items-center justify-center bg-[color-mix(in_oklch,var(--card)_78%,transparent)] backdrop-blur-[1px]" role="status" aria-label="Loading"><div className="h-5 w-5 animate-spin rounded-full border-2 border-[color-mix(in_oklch,var(--muted-foreground)_26%,transparent)] border-t-[var(--brand)]" /></div>}
        </div>
      ) : loadingView}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent><DialogHeader><DialogTitle>{t('memo.delete.title')}</DialogTitle><DialogDescription>{t('memo.delete.description', { name: displayTitleFromFilename(currentMemo?.filename) } satisfies I18nParams)}</DialogDescription></DialogHeader><div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setDeleteDialogOpen(false)} className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]">{t('memo.delete.cancel')}</button><button type="button" onClick={handleDelete} className="relative h-8 rounded-lg bg-[var(--destructive)] pl-3 pr-7 text-sm text-white hover:opacity-90">{t('memo.delete.confirm')}<Kbd className="!text-white border-0">↵</Kbd></button></div></DialogContent>
      </Dialog>
    </div>
  );
}
