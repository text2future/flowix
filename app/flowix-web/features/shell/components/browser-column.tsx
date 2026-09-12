import { useCallback, useEffect, useRef, useState } from 'react';
import {
  closeAllBrowserColumnTabs,
  closeBrowserColumnTab,
  closeBrowserColumnTabsToRight,
  closeOtherBrowserColumnTabs,
  hideBrowserColumn,
  openBrowserColumnTabInMainWorkColumn,
  registerBrowserColumnFlush,
  reorderBrowserColumnTab,
  selectBrowserColumnTab,
  useBrowserColumnFocusViewModel,
  useBrowserColumnViewModel,
} from '@features/workspace/public/browser-column-api';
import { BrowserColumnHeader } from './browser-column-header';
import { useI18n } from '@/lib/i18n';
import {
  BrowserColumnSurfaceHost,
  type BrowserColumnFlushRegistration,
  resolveBrowserColumnSurface,
} from '@features/surface/public/shell-api';

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
  const { t } = useI18n();
  const [isTabMenuOpen, setIsTabMenuOpen] = useState(false);
  const [contextMenuTabId, setContextMenuTabId] = useState<string | null>(null);
  const {
    tabs,
    activeTabId,
    activeTab,
    activeWebRuntime,
    activeMemoHasDuplicateTab,
  } = useBrowserColumnViewModel();
  const { isFocused, focusBrowserColumn } = useBrowserColumnFocusViewModel();
  const registerActiveFlush = useCallback<BrowserColumnFlushRegistration>((flush, discard) => {
    if (activeTabId === null) return;
    registerBrowserColumnFlush(activeTabId, flush, discard);
  }, [activeTabId]);
  const handleSelectTab = useCallback((tabId: string) => {
    return selectBrowserColumnTab(tabId);
  }, []);
  const closeWithDiscardFallback = useCallback(async (
    close: (discardChanges: boolean) => Promise<boolean | null>,
  ) => {
    const closed = await close(false);
    if (closed !== null) return;
    if (!window.confirm(t('tabWindow.confirmDiscardChanges'))) return;
    await close(true);
  }, [t]);
  const handleCloseTab = useCallback((tabId: string) => (
    closeWithDiscardFallback((discardChanges) => (
      closeBrowserColumnTab(tabId, { discardChanges })
    ))
  ), [closeWithDiscardFallback]);
  const handleCloseOtherTabs = useCallback((tabId: string) => (
    closeWithDiscardFallback((discardChanges) => (
      closeOtherBrowserColumnTabs(tabId, { discardChanges })
    ))
  ), [closeWithDiscardFallback]);
  const handleCloseTabsToRight = useCallback((tabId: string) => (
    closeWithDiscardFallback((discardChanges) => (
      closeBrowserColumnTabsToRight(tabId, { discardChanges })
    ))
  ), [closeWithDiscardFallback]);
  const handleCloseAllTabs = useCallback(() => (
    closeWithDiscardFallback((discardChanges) => (
      closeAllBrowserColumnTabs({ discardChanges })
    ))
  ), [closeWithDiscardFallback]);
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
      data-workspace-focused={isFocused ? '' : undefined}
      aria-label="浏览器列辅助工作区"
      onPointerDown={focusBrowserColumn}
      onFocusCapture={focusBrowserColumn}
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
        onOpenTabInWorkColumn={(tabId) => { void openBrowserColumnTabInMainWorkColumn(tabId); }}
        onReorderTab={reorderBrowserColumnTab}
        isTabMenuOpen={isTabMenuOpen}
        onTabMenuOpenChange={setIsTabMenuOpen}
        onCloseColumn={hideBrowserColumn}
        onContextMenuOpenChange={handleContextMenuOpenChange}
        isFocused={isFocused}
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
