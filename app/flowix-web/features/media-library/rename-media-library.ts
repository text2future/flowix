import { collectionNotebookId, mutateCollectionFile } from '@features/collection/mutations';
import { parseMediaLibrary, type MediaLibraryDocument } from './model';

export async function renameMediaLibraryFile({ notebookPath, notebookId, collectionId, title, onRenamed }: {
  filePath: string;
  notebookPath: string;
  notebookId?: string | null;
  collectionId: string;
  title: string;
  onRenamed: (nextPath: string) => void;
}): Promise<{ filePath: string; document: MediaLibraryDocument; content: string; metadataError: string | null }> {
  const result = await mutateCollectionFile({ notebookId: await collectionNotebookId(notebookPath, notebookId),
    notebookPath, collectionId: collectionId, newName: title });
  onRenamed(result.filePath);
  return { filePath: result.filePath, document: parseMediaLibrary(result.content), content: result.content,
    metadataError: result.errorCode };
}
