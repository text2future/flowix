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
import { toast } from '@/lib/toast';
import { useNoteStore } from '@features/memo/store/note-store';
import { noteRepository } from '@features/memo/services';
import { openBrowserColumnAgentConversation, openBrowserColumnNotebookNote } from '@features/workspace/use-cases/browser-column-navigation';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { buildInitialInstanceRuntimeConfig } from '@features/agent/store/initial-runtime-config';
import type { AgentTypeKey } from '@/types/agent';
import {
  captureLatestDocumentContent,
  getDocumentEditorMode,
  setDocumentEditorMode,
} from '@features/document/public/shell-api';
import { documentIdentityFromFile } from '@features/document/public/shell-api';
import { requireFileDisplayIdentity } from '@/lib/file-display-registry';
import {
  BrowserColumnSurfaceHost,
  getBrowserColumnSurfaceDefinition,
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

/**
 * Give React's optimistic tab-header update one real paint before mounting the
 * next surface. A large Markdown document can otherwise monopolize the same
 * frame and keep the new tab background invisible until parsing is finished.
 */
function waitForTabHeaderPaint(): Promise<void> {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(fallback);
      resolve();
    };
    const fallback = window.setTimeout(finish, 50);
    window.requestAnimationFrame(() => {
      // The optimistic header is painted between these two frame callbacks.
      window.requestAnimationFrame(finish);
    });
  });
}

export function BrowserColumn({
  width,
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
    activePathHasDuplicateTab,
  } = useBrowserColumnViewModel();
  const { isFocused, focusBrowserColumn } = useBrowserColumnFocusViewModel();
  const selectedNotebook = useNoteStore((state) => state.selectedNotebook);
  const handleCreateNote = useCallback(async () => {
    if (!selectedNotebook) return;
    try {
      const created = await noteRepository.create(undefined, selectedNotebook.id);
      useNoteStore.getState().upsertCreatedNote(created);
      await openBrowserColumnNotebookNote(created.path, selectedNotebook.id, selectedNotebook.path);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('tabWindow.createNote.failed'));
    }
  }, [selectedNotebook, t]);
  const handleCreateAgentConversation = useCallback(async (typeKey: AgentTypeKey) => {
    if (!selectedNotebook) return;
    const instance = useAgentSessionStore.getState().createInstance({
      agentType: typeKey,
      title: '',
      threadId: null,
      source: { kind: 'dedicated', notebookId: selectedNotebook.id, documentPath: null },
      runtimeConfig: buildInitialInstanceRuntimeConfig(typeKey),
    });
    try {
      await openBrowserColumnAgentConversation(instance.instanceId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('tabWindow.createConversation.failed'));
    }
  }, [selectedNotebook, t]);
  const registerActiveFlush = useCallback<BrowserColumnFlushRegistration>((flush, discard) => {
    if (activeTabId === null) return;
    registerBrowserColumnFlush(activeTabId, flush, discard);
  }, [activeTabId]);
  const handleSelectTab = useCallback(async (tabId: string) => {
    await waitForTabHeaderPaint();
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
  const handleToggleMemoEditorMode = useCallback((tabId: string) => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (tab?.target.kind !== 'file-browser' || !tab.target.activeFilePath) return;

    const identity = documentIdentityFromFile(
      requireFileDisplayIdentity(tab.target.activeFilePath),
    );
    // Publish the latest CodeMirror / rich-text content before replacing the
    // editor subtree. The browser-column host keeps this isolated from a
    // possible copy of the same memo in the main work column.
    captureLatestDocumentContent(identity, 'browser-column');
    const currentMode = getDocumentEditorMode('browser-column', identity);
    setDocumentEditorMode(
      'browser-column',
      identity,
      currentMode === 'source' ? 'rich' : 'source',
    );
  }, [tabs]);
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
  const activeSurface = activeTab
    ? resolveBrowserColumnSurface(
        activeTab,
        // Cross-column editing ownership is controlled by DocumentContainer.
        activePathHasDuplicateTab,
        registerActiveFlush,
        activeWebRuntime,
        toolbarCollapsed,
        onToolbarCollapsedChange,
      )
    : null;
  const activeSurfaceChrome = activeSurface
    ? getBrowserColumnSurfaceDefinition(activeSurface).chrome
    : 'document';
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
        className="absolute inset-y-0 -left-[5px] z-20 w-[11px] cursor-col-resize focus-visible:outline-none focus-visible:bg-[var(--brand)]"
      />
      <BrowserColumnHeader
        tabs={tabs}
        activeTabId={activeTabId}
        activeSurfaceChrome={activeSurfaceChrome}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        onCloseOtherTabs={handleCloseOtherTabs}
        onCloseTabsToRight={handleCloseTabsToRight}
        onCloseAllTabs={handleCloseAllTabs}
        onToggleMemoEditorMode={handleToggleMemoEditorMode}
        onOpenTabInWorkColumn={(tabId) => { void openBrowserColumnTabInMainWorkColumn(tabId); }}
        onReorderTab={reorderBrowserColumnTab}
        isTabMenuOpen={isTabMenuOpen}
        onTabMenuOpenChange={setIsTabMenuOpen}
        onCloseColumn={hideBrowserColumn}
        onContextMenuOpenChange={handleContextMenuOpenChange}
        isFocused={isFocused}
        canCreate={Boolean(selectedNotebook)}
        onCreateNote={() => { void handleCreateNote(); }}
        onCreateAgentConversation={(typeKey) => { void handleCreateAgentConversation(typeKey); }}
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
