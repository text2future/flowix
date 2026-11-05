import type { ExternalDocumentSession } from '@features/document/public/workspace-api';
import { findFileDisplayIdentity } from '@/lib/file-display-registry';
import { notebookRelativeDirectoryPath, samePath } from '@/lib/path';
import type { SessionSurfaceTarget } from '../model/session-target';

/** Resolve the displayed document from its session target, independent of placement. */
export function resolveSessionDocumentContext(
  target: SessionSurfaceTarget,
  loaded: ExternalDocumentSession | null,
  notebooks: readonly { id: string; path: string }[],
): ExternalDocumentSession | null {
  if (target.kind !== 'external' || !target.path) return null;
  if (loaded && samePath(loaded.fileIdentity.path, target.path)
    && (loaded.scopePath === target.scopePath || (loaded.scopePath && target.scopePath && samePath(loaded.scopePath, target.scopePath)))
    && loaded.transitionId === target.transitionId) return loaded;
  // The navigation/open boundary initializes display identities. During cold
  // restoration, wait for that boundary rather than allocating one in render.
  const fileIdentity = findFileDisplayIdentity(target.path);
  if (!fileIdentity) return null;
  const notebook = notebooks.filter((item) => notebookRelativeDirectoryPath(item.path, target.path) !== null)
    .sort((a, b) => b.path.length - a.path.length)[0];
  const relativePath = notebook ? notebookRelativeDirectoryPath(notebook.path, target.path) : null;
  return { fileIdentity, scopePath: target.scopePath, transitionId: target.transitionId ?? 0,
    notebookId: notebook?.id ?? null, notebookPath: notebook?.path ?? null, relativePath,
    indexable: Boolean(notebook && /\.(md|markdown)$/i.test(target.path)), openedAt: 0 };
}
