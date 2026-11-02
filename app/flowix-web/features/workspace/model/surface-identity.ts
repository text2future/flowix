import { canonicalPath, fileLocatorKey } from '@/lib/path';
import { canonicalUrl } from '@/lib/url';

export { canonicalUrl } from '@/lib/url';

/**
 * Stable identity for content that can be opened by either workspace host.
 *
 * Paths and URLs deliberately have different normalizers. `canonicalPath`
 * collapses repeated slashes, which is correct for filesystem paths but would
 * corrupt the `//` in an URL scheme.
 */
export type ContentIdentity =
  | { kind: 'plugin-workbench'; pluginId: string }
  | { kind: 'collection'; notebookId: string; collectionId: string; viewId: string | null }
  | { kind: 'media'; path: string }
  | { kind: 'external'; path: string }
  | { kind: 'file-browser'; folderPath: string }
  | { kind: 'folder-collection'; notebookId: string; folderPath: string; viewMode?: 'work-documents' }
  | { kind: 'web'; url: string }
  | { kind: 'agent-conversation'; instanceId: string };

export function contentIdentityKey(
  identity: ContentIdentity,
): string | null {
  switch (identity.kind) {
    case 'plugin-workbench': return identity.pluginId.trim() ? `plugin:${JSON.stringify(identity.pluginId)}` : null;
    case 'collection': return `collection:${JSON.stringify([identity.notebookId, identity.collectionId])}`;
    case 'media': {
      const path = identity.path;
      return path.trim() ? fileLocatorKey(path) : null;
    }
    case 'external': {
      const path = identity.path;
      return path.trim() ? fileLocatorKey(path) : null;
    }
    case 'file-browser': {
      const folderPath = identity.folderPath.trim();
      return folderPath ? `file-browser:${canonicalPath(folderPath)}` : null;
    }
    case 'folder-collection': {
      const folderPath = identity.folderPath.trim();
      return folderPath ? `folder-collection:${JSON.stringify([identity.notebookId, canonicalPath(folderPath), identity.viewMode ?? 'chooser'])}` : null;
    }
    case 'web': {
      const url = canonicalUrl(identity.url);
      return url ? `web:${url}` : null;
    }
    case 'agent-conversation': {
      const instanceId = identity.instanceId.trim();
      return instanceId ? `agent:${instanceId}` : null;
    }
  }
}

/** Every registered surface has an identity, including non-file workspace views. */
export type WorkspaceSurfaceIdentity = ContentIdentity
  | { kind: 'plugin-workbench'; pluginId: string };

export function workspaceSurfaceIdentityKey(identity: WorkspaceSurfaceIdentity): string | null {
  switch (identity.kind) {
    case 'plugin-workbench': return identity.pluginId.trim() ? `plugin:${JSON.stringify(identity.pluginId)}` : null;
    default: return contentIdentityKey(identity);
  }
}
