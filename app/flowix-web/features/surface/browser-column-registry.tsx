'use client';

import { openWorkspaceSurface as openSurfaceAtHost } from '@features/workspace/public/open-surface-api';

import { memo, useCallback, useLayoutEffect, useMemo, type ReactNode } from 'react';
import { type CollectionDisplayDescriptor } from '@/lib/collection-display-registry';
import { requireFileDisplayIdentity, type FileDisplayIdentity } from '@/lib/file-display-registry';
import { resolveFileBrowserContext, setCollectionActiveView, updatePrimaryFileBrowserContext } from '@features/workspace/public/session-runtime-api';
import { selectBrowserColumnFile } from '@features/workspace/public/browser-column-api';
import { openWorkspaceSurface } from '@features/workspace/public/session-opening-api';
import { browserSessionRuntime, type BrowserColumnEntry, type BrowserColumnWebRuntime } from '@features/workspace/public/browser-column-api';
import { canonicalUrl } from '@/lib/url';
import type { WorkspaceSurfaceCapability, SurfaceAppearance, SurfaceHeaderStyle, WorkspaceSurfaceKind } from '@features/workspace/public/surface-api';
import type { FileBrowserViewSurface } from './file-browser-view';
import { getWorkspaceSurfaceRendererDefinition, WorkspaceSurfaceRendererView } from './workspace-surface-renderer-registry';
import type { ExternalDocumentProps, WorkspaceSurfaceRendererData, WorkspaceWebNavigationPort } from './workspace-surface-renderer-contract';
import { registerWorkspaceSurfacePresentationOwner, reportWorkspaceSurfacePresentation } from './workspace-surface-runtime';
import { workspaceSurfaceRetainsInitialContent } from './workspace-surface-renderer-registry';
import type { SurfacePresentationUpdate } from '@features/workspace/public/surface-api';
import type { SurfaceLifecycle } from '@features/workspace/public/surface-api';
import { registerWorkspaceSurfaceLifecycle, registerWorkspaceColumnIdView } from '@features/workspace/public/surface-lifecycle-api';

export type BrowserColumnSurfaceCapability = WorkspaceSurfaceCapability;

interface SurfaceBase {
  instanceKey: string;
  surfaceId: string;
}

interface FileSurfaceBase extends SurfaceBase {
  fileIdentity: FileDisplayIdentity;
}

export interface BrowserMediaSurface extends FileSurfaceBase {
  kind: 'media';
  notebookId: string | null;
  notebookPath: string | null;
  resourceKind: 'image' | 'video';
}

export interface BrowserFolderCollectionSurface extends SurfaceBase {
  kind: 'collection';
  notebookId: string;
  notebookPath: string;
  folderPath: string;
  folderName: string;
  viewMode?: 'work-documents';
}

export type BrowserFileBrowserSurface = SurfaceBase
  & FileBrowserViewSurface
  & { collectionType?: 'table' | 'media_library' | 'work_documents'; collectionUnavailableReason?: string; collectionDisplay?: CollectionDisplayDescriptor; documentProps: ExternalDocumentProps }
  & (
    | { activeFilePath: string; fileIdentity: FileDisplayIdentity }
    | { activeFilePath: null; fileIdentity?: never }
  );

export interface BrowserWebSurface extends SurfaceBase {
  kind: 'web';
  url: string;
  title: string;
  runtime: BrowserColumnWebRuntime | null;
}

export interface BrowserAgentConversationSurface extends SurfaceBase {
  kind: 'agent-conversation';
  instanceId: string;
}

export type BrowserColumnSurface =
  | (SurfaceBase & { kind: 'plugin-workbench'; plugin: Extract<BrowserColumnEntry['target'], { kind: 'plugin-workbench' }>['plugin'] })
  | BrowserFolderCollectionSurface
  | BrowserMediaSurface
  | BrowserFileBrowserSurface
  | BrowserWebSurface
  | BrowserAgentConversationSurface;

export type BrowserColumnSurfaceKind = BrowserColumnSurface['kind'];

