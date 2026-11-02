import type { WorkspaceSurfaceOpenTarget } from './surface-target';
import { contentIdentityKey } from './surface-identity';
import { canonicalPath } from '@/lib/path';

export function sessionTargetKey(target: WorkspaceSurfaceOpenTarget): string | null {
  switch (target.kind) {
    case 'empty': return null;
    case 'external': return contentIdentityKey({ kind: 'external', path: target.path });
    case 'table': case 'media-library': return contentIdentityKey({ kind: 'external', path: target.filePath });
    case 'collection': case 'collection-reference':
      return contentIdentityKey({ kind: 'collection', notebookId: target.notebookId,
        collectionId: target.collectionId, viewId: target.viewId ?? null });
    case 'file-browser': return target.collectionDisplay
      ? contentIdentityKey({ kind: 'collection', ...target.collectionDisplay })
      : target.activeFilePath ? contentIdentityKey({ kind: 'external', path: target.activeFilePath })
        : contentIdentityKey({ kind: 'file-browser', folderPath: target.folderPath ?? '' });
    case 'folder-collection': return contentIdentityKey({ kind: 'folder-collection', notebookId: target.notebookId, folderPath: target.folderPath });
    case 'media': return contentIdentityKey({ kind: 'media', path: target.filePath });
    case 'web': return contentIdentityKey(target);
    case 'agent-conversation': return contentIdentityKey(target);
    case 'plugin-workbench': return target.plugin?.manifest?.id ? 'plugin:' + canonicalPath(target.plugin.manifest.id) : null;
  }
}
