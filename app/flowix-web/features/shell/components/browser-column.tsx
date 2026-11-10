import { useColumnSessionId, useColumnIndex } from '@features/workspace/public/session-api';
import { useSessionAddressBar } from '@features/workspace/public/session-header-api';
import { useColumnEnvironment } from './column-environment';
import { ColumnResizeHandle } from './column-resize-handle';
import { focusWorkspaceColumnFromEvent } from '@features/workspace/public/host-api';
import { memo, useCallback, useMemo, type CSSProperties, type ReactNode } from 'react';
import {
  BROWSER_COLUMN_MIN_WIDTH,
  hideBrowserColumn,
  openBrowserColumnContentInWorkColumn,
  useBrowserColumnFocusViewModel,
  useBrowserColumnViewModel,
} from '@features/workspace/public/browser-column-api';
import { WorkColumnTitlebar } from './work-column-titlebar';
import { isWindowsPlatform } from '@/lib/path';
import { BrowserColumnHeader } from './browser-column-header';
import { EmptyWorkspaceActions } from './empty-workspace-actions';
import { useWorkspaceHeaderCreation } from '../hooks/use-workspace-header-creation';
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
  browserCollectionIndexPath,
} from '@features/surface/public/shell-api';

export interface BrowserColumnProps {
  width: number;
  selectionView?: ReactNode;
  layoutKey: string;
  onResize: (width: number) => void;
  /**
   * When true, the outer width transitions instead of snapping. Only enabled
   * during the memo-list collapse/expand window so browser-column drags and
   * viewport resizes stay responsive.
   */
  animated?: boolean;
  /**
   * True while the header-toggle expand/collapse transition runs: the grid
   * track interpolates down to 0, so the section must release its min-width
   * and clip overflow instead of overflowing the shrinking track.
   */
  toggleAnimating?: boolean;
}

export const BrowserColumn = memo(function BrowserColumn({
  width,
  onResize,
  animated = false,
  toggleAnimating = false,
  selectionView,
}: BrowserColumnProps) {
  const sessionId = useColumnSessionId('column-2');
  const index = useColumnIndex('column-2');
  const environment = useColumnEnvironment();
  const { current, webRuntime } = useBrowserColumnViewModel();
  const addressBar = useSessionAddressBar('column-2', current?.target.kind === 'web' ? current.id : null);
  const webAddressBarVisible = addressBar.visible;
  const { isFocused } = useBrowserColumnFocusViewModel();
  const creation = useWorkspaceHeaderCreation('column-2');
  const handleToggleMemoEditorMode = useCallback((surfaceId: string) => {
    const entry = current?.id === surfaceId ? current : null;
    if (entry?.target.kind !== 'file-browser' || !entry.target.activeFilePath) return;

    const identity = documentIdentityFromFile(
      requireFileDisplayIdentity(entry.target.activeFilePath),
    );
    // Publish the latest CodeMirror / rich-text content before replacing the
    // editor subtree. The browser-column host keeps this isolated from a
    // possible copy of the same memo in the main work column.
    captureLatestDocumentContent(identity, 'column-2');
    const currentMode = getDocumentEditorMode('column-2', identity);
    setDocumentEditorMode(
      'column-2',
      identity,
      currentMode === 'source' ? 'rich' : 'source',
    );
  }, [current]);
  const activeSurface = useMemo(() => current
    ? resolveBrowserColumnSurface(current, {
        // Cross-column editing ownership is controlled by DocumentContainer.
        readOnly: false,
        webRuntime,
      })
    : null, [current, webRuntime]);
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
      data-workspace-host="column-2"
      data-column-index={index}
        data-workspace-session={sessionId}
      data-workspace-focused={isFocused ? '' : undefined}
      aria-label="浏览器列辅助工作区"
      onPointerDown={(event) => focusWorkspaceColumnFromEvent(event, 'column-2')}
      onFocusCapture={(event) => focusWorkspaceColumnFromEvent(event, 'column-2')}
      className={`relative flex h-full min-w-0 shrink-0 flex-col bg-[var(--document-bg)]${toggleAnimating ? ' overflow-hidden' : ''}${index === 1 ? ' border-l border-[var(--divider)]' : ''}${
        animated ? ' transition-[width] flowix-motion' : ''
      }`}
      style={environment ? {
        minWidth: toggleAnimating ? 0 : BROWSER_COLUMN_MIN_WIDTH,
        gridColumn: index + 1, gridRow: 1,
        display: index === 0 || environment.browserVisible ? undefined : 'none',
      } : { width }}
    >
      {!environment && <ColumnResizeHandle label="调整浏览器列宽度" width={width} direction={-1} onResize={onResize} />}
      {selectionView ? <WorkColumnTitlebar columnId="column-2" isWindows={isWindowsPlatform()}>{null}</WorkColumnTitlebar> : <BrowserColumnHeader
        current={current}
        webAddressBarVisible={webAddressBarVisible}
        onToggleWebAddressBar={addressBar.toggle}
        activeSurfaceChrome={activeSurfaceChrome}
        runtimeTitle={activeSurfaceRuntime.title}
        runtimeIcon={activeSurfaceRuntime.icon}
        surfaceContentKind={activeSurfaceRuntime.contentKind ?? activeSurfaceDefinition?.contentKind}
        headerBackgroundColor={activeSurfaceRuntime.headerBackgroundColor}
        surfaceCapabilities={activeSurfaceCapabilities}
        onToggleMemoEditorMode={handleToggleMemoEditorMode}
        onOpenInWorkColumn={(surfaceId) => { void openBrowserColumnContentInWorkColumn(surfaceId); }}
        onCloseColumn={hideBrowserColumn}
        isFocused={isFocused}
        canCreate={creation.canCreate}
        onCreateNote={(templateId) => { void creation.createNote(templateId); }}
        onCreateAgentConversation={(typeKey) => { void creation.createConversation(typeKey); }}
      />}
      {selectionView}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden" hidden={Boolean(selectionView)} style={selectionView ? { display: 'none' } : collectionContentStyle}>
        {activeSurface ? (
          <BrowserColumnSurfaceHost
            key={activeSurface.instanceKey}
            surface={activeSurface}
            focused={isFocused}
            webAddressBarVisible={webAddressBarVisible}
          />
        ) : (
          <EmptyWorkspaceActions columnId="column-2" />
        )}
      </div>
    </section>
  );
});
