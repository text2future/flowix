import { joinNotebookMemoPath } from '@/lib/path';
import { resolveCollectionSaveDirectory } from '@features/collection/save-location';
import type { MediaLibraryDocument } from './model';

/** Null selects the shared saver's attachments default, including first-upload directory creation. */
export function resolveMediaLibraryAddDirectory({ filePath, notebookPath, document }: {
  filePath: string;
  notebookPath: string;
  document: MediaLibraryDocument;
}): string | null {
  const attachmentsDirectory = joinNotebookMemoPath(notebookPath, 'attachments');
  if (!attachmentsDirectory) throw new Error('附件目录无效');
  const directory = resolveCollectionSaveDirectory({
    filePath, notebookPath, placement: document.collection.placement, source: document.dataset.source,
    filter: document.dataset.filter, defaultDirectory: attachmentsDirectory,
  });
  return document.collection.placement !== 'folder' && directory === attachmentsDirectory ? null : directory;
}
