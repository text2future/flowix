import { ColumnResizeHandle } from './column-resize-handle';
import { focusWorkspaceHostFromEvent } from '@features/workspace/public/host-api';
import { memo, useCallback, useMemo, useState } from 'react';
import {
  hideBrowserColumn,
  openBrowserColumnContentInWorkColumn,
  useBrowserColumnFocusViewModel,
  useBrowserColumnViewModel,
} from '@features/workspace/public/browser-column-api';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { BrowserColumnHeader } from './browser-column-header';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { createShellNote, createShellNoteFromTemplate, useShellSelectedNotebook } from '@features/memo/public/shell-api';
import { createBrowserColumnAgentConversation, discardUnopenedBrowserColumnAgentConversation } from '@features/agent/public/shell-api';
import type { AgentTypeKey } from '@/types/agent';
import { workspaceSurfaceAppearance } from '@features/workspace/public/surface-api';
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
  const { current, webRuntime } = useBrowserColumnViewModel();
  const [addressBarSurfaceId, setAddressBarSurfaceId] = useState<string | null>(null);
  const webAddressBarVisible = Boolean(current && addressBarSurfaceId === current.id);
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
  const activeSurfaceChrome = activeSurfaceRuntime.appearance?.headerStyle
    ?? activeSurfaceDefinition?.chrome
    ?? 'document';
  const activeSurfaceCapabilities = activeSurfaceRuntime.capabilities
    ?? activeSurfaceDefinition?.capabilities
    ?? [];
  return (
    <section
      data-workspace-host="browser-column"
      data-workspace-focused={isFocused ? '' : undefined}
      aria-label="浏览器列辅助工作区"
      onPointerDown={(event) => focusWorkspaceHostFromEvent(event, 'browser-column')}
      onFocusCapture={(event) => focusWorkspaceHostFromEvent(event, 'browser-column')}
      className={`relative flex h-full min-w-0 shrink-0 flex-col border-l border-[var(--divider)] bg-[var(--document-bg)]${
        animated ? ' transition-[width] flowix-motion' : ''
      }`}
      style={{ width }}
    >
      <ColumnResizeHandle label="调整浏览器列宽度" width={width} direction={-1} onResize={onResize} />
      <BrowserColumnHeader
        current={current}
        webAddressBarVisible={webAddressBarVisible}
        onToggleWebAddressBar={() => setAddressBarSurfaceId(webAddressBarVisible ? null : current?.id ?? null)}
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
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
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