/** Titlebar skin owned by the surface currently mounted in Browser Column. */
export type BrowserColumnSurfaceChrome = SurfaceHeaderStyle;

export interface BrowserColumnSurfaceDefinition {
  contentKind: WorkspaceSurfaceKind;
  appearance: Readonly<SurfaceAppearance>;
  chrome: BrowserColumnSurfaceChrome;
  capabilities: readonly BrowserColumnSurfaceCapability[];
  render: () => ReactNode;
}

interface BrowserColumnSurfaceOptions {
  columnId?: 'column-1' | 'column-2';
  readOnly?: boolean;
  webRuntime?: BrowserColumnWebRuntime | null;
  toolbarCollapsed?: boolean;
  onToolbarCollapsedChange?: (collapsed: boolean) => void;
}

export function resolveBrowserColumnSurface(entry: BrowserColumnEntry & { target: Extract<BrowserColumnEntry['target'], { kind: 'file-browser' }> }, options?: BrowserColumnSurfaceOptions): BrowserFileBrowserSurface;
export function resolveBrowserColumnSurface(entry: BrowserColumnEntry, options?: BrowserColumnSurfaceOptions): BrowserColumnSurface;
export function resolveBrowserColumnSurface(
  entry: BrowserColumnEntry,
  { columnId = 'column-2', readOnly = false, webRuntime = null, toolbarCollapsed = false, onToolbarCollapsedChange }: BrowserColumnSurfaceOptions = {},
): BrowserColumnSurface {
  const base = {
    instanceKey: `browser:${entry.id}`,
    surfaceId: entry.id,
  };
  switch (entry.target.kind) {
    case 'plugin-workbench': return { ...base, ...entry.target };
    case 'folder-collection':
      return { ...base, kind: 'collection', notebookId: entry.target.notebookId,
        notebookPath: entry.target.notebookPath, folderPath: entry.target.folderPath, folderName: entry.target.folderName,
        viewMode: entry.target.viewMode };
    case 'media':
      return {
        ...base,
        fileIdentity: requireFileDisplayIdentity(entry.target.filePath),
        kind: 'media',
        notebookId: entry.target.notebookId,
        notebookPath: entry.target.notebookPath,
        resourceKind: entry.target.resourceKind,
      };
    case 'file-browser': {
      const sourceTarget = entry.target;
      const updatePrimaryContext = (patch: Partial<import('@features/workspace/public/surface-api').FileBrowserContext>) =>
        updatePrimaryFileBrowserContext(sourceTarget, patch);
      const selectPrimary = (activeFilePath: string | null, folderPath?: string) => {
        void openWorkspaceSurface({ columnId: 'column-1', target: {
          ...sourceTarget, ...(folderPath === undefined ? {} : { folderPath }),
          activeFilePath, collectionDisplay: undefined, collectionType: undefined,
        } });
      };
      const target = { ...entry.target, ...resolveFileBrowserContext(entry.target.activeFilePath, entry.target) };
      const surface: SurfaceBase & FileBrowserViewSurface & Pick<BrowserFileBrowserSurface, 'documentProps'> = {
        ...base,
        ...target,
        documentProps: {
          isExternalDocument: true,
          externalScopePath: target.scopePath,
          documentSessionMode: 'isolated',
          workspaceHost: columnId,
          readOnly, toolbarCollapsed, onToolbarCollapsedChange,
        },
        onSelectFile: (path) => { if (columnId === 'column-1') selectPrimary(path); else void selectBrowserColumnFile(entry.id, path); },
        onOpenFileInNewTab: (path) => { void openSurfaceAtHost({
          index: 1,
          target: { ...target, activeFilePath: path, collectionDisplay: undefined, folderPath: null },
        }); },
        onContextChange: (patch) => columnId === 'column-1' ? updatePrimaryContext(patch) : browserSessionRuntime().updateFileBrowserContext(entry.id, patch),
        onSelectFolder: (path) => { if (columnId === 'column-1') selectPrimary(null, path); else void selectBrowserColumnFile(entry.id, null, path); },
        onTreeVisibleChange: (visible) => columnId === 'column-1' ? updatePrimaryContext({ fileTreeVisible: visible }) : browserSessionRuntime().setFileBrowserTreeVisible(entry.id, visible),
        onTreeWidthChange: (width) => columnId === 'column-1' ? updatePrimaryContext({ fileTreeWidth: width }) : browserSessionRuntime().setFileBrowserTreeWidth(entry.id, width),
      };
      return target.activeFilePath
        ? {
            ...surface,
            activeFilePath: target.activeFilePath,
            collectionType: target.collectionType,
            collectionUnavailableReason: target.collectionUnavailableReason,
            fileIdentity: target.collectionDisplay ? { path: target.activeFilePath, displayId: target.collectionDisplay.displayId } : requireFileDisplayIdentity(target.activeFilePath),
          }
        : { ...surface, activeFilePath: null };
    }
    case 'web':
      return {
        ...base,
        kind: 'web',
        url: entry.target.url,
        title: entry.title,
        runtime: webRuntime ?? null,
      };
    case 'agent_conversation':
      return { ...base, kind: 'agent-conversation', instanceId: entry.target.instanceId };
  }
}

