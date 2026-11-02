import { useSessionAddressBar } from '@features/workspace/public/session-header-api';
import { useSessionHostEnvironment } from './session-host-environment';
import { ColumnResizeHandle } from './column-resize-handle';
import { focusWorkspaceHostFromEvent } from '@features/workspace/public/host-api';
import { memo, useCallback, useMemo, type CSSProperties } from 'react';
import {
  BROWSER_COLUMN_MIN_WIDTH,
  hideBrowserColumn,
  openBrowserColumnContentInWorkColumn,
  useBrowserColumnFocusViewModel,
  useBrowserColumnViewModel,
} from '@features/workspace/public/browser-column-api';
import { openWorkspaceSurface } from '@features/workspace/public/session-opening-api';
import { BrowserColumnHeader } from './browser-column-header';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { createShellNote, createShellNoteFromTemplate, useShellSelectedNotebook } from '@features/memo/public/shell-api';
import { createBrowserColumnAgentConversation, discardUnopenedBrowserColumnAgentConversation } from '@features/agent/public/shell-api';
import type { AgentTypeKey } from '@/types/agent';
import { workspaceSurfaceAppearance } from '@features/workspace/public/surface-api';
import { useCollectionBannerControl } from '@/lib/collection-banner-visibility';
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
  useWorkspaceSurfacePresentation,
  resolveBrowserColumnSurface,
  WorkspaceSurfaceStateView,
  browserCollectionIndexPath,
} from '@features/surface/public/shell-api';

export interface BrowserColumnProps {
  width: number;
  layoutKey: string;
  onResize: (width: number) => void;
  toolbarCollapsed: boolean;
  onToolbarCollapsedChange: (collapsed: boolean) => void;
  /**
   * When true, the outer width transitions instead of snapping. Only enabled
   * during the memo-list collapse/expand window so browser-column drags and
   * viewport resizes stay responsive.
   */
  animated?: boolean;
}

