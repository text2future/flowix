import { useWorkspaceSessionStore } from '../store/workspace-session-store';
import { createLogger } from '@/lib/logger';
import { canOpenBrowserColumnTargetInWorkColumn, useBrowserColumnStore, type BrowserColumnTarget } from '../store/browser-column-store';
import type {
  OpenWorkspaceSurfaceRequest, WorkWorkspaceSurfaceRequest, BrowserWorkspaceSurfaceRequest,
  WorkWorkspaceOpenResult, BrowserWorkspaceOpenResult, WorkspaceContentLocation, WorkspaceSurfaceOpenResult,
} from '../model/surface-opening';
import type { WorkWorkspaceSurfaceTarget, BrowserWorkspaceSurfaceTarget, CollectionReferenceSurfaceTarget } from '../model/surface-target';
export type * from '../model/surface-opening';
export type { WorkspaceSurfaceOpenTarget, BrowserWorkspaceSurfaceTarget, CollectionReferenceSurfaceTarget } from '../model/surface-target';
import { contentIdentityKey } from '../model/surface-identity';
import type { ContentIdentity } from '../model/surface-identity';
import { useWorkColumnStore } from '../store/work-column-store';
import type { WorkspaceSurfaceHost, WorkspaceSurfaceKind } from '../surface-registry';
import { collections, notebooks } from '@platform/tauri/client';
import { ensureCollectionDisplay, findCollectionDisplayPath } from '@/lib/collection-display-registry';
import {
  resolveWorkspaceFileSurfaceKind,
  workspaceFileSurfaceKind,
  workspaceSurfaceSupportsHost,
} from '../surface-registry';
import {
  createFileBrowserTarget,
  openBrowserColumnTarget,
} from './browser-column-navigation';
import {
  openCollectionTarget,
  openFolderCollectionChooserTarget,
  openExternalTarget,
  openMediaLibraryTarget,
  openMediaTarget,
  openPluginWorkbench,
  openContentleTarget,
  openWebTarget,
  prepareActiveWorkColumnDocumentLeave,
  openWorkFileBrowserTarget,
} from './workspace-navigation';
import { selectAndOpenAgentConversation } from './agent-conversation-navigation';
import { browserColumnTargetIdentity, workColumnTargetIdentity, findWorkspaceContentForNavigation } from './workspace-content-activation';
import { flushBrowserViewBeforeOpeningWork } from './prepare-browser-document-for-work';
import { NavigationCancelledError } from '@/lib/navigation-cancelled-error';

const navigationLogger = createLogger('workspace-navigation');
let navigationSequence = 0;

function fileKind(path: string): WorkspaceSurfaceKind {
  return workspaceFileSurfaceKind(resolveWorkspaceFileSurfaceKind(path));
}

function workTargetSurfaceKind(target: WorkWorkspaceSurfaceTarget): WorkspaceSurfaceKind {
  switch (target.kind) {
    case 'file-browser': return browserTargetSurfaceKind(target);
    case 'folder-collection': return 'collection';
    case 'external': return fileKind(target.path);
    case 'table': return 'file-table';
    case 'media-library': return 'file-media-library';
    case 'collection': return target.collectionType === 'table' ? 'file-table'
      : target.collectionType === 'media_library' ? 'file-media-library' : 'file-work-documents';
    case 'collection-reference': return target.collectionKind === 'media_library' ? 'file-media-library'
      : target.collectionKind === 'work_documents' ? 'file-work-documents' : 'file-table';
    case 'media': return 'media';
    case 'agent-conversation': return 'agent-conversation';
    case 'web': return 'web';
    case 'plugin-workbench': return 'plugin-workbench';
  }
}

function workTargetIdentity(target: WorkWorkspaceSurfaceTarget): ContentIdentity | null {
  switch (target.kind) {
    case 'file-browser': return browserColumnTargetIdentity(target);
    case 'folder-collection': return { kind: 'folder-collection', notebookId: target.notebookId, folderPath: target.folderPath, viewMode: target.viewMode };
    case 'external': return { kind: 'external', path: target.path };
    case 'table': case 'media-library': return { kind: 'external', path: target.filePath };
    case 'collection': return { kind: 'collection', notebookId: target.notebookId, collectionId: target.collectionId, viewId: target.viewId };
    case 'collection-reference': return { kind: 'collection', notebookId: target.notebookId, collectionId: target.collectionId, viewId: target.viewId ?? null };
    case 'media': return { kind: 'media', path: target.filePath };
    case 'agent-conversation': return { kind: 'agent-conversation', instanceId: target.instanceId };
    case 'web': return { kind: 'web', url: target.url };
    case 'plugin-workbench': return null;
  }
}