function browserSurfaceData(surface: BrowserColumnSurface): WorkspaceSurfaceRendererData {
  switch (surface.kind) {
    case 'plugin-workbench': return { kind: 'plugin-workbench', props: { plugin: surface.plugin, notebookPath: undefined, currentNotePath: null, currentNoteContent: '' } };
    case 'collection': return { kind: 'collection', notebookId: surface.notebookId,
      notebookPath: surface.notebookPath, folderPath: surface.folderPath, folderName: surface.folderName, viewMode: surface.viewMode };
    case 'media': return { kind: 'media', fileIdentity: surface.fileIdentity, notebookPath: surface.notebookPath,
      notebookId: surface.notebookId, resourceKind: surface.resourceKind };
    case 'agent-conversation': return { kind: 'agent-conversation', instanceId: surface.instanceId };
    case 'web': return { kind: 'web', url: surface.url, title: surface.title, runtime: surface.runtime };
    case 'file-browser': return { kind: 'file-browser', props: surface };
  }
}

function createBrowserWebNavigationPort(surfaceId: string): WorkspaceWebNavigationPort {
  return {
    getRuntime: () => {
      const state = browserSessionRuntime();
      return state.current?.id === surfaceId ? state.webRuntime : null;
    },
    setRuntime: (runtime) => browserSessionRuntime().setWebRuntime(surfaceId, runtime),
    navigate: (url) => { browserSessionRuntime().navigateWeb(surfaceId, url); },
    back: () => { browserSessionRuntime().goBackWeb(surfaceId); },
    forward: () => { browserSessionRuntime().goForwardWeb(surfaceId); },
    reload: () => { browserSessionRuntime().reloadWeb(surfaceId); },
    updateMetadata: (metadata) => browserSessionRuntime().updateContentMetadata(surfaceId, metadata),
  };
}

