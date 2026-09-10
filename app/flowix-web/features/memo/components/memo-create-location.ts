import { canonicalPath } from '@/lib/path';
import type { MemoDocumentSession } from '@features/document/store/document-store';

export function parentRelativePathForTreeCreate(
  session: MemoDocumentSession | null,
  notebookId: string,
  notebookPath: string,
): string | undefined {
  if (!session || session.notebookId !== notebookId) return undefined;

  const root = canonicalPath(notebookPath).replace(/\/+$/, '');
  const notePath = canonicalPath(session.path);
  if (!root || !notePath.startsWith(`${root}/`)) return undefined;

  const relative = notePath.slice(root.length + 1);
  const separator = relative.lastIndexOf('/');
  return separator > 0 ? relative.slice(0, separator) : undefined;
}
