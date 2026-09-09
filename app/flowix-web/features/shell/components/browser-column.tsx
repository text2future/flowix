import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useBrowserColumnStore,
} from '@features/workspace/store/browser-column-store';
import { BrowserColumnHeader } from './browser-column-header';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import {
  BrowserColumnSurfaceHost,
  type BrowserColumnFlushRegistration,
  resolveBrowserColumnSurface,
} from '@features/surface/browser-column-registry';
import {
  activateBrowserColumnTab,
  enqueueBrowserColumnNavigation,
  registerBrowserColumnDocumentFlush,
} from '@features/workspace/use-cases/browser-column-coordinator';
import { openBrowserColumnTabInWorkColumn } from '@features/workspace/use-cases/browser-column-navigation';

export interface BrowserColumnProps {
  width: number;
  layoutKey: string;
  onResize: (width: number) => void;
  toolbarCollapsed: boolean;
  onToolbarCollapsedChange: (collapsed: boolean) => void;
}

export function BrowserColumn({
  width,
  layoutKey,
  onResize,
  toolbarCollapsed,
  onToolbarCollapsedChange,
}: BrowserColumnProps) {
  const [isTabMenuOpen, setIsTabMenuOpen] = useState(false);
  const [contextMenuTabId, setContextMenuTabId] = useState<string | null>(null);
  const tabs = useBrowserColumnStore((state) => state.tabs);
  const activeTabId = useBrowserColumnStore((state) => state.activeTabId);
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs],
  );
  const closeTab = useBrowserColumnStore((state) => state.closeTab);
  const closeOtherTabs = useBrowserColumnStore((state) => state.closeOtherTabs);
  const closeTabsToRight = useBrowserColumnStore((state) => state.closeTabsToRight);
  const closeAllTabs = useBrowserColumnStore((state) => state.closeAllTabs);
  const reorderTab = useBrowserColumnStore((state) => state.reorderTab);
  const focusHost = useWorkspaceFocusStore((state) => state.focusHost);
  const focusedHostId = useWorkspaceFocusStore((state) => state.focusedHostId);
  const activeMemoId = activeTab?.target.kind === 'memo' ? activeTab.target.memoId : null;
  const activeWebRuntime = useBrowserColumnStore((state) => (
    activeTabId && activeTab?.target.kind === 'web'
      ? state.webRuntimes[activeTabId] ?? null
      : null
  ));
  const activeMemoHasDuplicateTab = activeMemoId !== null
    && tabs.filter((tab) => tab.target.kind === 'memo' && tab.target.memoId === activeMemoId).length > 1;
  const registerActiveFlush = useCallback<BrowserColumnFlushRegistration>((flush) => {
    if (activeTabId === null) return;
    registerBrowserColumnDocumentFlush(activeTabId, flush);
  }, [activeTabId]);
  const handleSelectTab = useCallback((tabId: string) => {
    return activateBrowserColumnTab(tabId);
  }, []);
  const handleCloseTab = useCallback((tabId: string) => {
    void enqueueBrowserColumnNavigation(() => {
      const state = useBrowserColumnStore.getState();
      if (!state.tabs.some((tab) => tab.id === tabId)) return;
      closeTab(tabId);
    });
  }, [closeTab]);
  const handleCloseOtherTabs = useCallback((tabId: string) => {
    void enqueueBrowserColumnNavigation(() => {
      const state = useBrowserColumnStore.getState();
      if (!state.tabs.some((tab) => tab.id === tabId)) return;
      closeOtherTabs(tabId);
    });
  }, [closeOtherTabs]);
  const handleCloseTabsToRight = useCallback((tabId: string) => {
    void enqueueBrowserColumnNavigation(() => {
      const state = useBrowserColumnStore.getState();
      const tabIndex = state.tabs.findIndex((tab) => tab.id === tabId);
      if (tabIndex < 0) return;
      closeTabsToRight(tabId);
    });
  }, [closeTabsToRight]);
  const handleCloseAllTabs = useCallback(() => {
    void enqueueBrowserColumnNavigation(() => {
      closeAllTabs();
    });
  }, [closeAllTabs]);
  const handleContextMenuOpenChange = useCallback((tabId: string, open: boolean) => {
    setContextMenuTabId((current) => {
      if (open) return tabId;
      return current === tabId ? null : current;
    });
  }, []);
  useEffect(() => {
    if (contextMenuTabId && !tabs.some((tab) => tab.id === contextMenuTabId)) {
      setContextMenuTabId(null);
    }
  }, [contextMenuTabId, tabs]);
  const nativeOverlayOpen = isTabMenuOpen || contextMenuTabId !== null;
  const activeSurface = activeTab
    ? resolveBrowserColumnSurface(
        activeTab,
        // Cross-column editing ownership is controlled by DocumentContainer.
        activeMemoHasDuplicateTab,
        registerActiveFlush,
        activeWebRuntime,
        toolbarCollapsed,
        onToolbarCollapsedChange,
        layoutKey,
        nativeOverlayOpen,
      )
    : null;
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef({ x: 0, width });

  useEffect(() => {
    if (!isResizing) return;
    const handlePointerMove = (event: PointerEvent) => {
      const delta = resizeStartRef.current.x - event.clientX;
      onResize(resizeStartRef.current.width + delta);
    };
    const stopResizing = () => setIsResizing(false);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResizing, { once: true });
    window.addEventListener('pointercancel', stopResizing, { once: true });
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResizing);
      window.removeEventListener('pointercancel', stopResizing);
    };
  }, [isResizing, onResize]);


  return (
    <section
      data-workspace-host="browser-column"
      data-workspace-focused={focusedHostId === 'browser-column' ? '' : undefined}
      aria-label="浏览器列辅助工作区"
      onPointerDown={() => focusHost('browser-column')}
      onFocusCapture={() => focusHost('browser-column')}
      className={'relative flex h-full min-w-0 shrink-0 flex-col border-l border-[var(--divider)] bg-[var(--document-bg)]'}
      style={{ width }}
    >
      <div
        role="separator"
        aria-label="调整浏览器列宽度"
        aria-orientation="vertical"
        tabIndex={0}
        aria-valuenow={Math.round(width)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          onResize(width + (event.key === 'ArrowLeft' ? 20 : -20));
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          resizeStartRef.current = { x: event.clientX, width };
          setIsResizing(true);
        }}
        className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize focus-visible:outline-none focus-visible:bg-[var(--brand)]"
      />
      <BrowserColumnHeader
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        onCloseOtherTabs={handleCloseOtherTabs}
        onCloseTabsToRight={handleCloseTabsToRight}
        onCloseAllTabs={handleCloseAllTabs}
        onOpenTabInWorkColumn={(tabId) => { void openBrowserColumnTabInWorkColumn(tabId); }}
        onReorderTab={reorderTab}
        isTabMenuOpen={isTabMenuOpen}
        onTabMenuOpenChange={setIsTabMenuOpen}
        onContextMenuOpenChange={handleContextMenuOpenChange}
      />
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {activeSurface ? (
          <BrowserColumnSurfaceHost
            key={activeSurface.instanceKey}
            surface={activeSurface}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-8 text-center text-sm text-[var(--muted-foreground)]">
            选择一个 tab 打开内容
          </div>
        )}
      </div>
    </section>
  );
}