function browserTargetSurfaceKind(target: BrowserColumnTarget): WorkspaceSurfaceKind {
  switch (target.kind) {
    case 'plugin-workbench': return 'plugin-workbench';
    case 'folder-collection': return 'collection';
    case 'media': return 'media';
    case 'web': return 'web';
    case 'agent_conversation': return 'agent-conversation';
    case 'file-browser':
      if (!target.activeFilePath) return 'file-browser';
      if (target.collectionType === 'table' || /\.table\.ya?ml$/i.test(target.activeFilePath)) return 'file-table';
      if (target.collectionType === 'media_library' || /\.lib\.ya?ml$/i.test(target.activeFilePath)) return 'file-media-library';
      if (target.collectionType === 'work_documents' || /\.workdocs\.ya?ml$/i.test(target.activeFilePath)) return 'file-work-documents';
      if (/\.index\.yaml$/i.test(target.activeFilePath)) return 'file-browser';
      return fileKind(target.activeFilePath);
  }
}

export function browserTargetFromOpenTarget(
  target: Exclude<BrowserWorkspaceSurfaceTarget, CollectionReferenceSurfaceTarget>,
  notebookId?: string | null,
): BrowserColumnTarget {
  switch (target.kind) {
    case 'plugin-workbench': return target;
    case 'folder-collection':
      return target;
    case 'file-browser':
      return target;
    case 'external':
      return {
        ...createFileBrowserTarget(target.path, target.scopePath),
        ...target.fileBrowser,
        ...(notebookId !== undefined ? { notebookId } : {}),
      };
    case 'table':
      return { ...createFileBrowserTarget(target.filePath, target.notebookPath), notebookId: target.notebookId };
    case 'media-library':
      return {
        ...createFileBrowserTarget(target.filePath, target.notebookPath),
        notebookId: target.notebookId,
        collectionType: 'media_library',
      };
    case 'collection':
      return {
        ...createFileBrowserTarget(target.filePath, target.notebookPath),
        notebookId: target.notebookId,
        collectionDisplay: target,
        collectionType: target.collectionType,
      };
    case 'media':
      return {
        kind: 'media',
        filePath: target.filePath,
        notebookId: target.notebookId,
        notebookPath: target.notebookPath,
        resourceKind: target.resourceKind,
      };
    case 'agent-conversation':
      return { kind: 'agent_conversation', instanceId: target.instanceId };
    case 'web':
      return { kind: 'web', url: target.url };
  }
}

async function openCollectionReferenceInBrowser(
  target: CollectionReferenceSurfaceTarget,
  options?: import('../model/surface-opening').WorkspaceOpenNavigationOptions,
): Promise<BrowserWorkspaceOpenResult> {
  const notebook = (await notebooks.getAll()).find((candidate) => candidate.id === target.notebookId);
  if (!notebook) throw new Error('集合所属笔记本不存在');
  const descriptor = ensureCollectionDisplay({
    notebookId: target.notebookId,
    collectionId: target.collectionId,
    viewId: target.viewId ?? null,
  }, target.displayId);
  const root = notebook.path.replace(/[\\/]+$/, '');
  let path = target.filePath || (target.relativePathHint ? `${root}/${target.relativePathHint}` : null)
    || findCollectionDisplayPath(descriptor.displayId);
  let collectionType = target.collectionKind;
  try {
    const collection = await collections.resolve(target.notebookId, target.collectionId);
    path = `${root}/${collection.relativePath}`;
    collectionType = collection.collectionType;
  } catch (error) {
    if (!path) throw error;
  }
  if (!path) throw new Error('集合文件路径已丢失，请从文件树重新打开此文件');
  return openBrowserTarget({
    ...createFileBrowserTarget(path, notebook.path, notebook.path),
    notebookId: target.notebookId,
    collectionDisplay: descriptor,
    collectionType,
  }, options);
}

function activeWorkLocation(): Extract<WorkspaceContentLocation, { host: 'main-third' }> {
  return { host: 'main-third', state: 'active' };
}

function assertHostSupport(kind: WorkspaceSurfaceKind, host: WorkspaceSurfaceHost): void {
  if (!workspaceSurfaceSupportsHost(kind, host)) {
    throw new Error(`Surface '${kind}' is not supported in '${host}'`);
  }
}

