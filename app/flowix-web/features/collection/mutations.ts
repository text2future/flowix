import { collections, externalDocuments, notebooks, type CollectionMutationResult } from '@platform/tauri/client';
import { canonicalDirectoryPath } from '@/lib/path';
import { collectionDisplays } from '@/lib/collection-display-registry';
import { findFileDisplayId } from '@/lib/file-display-registry';
import { beginExternalDocumentRename } from '@features/document/store/external-document-operation';
import { publishLocalCollectionChange } from './events';
import { parseCollectionEnvelope, type CollectionProperty } from './model';

export async function collectionNotebookId(notebookPath: string, notebookId?: string | null): Promise<string> {
  if (notebookId) return notebookId;
  const notebook = (await notebooks.getAll()).find((item) => canonicalDirectoryPath(item.path) === canonicalDirectoryPath(notebookPath));
  if (!notebook) throw new Error('集合所属笔记本未注册');
  return notebook.id;
}
export async function mutateCollectionFile(options: {
  notebookId: string;
  notebookPath: string;
  collectionId: string;
  expectedRevision?: number;
  newName?: string;
  targetRelativePath?: string;
  properties?: Record<string, CollectionProperty | null>;
}): Promise<CollectionMutationResult & { filePath: string }> {
  const item = await collections.resolve(options.notebookId, options.collectionId);
  const root = canonicalDirectoryPath(options.notebookPath);
  const previousPath = `${root}/${item.relativePath}`;
  const envelope = parseCollectionEnvelope(await externalDocuments.read(previousPath, root));
  if (envelope.collection.id !== options.collectionId) throw new Error('集合身份已变化');
  const ids = new Set(collectionDisplays(options.notebookId, options.collectionId).map((record) => record.displayId));
  const fileDisplayId = findFileDisplayId(previousPath);
  if (fileDisplayId) ids.add(fileDisplayId);
  const operations = [...ids].map((id) => beginExternalDocumentRename(id));
  const cancelDeletes = operations.map((operation) => operation.expectSourceDelete(previousPath));
  try {
    const result = await collections.mutate({
      notebookId: options.notebookId, collectionId: options.collectionId,
      expectedRevision: options.expectedRevision ?? envelope.collection.revision,
      operationId: crypto.randomUUID(), newName: options.newName,
      targetRelativePath: options.targetRelativePath, properties: options.properties,
    });
    const filePath = `${root}/${result.actualRelativePath}`;
    for (const operation of operations) operation.expectFollowupWrite(filePath);
    const updated = parseCollectionEnvelope(result.content);
    publishLocalCollectionChange({ notebookId: options.notebookId, previousPath, fileDisplayId, indexSequence: result.indexSequence, item: {
      ...item, collectionId: result.collectionId, relativePath: result.actualRelativePath,
      name: result.actualName, revision: result.actualRevision, properties: updated.collection.properties,
      updatedAt: updated.collection.updated_at,
    } });
    return { ...result, filePath };
  } catch (error) {
    for (const cancel of cancelDeletes) cancel();
    throw error;
  } finally {
    for (const operation of operations) operation.finish();
  }
}
export async function renameCollectionAtPath(filePath: string, notebookPath: string, name: string, notebookId?: string | null, expectedCollectionId?: string) {
  const resolvedNotebookId = await collectionNotebookId(notebookPath, notebookId);
  // A known row identity takes precedence over a possibly reused cached path.
  if (expectedCollectionId) return mutateCollectionFile({ notebookId: resolvedNotebookId, notebookPath, collectionId: expectedCollectionId, newName: name });
  const envelope = parseCollectionEnvelope(await externalDocuments.read(filePath, notebookPath));
  return mutateCollectionFile({ notebookId: resolvedNotebookId, notebookPath,
    collectionId: envelope.collection.id, expectedRevision: envelope.collection.revision, newName: name });
}
