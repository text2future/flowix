'use client';

import { openSurfaceAtPosition as openSurfaceAtHost } from '@features/workspace/public/open-surface-api';

import { memo, useCallback, useMemo } from 'react';
import type { CollectionIndexItem } from '@platform/tauri/client';
import { type CollectionDisplayDescriptor } from '@/lib/collection-display-registry';
import { requireFileDisplayIdentity, type FileDisplayIdentity } from '@/lib/file-display-registry';
import { resolveFileBrowserContext, setCollectionActiveView, updatePrimaryFileBrowserContext } from '@features/workspace/public/session-runtime-api';
import { selectBrowserColumnFile } from '@features/workspace/public/browser-column-api';
import { openSurfaceInColumn } from '@features/workspace/public/session-opening-api';
import { browserSessionRuntime, type BrowserColumnEntry, type BrowserColumnWebRuntime } from '@features/workspace/public/browser-column-api';
import { canonicalUrl } from '@/lib/url';
import type { WorkspaceSurfaceCapability, SurfaceAppearance, SurfaceHeaderStyle, WorkspaceSurfaceKind } from '@features/workspace/public/surface-api';
import type { FileBrowserViewSurface } from './file-browser-view';
import { getWorkspaceSurfaceRendererDefinition } from './workspace-surface-renderer-registry';
import type { ExternalDocumentProps, WorkspaceSurfaceRendererData, WorkspaceWebNavigationPort } from './workspace-surface-renderer-contract';
import type { SurfacePresentationUpdate } from '@features/workspace/public/surface-api';
import { surfaceRenderPolicy } from './surface-render-policy';
import { SurfaceHostView } from './surface-host-view';

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
  & { collectionType?: CollectionIndexItem['collectionType']; collectionUnavailableReason?: string; collectionDisplay?: CollectionDisplayDescriptor; documentProps: ExternalDocumentProps }
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

/** Titlebar skin owned by the surface currently mounted in Browser Column. */
export type BrowserColumnSurfaceChrome = SurfaceHeaderStyle;

export interface BrowserColumnSurfaceDefinition {
  contentKind: WorkspaceSurfaceKind;
  appearance: Readonly<SurfaceAppearance>;
  chrome: BrowserColumnSurfaceChrome;
  capabilities: readonly BrowserColumnSurfaceCapability[];
}

interface BrowserColumnSurfaceOptions {
  columnId?: 'column-1' | 'column-2';
  readOnly?: boolean;
  webRuntime?: BrowserColumnWebRuntime | null;
}

export function resolveBrowserColumnSurface(entry: BrowserColumnEntry & { target: Extract<BrowserColumnEntry['target'], { kind: 'file-browser' }> }, options?: BrowserColumnSurfaceOptions): BrowserFileBrowserSurface;
export function resolveBrowserColumnSurface(entry: BrowserColumnEntry, options?: BrowserColumnSurfaceOptions): BrowserColumnSurface;
export function resolveBrowserColumnSurface(
  entry: BrowserColumnEntry,
  { columnId = 'column-2', readOnly = false, webRuntime = null }: BrowserColumnSurfaceOptions = {},
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
        void openSurfaceInColumn({ columnId: 'column-1', target: {
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
          readOnly,
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
    case 'agent-conversation':
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

/** Identity of the content being presented; the presentation owner resets when it changes. */
function browserPresentationScope(surface: BrowserColumnSurface): string {
  const identity = surface.kind === 'plugin-workbench' ? surface.plugin.manifest.id : surface.kind === 'collection'
    ? `${surface.notebookId}:${surface.folderPath}`
    : surface.kind === 'file-browser'
      ? `${surface.fileIdentity?.displayId ?? ''}:${surface.activeFilePath ?? surface.folderPath ?? 'folder'}:${surface.collectionType ?? ''}`
      : surface.kind === 'media'
        ? surface.fileIdentity.displayId
        : surface.kind === 'web'
          ? canonicalUrl(surface.url) ?? surface.url
          : surface.instanceId;
  return `${surface.surfaceId}:${identity}`;
}

/** Browser provides view data and navigation ports; all kinds use the common registry. */
export function getBrowserColumnSurfaceDefinition(surface: BrowserColumnSurface): BrowserColumnSurfaceDefinition {
  const definition = getWorkspaceSurfaceRendererDefinition(browserSurfaceData(surface));
  return { contentKind: definition.kind, appearance: definition.appearance, chrome: definition.appearance.headerStyle,
    capabilities: definition.capabilities };
}

export function browserColumnSurfaceSupports(surface: BrowserColumnSurface, capability: BrowserColumnSurfaceCapability): boolean {
  return getBrowserColumnSurfaceDefinition(surface).capabilities.includes(capability);
}

export const BrowserColumnSurfaceHost = memo(function BrowserColumnSurfaceHost({ surface, columnId = 'column-2', focused = false, webAddressBarVisible = false }: { surface: BrowserColumnSurface; columnId?: 'column-1' | 'column-2'; focused?: boolean; webAddressBarVisible?: boolean }) {
  const surfaceId = surface.surfaceId;
  const data = useMemo(() => browserSurfaceData(surface), [surface]);
  const policy = useMemo(() => surfaceRenderPolicy(columnId, surfaceId), [columnId, surfaceId]);
  const webNavigation = useMemo(() => surface.kind === 'web' ? createBrowserWebNavigationPort(surfaceId) : undefined,
    [surface.kind, surfaceId]);
  const onCollectionActiveViewChange = useCallback((viewId: string) => {
    const entry = browserSessionRuntime().current?.id === surfaceId ? browserSessionRuntime().current : null;
    if (entry?.target.kind !== 'file-browser' || !entry.target.collectionDisplay) return;
    const { notebookId, collectionId } = entry.target.collectionDisplay;
    setCollectionActiveView(policy.collectionLocation, { notebookId, collectionId }, viewId);
  }, [policy, surfaceId]);
  const writeMetadata = useCallback((update: SurfacePresentationUpdate) => {
    if (update.title === undefined && update.icon === undefined) return;
    const metadata: { title?: string; icon?: string | null } = {};
    if (update.title !== undefined) metadata.title = update.title;
    if (update.icon !== undefined) metadata.icon = update.icon;
    browserSessionRuntime().updateContentMetadata(surfaceId, metadata);
  }, [surfaceId]);
  return <SurfaceHostView
    key={`${surface.kind}:${surface.instanceKey}`}
    surface={data}
    columnId={columnId}
    viewId={surfaceId}
    sessionEntryId={surfaceId}
    focused={focused}
    readOnly={surface.kind === 'file-browser' && Boolean(surface.documentProps.readOnly)}
    initialFocus={surface.kind === 'file-browser' ? surface.documentProps.initialFocus : undefined}
    presentationScope={browserPresentationScope(surface)}
    policy={policy}
    webNavigation={webNavigation}
    webAddressBarVisible={webAddressBarVisible}
    onCollectionActiveViewChange={onCollectionActiveViewChange}
    writeMetadata={writeMetadata}
  />;
});
