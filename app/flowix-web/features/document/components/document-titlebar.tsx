'use client';

import { WorkspaceHeader, WorkspaceHeaderContentActions, WorkspaceHeaderFallbackMenu, WorkspaceDocumentHeaderActions } from '@features/shell/public/work-column-api';
import { resolveWorkspaceFileSurfaceKind } from '@features/workspace/public/surface-api';
import type { DocumentTitlebarProps } from './document-titlebar-model';

/** Primary-session adapter; layout and content menus belong to the common header. */
export function DocumentTitlebar({ platform, ...props }: DocumentTitlebarProps & { platform: 'mac' | 'windows' }) {
  const { document: { target }, navigation, sidebar, surfaceChrome = 'document', collectionDisplay } = props;
  return <WorkspaceHeader columnId="column-1" isWindows={platform === 'windows'}
    presentation={{ chrome: surfaceChrome, backgroundColor: props.headerBackgroundColor,
      collection: Boolean(collectionDisplay), identity: navigation }}
    sidebar={sidebar} navigation={navigation} reserveWindowsControls={props.reserveWindowsControls}
    webAddressBarVisible={props.webAddressBarVisible} onToggleWebAddressBar={props.onToggleWebAddressBar}
    actions={(_, iconButtonClass) => props.document.isolated && target ? <WorkspaceDocumentHeaderActions
      columnId="column-1" path={target.fileIdentity.path} scopePath={target.scopePath} notebookId={target.notebookId}
      collectionPath={collectionDisplay?.indexPath ?? null} iconButtonClass={iconButtonClass}
      header={{ sourceKind: `file-${resolveWorkspaceFileSurfaceKind(target.fileIdentity.path)}`,
        documentControls: props.contentCapabilities,
        showEditorFontSwitcher: Boolean(props.showEditorFontSwitcher), showEditorModeToggle: Boolean(props.showEditorModeToggle) }}
    /> : <WorkspaceHeaderContentActions iconButtonClass={iconButtonClass}
      collection={collectionDisplay}
      fallback={props.onToggleWebAddressBar ? undefined : <WorkspaceHeaderFallbackMenu columnId="column-1" iconButtonClass={iconButtonClass} />}
      media={surfaceChrome === 'media' ? props.mediaActions : undefined}
      document={target && surfaceChrome !== 'media' ? {
        target, capabilities: props.contentCapabilities, actions: props.actions,
        showEditorFontSwitcher: props.showEditorFontSwitcher,
        showEditorModeToggle: props.showEditorModeToggle,
        editorMode: props.editorMode, onSetEditorMode: props.onSetEditorMode,
      } : undefined} />}
  />;
}
