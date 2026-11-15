import { notebookForPath } from '@/lib/path';
import { documentResourceRoots } from '@/lib/document-resource-context';

export type NotebookPath = { id: string; path: string };
export type NotebookRepositoryPath = { notebookId: string; path: string };
export type NotebookPathOwner = {
  notebookId: string;
  kind: 'notebook' | 'repository';
  path: string;
};

export function resolveNotebookPathOwner(
  documentPath: string,
  notebooks: readonly NotebookPath[],
  repositories: readonly NotebookRepositoryPath[] = [],
): NotebookPathOwner | undefined {
  const owner = notebookForPath(documentPath, documentResourceRoots(notebooks, repositories));
  return owner ? { notebookId: owner.id, kind: owner.kind, path: owner.path } : undefined;
}

export function resolveNotebookIdForPath(
  documentPath: string,
  notebooks: readonly NotebookPath[],
  repositories: readonly NotebookRepositoryPath[] = [],
): string | undefined {
  return resolveNotebookPathOwner(documentPath, notebooks, repositories)?.notebookId;
}
