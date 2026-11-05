import { notebookForPath } from '@/lib/path';

export type NotebookPath = { id: string; path: string };

export function resolveNotebookIdForPath(documentPath: string, notebooks: readonly NotebookPath[]): string | undefined {
  return notebookForPath(documentPath, notebooks)?.id;
}