function BrowserRegisteredSurfaceView({ surface, focused, webAddressBarVisible = false }: { surface: BrowserColumnSurface; focused: boolean; webAddressBarVisible?: boolean }) {
  const presentationIdentity = surface.kind === 'plugin-workbench' ? surface.plugin.manifest.id : surface.kind === 'collection'
    ? `${surface.notebookId}:${surface.folderPath}`
    : surface.kind === 'file-browser'
    ? `${surface.fileIdentity?.displayId ?? ''}:${surface.activeFilePath ?? surface.folderPath ?? 'folder'}:${surface.collectionType ?? ''}`
    : surface.kind === 'media'
      ? surface.fileIdentity.displayId
      : surface.kind === 'web'
        ? canonicalUrl(surface.url) ?? surface.url
      : surface.instanceId;
  const presentationOwner = useMemo(() => ({}), [surface.surfaceId, presentationIdentity]);
  const webNavigation = useMemo(() => surface.kind === 'web' ? createBrowserWebNavigationPort(surface.surfaceId) : undefined,
    [surface.kind, surface.surfaceId]);
  const onCollectionActiveViewChange = useCallback((viewId: string) => {
    const entry = (browserSessionRuntime().current?.id === surface.surfaceId ? browserSessionRuntime().current : null);
    if (entry?.target.kind !== 'file-browser' || !entry.target.collectionDisplay) return;
    const { notebookId, collectionId } = entry.target.collectionDisplay;
    setCollectionActiveView({ host: 'column-2', surfaceId: surface.surfaceId }, { notebookId, collectionId }, viewId);
  }, [surface.surfaceId]);
  const reportPresentation = useCallback((update: SurfacePresentationUpdate) => {
    const accepted = reportWorkspaceSurfacePresentation(surface.surfaceId, update, presentationOwner);
    if (!accepted) return;
    if (update.title !== undefined || update.icon !== undefined) {
      const metadata: { title?: string; icon?: string | null } = {};
      if (update.title !== undefined) metadata.title = update.title;
      if (update.icon !== undefined) metadata.icon = update.icon;
      browserSessionRuntime().updateContentMetadata(surface.surfaceId, metadata);
    }
  }, [presentationOwner, surface.surfaceId]);
  const retainInitialContent = workspaceSurfaceRetainsInitialContent(browserSurfaceData(surface));
  const registerLifecycle = useCallback((lifecycle: SurfaceLifecycle | null, owner?: object) => {
    registerWorkspaceSurfaceLifecycle(surface.surfaceId, lifecycle, owner);
  }, [surface.surfaceId]);
  useLayoutEffect(() => registerWorkspaceColumnIdView('column-2', surface.surfaceId), [surface.surfaceId]);
  useLayoutEffect(() => registerWorkspaceSurfacePresentationOwner(surface.surfaceId, presentationOwner, {
    state: { status: 'loading', loadingMode: 'blocking', retainContent: retainInitialContent },
  }),
    [presentationOwner, retainInitialContent, surface.surfaceId]);
  const data = useMemo(() => browserSurfaceData(surface), [surface]);
  const context = useMemo(() => ({ sessionEntryId: surface.surfaceId, host: 'column-2' as const, viewId: surface.surfaceId, focused,
      initialFocus: surface.kind === 'file-browser' ? surface.documentProps.initialFocus : undefined,
      webNavigation, webAddressBarVisible, onCollectionActiveViewChange,
      readOnly: surface.kind === 'file-browser' && Boolean(surface.documentProps.readOnly),
      reportPresentation, registerLifecycle }),
    [surface, focused, webNavigation, webAddressBarVisible, onCollectionActiveViewChange, reportPresentation, registerLifecycle]);
  return <WorkspaceSurfaceRendererView surface={data} context={context} />;
}

/** Browser provides view data and navigation ports; all kinds use the common registry. */
export function getBrowserColumnSurfaceDefinition(surface: BrowserColumnSurface): BrowserColumnSurfaceDefinition {
  const definition = getWorkspaceSurfaceRendererDefinition(browserSurfaceData(surface));
  return { contentKind: definition.kind, appearance: definition.appearance, chrome: definition.appearance.headerStyle,
    capabilities: definition.capabilities, render: () => <BrowserRegisteredSurfaceView surface={surface} focused={false} /> };
}

export function browserColumnSurfaceSupports(surface: BrowserColumnSurface, capability: BrowserColumnSurfaceCapability): boolean {
  return getBrowserColumnSurfaceDefinition(surface).capabilities.includes(capability);
}

export const BrowserColumnSurfaceHost = memo(function BrowserColumnSurfaceHost({ surface, focused = false, webAddressBarVisible = false }: { surface: BrowserColumnSurface; focused?: boolean; webAddressBarVisible?: boolean }) {
  return <BrowserRegisteredSurfaceView key={`${surface.kind}:${surface.instanceKey}`} surface={surface} focused={focused} webAddressBarVisible={webAddressBarVisible} />;
});