async function openBrowserTarget(
  target: BrowserColumnTarget,
  options?: import('../model/surface-opening').WorkspaceOpenNavigationOptions,
): Promise<BrowserWorkspaceOpenResult> {
  assertHostSupport(browserTargetSurfaceKind(target), 'browser-column');
  if (target.kind !== 'agent_conversation') {
    const requestedIdentity = browserColumnTargetIdentity(target);
    const activeWorkIdentity = workColumnTargetIdentity(useWorkColumnStore.getState().navigation.target);
    if (activeWorkIdentity && contentIdentityKey(activeWorkIdentity) === contentIdentityKey(requestedIdentity)) {
      await prepareActiveWorkColumnDocumentLeave();
    }
  }
  const result = await openBrowserColumnTarget(target, options);
  return result
    ? { status: result.alreadyOpen ? 'activated' : 'opened', host: 'browser-column', location: { host: 'browser-column', surfaceId: result.surfaceId } }
    : { status: 'cancelled', host: 'browser-column', reason: 'navigation-cancelled' };
}

export function openWorkspaceSurface(request: BrowserWorkspaceSurfaceRequest): Promise<BrowserWorkspaceOpenResult>;
export function openWorkspaceSurface(request: WorkWorkspaceSurfaceRequest): Promise<WorkWorkspaceOpenResult>;
export function openWorkspaceSurface(request: OpenWorkspaceSurfaceRequest): Promise<BrowserWorkspaceOpenResult | WorkWorkspaceOpenResult>;
/** Route a shared surface target through the selected host adapter. */
export async function openWorkspaceSurface(
  request: OpenWorkspaceSurfaceRequest,
): Promise<BrowserWorkspaceOpenResult | WorkWorkspaceOpenResult> {
  const navigationId = ++navigationSequence;
  if (request.host === 'main-third') {
    useWorkspaceSessionStore.getState().updateSession('primary-session', (session) => ({
      ...session, navigation: { ...session.navigation,
        transaction: { ...session.navigation.transaction, entryId: request.options?.navigationEntryId } },
    }));
  }
  const workRequestId = request.host === 'main-third'
    ? useWorkColumnStore.getState().reserveNavigationIntent() : undefined;
  const context = { navigationId, source: request.source ?? 'unspecified', requestedHost: request.host, targetKind: request.target.kind };
  navigationLogger.debug('Navigation requested', context);
  try {
    const result = await performWorkspaceSurfaceOpen(request, navigationId, workRequestId);
    navigationLogger.debug('Navigation finished', {
      ...context, actualHost: result.host, status: result.status,
      ...(result.status === 'cancelled' ? { reason: result.reason } : {}),
    });
    return result;
  } catch (error) {
    if (error instanceof NavigationCancelledError) {
      navigationLogger.debug('Navigation cancelled', { ...context, reason: 'navigation-cancelled' });
      return { status: 'cancelled', host: request.host, reason: 'navigation-cancelled' };
    }
    // Avoid logging document paths, URLs, content, or backend error messages.
    navigationLogger.debug('Navigation failed', context);
    throw error;
  }
}

