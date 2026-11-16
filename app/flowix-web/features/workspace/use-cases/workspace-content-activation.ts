import { setCollectionActiveView } from './collection-view-state';
import {
  useBrowserColumnStore,
} from '@features/workspace/store/browser-column-store';
import { sessionTargetIdentity } from '../model/session-target-key';
import {
  contentIdentityKey,
  type ContentIdentity,
} from '@features/workspace/store/workspace-content-identity';
import type { SessionSurfaceTarget } from '../model/session-target';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import { getMainColumnContentState } from '@features/workspace/store/main-column-content-state';
import { activateBrowserColumnEntry } from './browser-column-coordinator';

import type { WorkspaceContentLocation } from '../model/surface-opening';
export type { WorkspaceContentLocation } from '../model/surface-opening';

export interface WorkspaceContentLocations {
  mainColumn: Extract<WorkspaceContentLocation, { host: 'column-1' }> | null;
  browserColumn: Extract<WorkspaceContentLocation, { host: 'column-2' }> | null;
}

export function mainColumnTargetIdentity(target: SessionSurfaceTarget): ContentIdentity | null {
  switch (target.kind) {
    case 'folder-collection':
      return { kind: 'folder-collection', notebookId: target.notebookId, folderPath: target.folderPath, viewMode: target.viewMode };
    case 'media':
      return { kind: 'media', path: target.filePath };
    case 'external':
      return { kind: 'external', path: target.path };
    case 'collection':
      return { kind: 'collection', notebookId: target.notebookId, collectionId: target.collectionId, viewId: target.viewId };
    case 'table':
      return { kind: 'external', path: target.filePath };
    case 'media-library':
      return { kind: 'external', path: target.filePath };
    case 'agent-conversation':
      return { kind: 'agent-conversation', instanceId: target.instanceId };
    case 'web':
      return { kind: 'web', url: target.url };
    default:
      return null;
  }
}

function currentCollectionView(location: WorkspaceContentLocation): string | null {
  if (location.host === 'column-1') {
    const target = getMainColumnContentState();
    if (target.status === 'empty' || target.status === 'transitioning') return null;
    return target.target.kind === 'collection' ? target.target.viewId : null;
  }
  const tab = (useBrowserColumnStore.getState().current?.id === location.surfaceId ? useBrowserColumnStore.getState().current : null);
  return tab?.target.kind === 'file-browser' ? tab.target.collectionDisplay?.viewId ?? null : null;
}

/**
 * Focus a target in the requested host. Without a host preference, the main column is
 * preferred for legacy callers; callers that care about placement should pass
 * the host explicitly because the same content may exist in both columns.
 */
export function activateExistingWorkspaceContent(
  identity: ContentIdentity,
  host?: WorkspaceContentLocation['host'],
): WorkspaceContentLocation | null {
  const locations = findWorkspaceContentLocations(identity);
  const location = host === 'column-1'
    ? locations.mainColumn
    : host === 'column-2'
      ? locations.browserColumn
      : locations.mainColumn ?? locations.browserColumn;
  if (!location) return null;

  if (identity.kind === 'collection') {
    // Start a new transaction for pending requests; requestId makes the latest win.
    if (location.host === 'column-1' && location.state === 'pending') return null;
    if (!setCollectionActiveView(location, identity, identity.viewId ?? currentCollectionView(location))) return null;
  }
  if (location.host === 'column-1') {
    useWorkspaceFocusStore.getState().focusColumn('column-1');
  } else {
    useBrowserColumnStore.getState().focusContent(location.surfaceId);
  }
  return location;
}

/**
 * Async counterpart for navigation use-cases. Browser-column activation may
 * unmount an isolated editor, so it goes through the shared flush barrier.
 */
export async function activateExistingWorkspaceContentAsync(
  identity: ContentIdentity,
  host?: WorkspaceContentLocation['host'],
): Promise<WorkspaceContentLocation | null> {
  const locations = findWorkspaceContentLocations(identity);
  const location = host === 'column-1'
    ? locations.mainColumn
    : host === 'column-2'
      ? locations.browserColumn
      : locations.mainColumn ?? locations.browserColumn;
  if (!location) return null;

  if (location.host === 'column-1') {
    if (identity.kind === 'collection') {
      if (location.state === 'pending') return null;
      if (!setCollectionActiveView(location, identity, identity.viewId ?? currentCollectionView(location))) return null;
    }
    useWorkspaceFocusStore.getState().focusColumn('column-1');
    return location;
  }

  const activated = await activateBrowserColumnEntry(location.surfaceId);
  if (activated === null) {
    throw new Error('BrowserColumn navigation cancelled because saving did not complete');
  }
  if (activated && identity.kind === 'collection'
    && !setCollectionActiveView(location, identity, identity.viewId ?? currentCollectionView(location))) return null;
  return activated ? location : null;
}

/** Find matching content independently in each workspace host. */
export function findWorkspaceContentLocations(
  identity: ContentIdentity,
): WorkspaceContentLocations {
  const key = contentIdentityKey(identity);
  if (!key) return { mainColumn: null, browserColumn: null };

  const mainColumn = getMainColumnContentState();
  const pendingIdentity = mainColumn.status === 'transitioning'
    ? mainColumnTargetIdentity(mainColumn.to)
    : null;
  const pendingMatch = pendingIdentity && contentIdentityKey(pendingIdentity) === key;

  const mainTarget = mainColumn.status === 'empty'
    ? null
    : mainColumn.status === 'transitioning'
      ? mainColumn.from
      : mainColumn.target;
  const mainIdentity = mainTarget ? mainColumnTargetIdentity(mainTarget) : null;
  const activeMatch = mainIdentity && contentIdentityKey(mainIdentity) === key;

  const browserColumn = useBrowserColumnStore.getState();
  const currentBrowserEntry = browserColumn.current;
  const browserIdentity = currentBrowserEntry ? sessionTargetIdentity(currentBrowserEntry.target) : null;
  const tab = currentBrowserEntry && browserIdentity && contentIdentityKey(browserIdentity) === key
    ? currentBrowserEntry : null;
  return {
    mainColumn: pendingMatch
      ? { host: 'column-1', state: 'pending' }
      : activeMatch ? { host: 'column-1', state: 'active' } : null,
    browserColumn: tab ? { host: 'column-2', surfaceId: tab.id } : null,
  };
}

/** Resolve an existing location in the requested host; unspecified opens the main column. */
export function findWorkspaceContentForNavigation(
  identity: ContentIdentity,
  destination?: WorkspaceContentLocation['host'],
): WorkspaceContentLocation | null {
  const locations = findWorkspaceContentLocations(identity);
  if (destination === 'column-1') return locations.mainColumn;
  if (destination === 'column-2') return locations.browserColumn;
  return locations.mainColumn;
}
