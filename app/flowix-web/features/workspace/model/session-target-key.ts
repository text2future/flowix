import type { WorkspaceSurfaceOpenTarget } from './surface-target';
import { workspaceSurfaceIdentityKey, type WorkspaceSurfaceIdentity } from './surface-identity';

/**
 * Content identity of a resolved target: what the user thinks of as "the same
 * document", independent of which column shows it or which view is active.
 */
export function sessionTargetIdentity(
  target: WorkspaceSurfaceOpenTarget,
): WorkspaceSurfaceIdentity | null {
  switch (target.kind) {
    case 'empty': return null;
    case 'external': return { kind: 'external', path: target.path };
    case 'table': case 'media-library': return { kind: 'external', path: target.filePath };
    case 'collection': case 'collection-reference':
      return { kind: 'collection', notebookId: target.notebookId,
        collectionId: target.collectionId, viewId: target.viewId ?? null };
    case 'file-browser': return target.collectionDisplay
      ? { kind: 'collection', ...target.collectionDisplay }
      : target.activeFilePath ? { kind: 'external', path: target.activeFilePath }
        : { kind: 'file-browser', folderPath: target.folderPath ?? '' };
    case 'folder-collection':
      return { kind: 'folder-collection', notebookId: target.notebookId,
        folderPath: target.folderPath, viewMode: target.viewMode };
    case 'media': return { kind: 'media', path: target.filePath };
    case 'web': return { kind: 'web', url: target.url };
    case 'agent-conversation': return { kind: 'agent-conversation', instanceId: target.instanceId };
    case 'plugin-workbench': {
      const pluginId = target.plugin?.manifest?.id;
      return typeof pluginId === 'string' && pluginId.trim()
        ? { kind: 'plugin-workbench', pluginId } : null;
    }
  }
}

/** Canonical string key used to compare targets across columns and history. */
export function sessionTargetKey(target: WorkspaceSurfaceOpenTarget): string | null {
  const identity = sessionTargetIdentity(target);
  return identity && workspaceSurfaceIdentityKey(identity);
}