async function performWorkspaceSurfaceOpen(
  request: OpenWorkspaceSurfaceRequest,
  navigationId: number,
  workRequestId: number | undefined,
): Promise<BrowserWorkspaceOpenResult | WorkWorkspaceOpenResult> {
  if (request.host === 'browser-column') {
    const target = request.target;
    if (target.kind === 'collection-reference') {
      assertHostSupport(target.collectionKind === 'media_library' ? 'file-media-library'
        : target.collectionKind === 'work_documents' ? 'file-work-documents' : 'file-table', 'browser-column');
      return openCollectionReferenceInBrowser(target, request.options);
    }
    const resolvedTarget = browserTargetFromOpenTarget(target, request.options?.notebookId);
    return openBrowserTarget(resolvedTarget, request.options);
  }

  const cancelWork = (reason: 'superseded' | 'save-refused' | 'target-not-active'): WorkWorkspaceOpenResult => {
    navigationLogger.debug('Work navigation cancelled', {
      navigationId, source: request.source ?? 'unspecified', requestedHost: request.host,
      targetKind: request.target.kind, reason,
    });
    return { status: 'cancelled', host: 'main-third', reason: 'navigation-cancelled' };
  };
  const target = request.target;
  const kind = workTargetSurfaceKind(target);
  assertHostSupport(kind, 'main-third');
  const options = request.options;
  const identity = workTargetIdentity(target);
  const previousLocation = identity ? findWorkspaceContentForNavigation(identity, 'main-third') : null;
  if (target.kind !== 'external' && !(previousLocation?.host === 'main-third' && previousLocation.state === 'active') && identity
    && identity.kind !== 'media' && identity.kind !== 'web' && identity.kind !== 'agent-conversation') {
    if (!await flushBrowserViewBeforeOpeningWork(identity)) {
      return cancelWork('save-refused');
    }
  }
  if (useWorkColumnStore.getState().navigation.requestId !== workRequestId) return cancelWork('superseded');
  const previousWorkTarget = useWorkColumnStore.getState().navigation.target;
  const pluginWasOpen = target.kind === 'plugin-workbench'
    && previousWorkTarget.kind === 'plugin-workbench'
    && previousWorkTarget.plugin.manifest.id === target.plugin.manifest.id;
  const finishWorkOpen = (): WorkWorkspaceOpenResult => {
    const navigationTarget = useWorkColumnStore.getState().navigation.target;
    const pluginMatches = target.kind === 'plugin-workbench'
      && navigationTarget.kind === 'plugin-workbench'
      && navigationTarget.plugin.manifest.id === target.plugin.manifest.id;
    const location = identity
      ? findWorkspaceContentForNavigation(identity, 'main-third')
      : pluginMatches ? activeWorkLocation() : null;
    if (!location || location.host !== 'main-third' || location.state === 'pending') {
      return cancelWork('target-not-active');
    }
    return { status: previousLocation || pluginWasOpen ? 'activated' : 'opened', host: 'main-third', location };
  };
  switch (target.kind) {
    case 'file-browser':
      await openWorkFileBrowserTarget(target, options?.history ?? 'push', workRequestId);
      return finishWorkOpen();
    case 'folder-collection':
      await openFolderCollectionChooserTarget(target, workRequestId, options?.history ?? 'push');
      return finishWorkOpen();
    case 'external': {
      if (!await flushBrowserViewBeforeOpeningWork({ kind: 'external', path: target.path })) {
        return cancelWork('save-refused');
      }
      // A later click can finish its save barrier before this request does.
      // Do not let the older request begin a new lower-level transaction.
      if (useWorkColumnStore.getState().navigation.requestId !== workRequestId) return cancelWork('superseded');
      await openExternalTarget(target.path, {
        restoreRequestId: workRequestId,
        browserDocumentPrepared: true,
        scopePath: target.scopePath,
        fileBrowser: target.fileBrowser,
        history: options?.history,
        notebookId: options?.notebookId,
        markdownLocation: options?.markdownLocation,
        initialFocus: options?.initialFocus,
        treeReveal: target.treeReveal,
        destination: 'main-third',
      });
      return finishWorkOpen();
    }
    case 'table':
      await openContentleTarget(target.filePath, target.notebookPath, target.notebookId, { history: options?.history, destination: 'main-third', restoreRequestId: workRequestId });
      return finishWorkOpen();
    case 'media-library':
      await openMediaLibraryTarget(target.filePath, target.notebookPath, target.notebookId, { history: options?.history, destination: 'main-third', restoreRequestId: workRequestId });
      return finishWorkOpen();
    case 'collection':
      await openCollectionTarget(target, { history: options?.history, destination: 'main-third', restoreRequestId: workRequestId, refresh: options?.refresh });
      return finishWorkOpen();
    case 'collection-reference':
      await openCollectionTarget(target, { history: options?.history, destination: 'main-third', restoreRequestId: workRequestId, refresh: options?.refresh });
      return finishWorkOpen();
    case 'media':
      await openMediaTarget({ ...target, history: options?.history, destination: 'main-third', restoreRequestId: workRequestId });
      return finishWorkOpen();
    case 'agent-conversation': {
      await selectAndOpenAgentConversation(target.instanceId, {
        history: options?.history,
        destination: 'main-third',
        restoreRequestId: workRequestId,
        ...(target.blankIfMissing ? { blankIfMissing: true as const } : {}),
      });
      return finishWorkOpen();
    }
    case 'web':
      await openWebTarget(target.url, { history: options?.history, destination: 'main-third' });
      return finishWorkOpen();
    case 'plugin-workbench':
      await openPluginWorkbench(target.plugin, options?.history ?? 'push');
      return finishWorkOpen();
  }
}

/** Open Browser content as an additional Work view through the shared protocol. */
export async function openBrowserColumnContentInWorkColumn(
  surfaceId: string,
): Promise<WorkspaceSurfaceOpenResult> {
  const entry = (useBrowserColumnStore.getState().current?.id === surfaceId ? useBrowserColumnStore.getState().current : null);
  if (!entry || !canOpenBrowserColumnTargetInWorkColumn(entry.target)) {
    return { status: 'cancelled', host: 'main-third', reason: 'navigation-cancelled' };
  }
  const target = browserTargetToWorkTarget(entry.target);
  if (!target) return { status: 'cancelled', host: 'main-third', reason: 'navigation-cancelled' };
  return openWorkspaceSurface({ host: 'main-third', target });
}

export function browserTargetToWorkTarget(target: BrowserColumnTarget): WorkWorkspaceSurfaceTarget {
  return target.kind === 'agent_conversation'
    ? { kind: 'agent-conversation', instanceId: target.instanceId } : target;
}

export type { WorkspaceSurfaceHost };
