import { canonicalDirectoryPath, joinNotebookMemoPath, notebookRelativeDirectoryPath, parentDirectoryPath } from '@/lib/path';
import type { CollectionPlacement, CollectionSource } from './model';
import { resolveCollectionLocationScope } from './collection-scope';

/** Shared Browse and Save policy for media uploads and notes created from a table. */
export function resolveCollectionSaveDirectory({ filePath, notebookPath, placement, source, filter = null, defaultDirectory }: {
  filePath: string;
  notebookPath: string;
  placement: CollectionPlacement;
  source: CollectionSource;
  filter?: Record<string, unknown> | null;
  defaultDirectory: string;
}): string {
  const root = canonicalDirectoryPath(notebookPath);
  const libraryDirectory = parentDirectoryPath(filePath, root);
  const folder = resolveCollectionLocationScope({ collection: { placement }, dataset: { source, filter } }, filePath, notebookPath)?.relativePath;
  const target = placement === 'folder' ? libraryDirectory
    : folder ? joinNotebookMemoPath(root, folder) : defaultDirectory;
  if (!target || notebookRelativeDirectoryPath(root, target) === null
    || target.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('集合保存目录无效');
  }
  if (source.scope !== 'notebook') {
    const scope = source.scope === 'containing_folder'
      ? libraryDirectory : joinNotebookMemoPath(root, source.path);
    const relative = scope ? notebookRelativeDirectoryPath(scope, target) : null;
    if (relative === null) {
      throw new Error('保存目录不在集合数据范围内，请调整「位置」目录或集合数据范围');
    }
  }
  return canonicalDirectoryPath(target);
}
