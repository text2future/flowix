'use client';

import { memo, useCallback, useLayoutEffect, useMemo, type ReactNode } from 'react';
import { type CollectionDisplayDescriptor } from '@/lib/collection-display-registry';
import { requireFileDisplayIdentity, type FileDisplayIdentity } from '@/lib/file-display-registry';
import { resolveFileBrowserContext } from '@features/workspace/use-cases/file-browser-context';
import { selectBrowserColumnFile } from '@features/workspace/public/browser-column-api';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { setCollectionActiveView } from '@features/workspace/use-cases/collection-view-state';
import { useBrowserColumnStore, type BrowserColumnEntry, type BrowserColumnWebRuntime } from '@features/workspace/store/browser-column-store';
import { canonicalUrl } from '@features/workspace/store/workspace-content-identity';
import type { WorkspaceSurfaceCapability, SurfaceAppearance, SurfaceHeaderStyle, WorkspaceSurfaceKind } from '@features/workspace/public/surface-api';
import type { FileBrowserViewSurface } from './file-browser-view';
import { getWorkspaceSurfaceRendererDefinition, WorkspaceSurfaceRendererView } from './workspace-surface-renderer-registry';
import type { ExternalDocumentProps, WorkspaceSurfaceRendererData, WorkspaceWebNavigationPort } from './workspace-surface-renderer-contract';
import { registerWorkspaceSurfacePresentationOwner, reportWorkspaceSurfacePresentation } from './workspace-surface-runtime';
import { workspaceSurfaceRetainsInitialContent } from './workspace-surface-renderer-registry';
import type { SurfacePresentationUpdate } from '@features/workspace/model/surface-contract';
import type { SurfaceLifecycle } from '@features/workspace/model/surface-contract';
import { registerWorkspaceSurfaceLifecycle, registerWorkspaceSurfaceHostView } from '@features/workspace/public/surface-lifecycle-api';

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
  notebookId: string;
  notebookPath: string;
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
  readOnly?: boolean;
  webRuntime?: BrowserColumnWebRuntime | null;
  toolbarCollapsed?: boolean;
  onToolbarCollapsedChange?: (collapsed: boolean) => void;
}

export function resolveBrowserColumnSurface(
  entry: BrowserColumnEntry,
  { readOnly = false, webRuntime = null, toolbarCollapsed = false, onToolbarCollapsedChange }: BrowserColumnSurfaceOptions = {},
): BrowserColumnSurface {
  const base = {
    instanceKey: `browser:${entry.id}`,
    surfaceId: entry.id,
  };
  switch (entry.target.kind) {
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
      const target = { ...entry.target, ...resolveFileBrowserContext(entry.target.activeFilePath, entry.target) };
      const surface: SurfaceBase & FileBrowserViewSurface & Pick<BrowserFileBrowserSurface, 'documentProps'> = {
        ...base,
        ...target,
        documentProps: {
          isExternalDocument: true,
          externalScopePath: target.scopePath,
          documentSessionMode: 'isolated',
          workspaceHost: 'browser-column',
          readOnly, toolbarCollapsed, onToolbarCollapsedChange,
        },
        onSelectFile: (path) => { void selectBrowserColumnFile(entry.id, path); },
        onOpenFileInNewTab: (path) => { void openWorkspaceSurface({
          host: 'browser-column',
          target: { ...target, activeFilePath: path, collectionDisplay: undefined, folderPath: null },
        }); },
        onContextChange: (patch) => useBrowserColumnStore.getState().updateFileBrowserContext(entry.id, patch),
        onSelectFolder: (path) => { void selectBrowserColumnFile(entry.id, null, path); },
        onTreeVisibleChange: (visible) => useBrowserColumnStore.getState().setFileBrowserTreeVisible(entry.id, visible),
        onTreeWidthChange: (width) => useBrowserColumnStore.getState().setFileBrowserTreeWidth(entry.id, width),
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
      const state = useBrowserColumnStore.getState();
      return state.current?.id === surfaceId ? state.webRuntime : null;
    },
    setRuntime: (runtime) => useBrowserColumnStore.getState().setWebRuntime(surfaceId, runtime),
    navigate: (url) => { useBrowserColumnStore.getState().navigateWeb(surfaceId, url); },
    back: () => { useBrowserColumnStore.getState().goBackWeb(surfaceId); },
    forward: () => { useBrowserColumnStore.getState().goForwardWeb(surfaceId); },
    reload: () => { useBrowserColumnStore.getState().reloadWeb(surfaceId); },
    updateMetadata: (metadata) => useBrowserColumnStore.getState().updateContentMetadata(surfaceId, metadata),
  };
}

function BrowserRegisteredSurfaceView({ surface, focused, webAddressBarVisible = false }: { surface: BrowserColumnSurface; focused: boolean; webAddressBarVisible?: boolean }) {
  const presentationIdentity = surface.kind === 'collection'
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
    const entry = (useBrowserColumnStore.getState().current?.id === surface.surfaceId ? useBrowserColumnStore.getState().current : null);
    if (entry?.target.kind !== 'file-browser' || !entry.target.collectionDisplay) return;
    const { notebookId, collectionId } = entry.target.collectionDisplay;
    setCollectionActiveView({ host: 'browser-column', surfaceId: surface.surfaceId }, { notebookId, collectionId }, viewId);
  }, [surface.surfaceId]);
  const reportPresentation = useCallback((update: SurfacePresentationUpdate) => {
    const accepted = reportWorkspaceSurfacePresentation(surface.surfaceId, update, presentationOwner);
    if (!accepted) return;
    if (update.title !== undefined || update.icon !== undefined) {
      const metadata: { title?: string; icon?: string | null } = {};
      if (update.title !== undefined) metadata.title = update.title;
      if (update.icon !== undefined) metadata.icon = update.icon;
      useBrowserColumnStore.getState().updateContentMetadata(surface.surfaceId, metadata);
    }
  }, [presentationOwner, surface.surfaceId]);
  const retainInitialContent = workspaceSurfaceRetainsInitialContent(browserSurfaceData(surface));
  const registerLifecycle = useCallback((lifecycle: SurfaceLifecycle | null, owner?: object) => {
    registerWorkspaceSurfaceLifecycle(surface.surfaceId, lifecycle, owner);
  }, [surface.surfaceId]);
  useLayoutEffect(() => registerWorkspaceSurfaceHostView('browser-column', surface.surfaceId), [surface.surfaceId]);
  useLayoutEffect(() => registerWorkspaceSurfacePresentationOwner(surface.surfaceId, presentationOwner, {
    state: { status: 'loading', loadingMode: 'blocking', retainContent: retainInitialContent },
  }),
    [presentationOwner, retainInitialContent, surface.surfaceId]);
  const data = useMemo(() => browserSurfaceData(surface), [surface]);
  const context = useMemo(() => ({ host: 'browser-column' as const, viewId: surface.surfaceId, focused,
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
