import { notebookForPath } from './path';
import { documentRelativeHref, encodeAbsoluteDocumentPath, encodeDocumentComponent, type ResolvedDocumentPath } from './document-relative-path';

/** A snapshot shared by file imports, pasted links and Markdown serialization. */
export interface DocumentResourceContext {
  documentPath?: string;
  rootPath?: string;
  ownerPath?: string;
  notebookId?: string;
  repositoryPath?: string;
  externalFileCache?: boolean;
}

export interface DocumentResourceRoot {
  id: string;
  path: string;
  kind: 'notebook' | 'repository';
}

export function documentResourceRoots(
  notebooks: readonly { id: string; path: string }[],
  repositories: readonly { notebookId: string; path: string }[] = [],
): DocumentResourceRoot[] {
  return [
    ...notebooks.map(({ id, path }) => ({ id, path, kind: 'notebook' as const })),
    ...repositories.map(({ notebookId, path }) => ({ id: notebookId, path, kind: 'repository' as const })),
  ];
}

export function resolveDocumentResourceContext(
  documentPath: string | undefined,
  roots: readonly DocumentResourceRoot[],
): DocumentResourceContext {
  if (!documentPath) return {};
  const owner = notebookForPath(documentPath, roots);
  if (!owner) return { documentPath, externalFileCache: true };
  return {
    documentPath, notebookId: owner.id, rootPath: owner.path,
    ...(owner.kind === 'notebook' ? { ownerPath: documentPath } : { repositoryPath: owner.path }),
  };
}

/** One persistence policy for paste, note cards and moved references. */
export function formatDocumentPathReference(
  target: ResolvedDocumentPath,
  documentPath: string | undefined,
  roots: readonly { id: string; path: string }[],
): string {
  const owner = documentPath ? notebookForPath(documentPath, roots) : undefined;
  if (documentPath && owner && notebookForPath(target.path, roots)?.id === owner.id) {
    const relative = documentRelativeHref(target, documentPath);
    if (relative) return relative;
  }
  return encodeAbsoluteDocumentPath(target.path) + (target.search ?? '')
    + (target.anchor ? `#${encodeDocumentComponent(target.anchor)}` : '');
}