export const BrowserColumn = memo(function BrowserColumn({
  width,
  onResize,
  toolbarCollapsed,
  onToolbarCollapsedChange,
  animated = false,
}: BrowserColumnProps) {
  const { t } = useI18n();
  const environment = useSessionHostEnvironment();
  const { current, webRuntime } = useBrowserColumnViewModel();
  const addressBar = useSessionAddressBar('secondary-session', current?.target.kind === 'web' ? current.id : null);
  const webAddressBarVisible = addressBar.visible;
  const { isFocused } = useBrowserColumnFocusViewModel();
  const selectedNotebook = useShellSelectedNotebook();
  const handleCreateNote = useCallback(async (templateId?: string) => {
    if (!selectedNotebook) return;
    try {
      const created = templateId
        ? await createShellNoteFromTemplate(templateId, selectedNotebook.id)
        : await createShellNote(selectedNotebook.id);
      const result = await openWorkspaceSurface({
        host: 'browser-column',
        target: { kind: 'external', path: created.path, scopePath: selectedNotebook.path, transitionId: null },
        options: { notebookId: selectedNotebook.id },
      });
      if (result.status === 'cancelled') toast.error(t('tabWindow.switchFailed'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(templateId ? 'memo.create.templateFailed' : 'tabWindow.createNote.failed'));
    }
  }, [selectedNotebook, t]);
  const handleCreateAgentConversation = useCallback(async (typeKey: AgentTypeKey) => {
    if (!selectedNotebook) return;
    let instanceId: string | null = null;
    try {
      instanceId = createBrowserColumnAgentConversation(typeKey, selectedNotebook.id);
      const result = await openWorkspaceSurface({ host: 'browser-column', target: { kind: 'agent-conversation', instanceId } });
      if (result.status === 'cancelled') {
        discardUnopenedBrowserColumnAgentConversation(instanceId);
        toast.error(t('tabWindow.switchFailed'));
      }
    } catch (error) {
      if (instanceId) discardUnopenedBrowserColumnAgentConversation(instanceId);
      toast.error(error instanceof Error ? error.message : t('tabWindow.createConversation.failed'));
    }
  }, [selectedNotebook, t]);
  const handleToggleMemoEditorMode = useCallback((surfaceId: string) => {
    const entry = current?.id === surfaceId ? current : null;
    if (entry?.target.kind !== 'file-browser' || !entry.target.activeFilePath) return;

    const identity = documentIdentityFromFile(
      requireFileDisplayIdentity(entry.target.activeFilePath),
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
  }, [current]);
  const activeSurface = useMemo(() => current
    ? resolveBrowserColumnSurface(current, {
        // Cross-column editing ownership is controlled by DocumentContainer.
        readOnly: false,
        webRuntime,
        toolbarCollapsed,
        onToolbarCollapsedChange,
      })
    : null, [current, webRuntime, toolbarCollapsed, onToolbarCollapsedChange]);
  const activeSurfaceRuntime = useWorkspaceSurfacePresentation(activeSurface?.surfaceId ?? '');
  const activeSurfaceDefinition = activeSurface ? getBrowserColumnSurfaceDefinition(activeSurface) : null;
  const collectionPath = browserCollectionIndexPath(current);
  const collectionBanner = useCollectionBannerControl(collectionPath);
  // Match the main Work column: visible collection banners slide under the titlebar,
  // while sticky collection tabs and table headers use the same titlebar offset.
  const collectionTitlebarH = collectionPath && (!collectionBanner.available || collectionBanner.visible)
    ? 'var(--window-titlebar-height)'
    : null;
  const collectionContentStyle: CSSProperties | undefined = collectionTitlebarH
    ? ({ marginTop: `calc(0px - ${collectionTitlebarH})`, '--work-titlebar-h': collectionTitlebarH } as CSSProperties)
    : undefined;
  const activeSurfaceChrome = activeSurfaceRuntime.appearance?.headerStyle
    ?? activeSurfaceDefinition?.chrome
    ?? 'document';
  const activeSurfaceCapabilities = activeSurfaceRuntime.capabilities
    ?? activeSurfaceDefinition?.capabilities
    ?? [];
  return (
    <section
      data-workspace-host={environment?.host ?? 'browser-column'}
      data-workspace-session="secondary-session"
      data-workspace-focused={isFocused ? '' : undefined}
      aria-label="浏览器列辅助工作区"
      onPointerDown={(event) => focusWorkspaceHostFromEvent(event, 'browser-column')}
      onFocusCapture={(event) => focusWorkspaceHostFromEvent(event, 'browser-column')}
      className={`relative flex h-full min-w-0 shrink-0 flex-col ${!environment || environment.host === 'browser-column' ? 'border-l border-[var(--divider)]' : ''} bg-[var(--document-bg)]${
        animated ? ' transition-[width] flowix-motion' : ''
      }`}
      style={environment ? {
        minWidth: BROWSER_COLUMN_MIN_WIDTH, gridColumn: environment.host === 'main-third' ? 1 : 2, gridRow: 1,
        display: environment.host === 'browser-column' && !environment.browserVisible ? 'none' : undefined,
      } : { width }}
    >
      {!environment && <ColumnResizeHandle label="调整浏览器列宽度" width={width} direction={-1} onResize={onResize} />}
      <BrowserColumnHeader
        current={current}
        webAddressBarVisible={webAddressBarVisible}
        onToggleWebAddressBar={addressBar.toggle}
        activeSurfaceChrome={activeSurfaceChrome}
        surfaceContentKind={activeSurfaceRuntime.contentKind ?? activeSurfaceDefinition?.contentKind}
        headerBackgroundColor={activeSurfaceRuntime.headerBackgroundColor}
        surfaceCapabilities={activeSurfaceCapabilities}
        onToggleMemoEditorMode={handleToggleMemoEditorMode}
        onOpenInWorkColumn={(surfaceId) => { void openBrowserColumnContentInWorkColumn(surfaceId); }}
        onCloseColumn={hideBrowserColumn}
        isFocused={isFocused}
        canCreate={Boolean(selectedNotebook)}
        onCreateNote={() => { void handleCreateNote(); }}
        onCreateAgentConversation={(typeKey) => { void handleCreateAgentConversation(typeKey); }}
      />
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden" style={collectionContentStyle}>
        {activeSurface ? (
          <BrowserColumnSurfaceHost
            key={activeSurface.instanceKey}
            surface={activeSurface}
            focused={isFocused}
            webAddressBarVisible={webAddressBarVisible}
          />
        ) : (
          <WorkspaceSurfaceStateView
            appearance={{ ...workspaceSurfaceAppearance('file-markdown'), emptyDecoration: 'none' }}
            state={{ status: 'empty', reason: 'no-target', message: { key: 'document.file.loading' } }}
            messageOverride="选择内容以打开"
          />
        )}
      </div>
    </section>
  );
});
