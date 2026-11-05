import { beforeEach, expect, it, vi } from 'vitest';
import { createMediaLibrary, serializeMediaLibrary } from '@features/media-library/model';
import { mutateCollectionFile } from './mutations';
import { subscribeLocalCollectionChanges } from './events';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), mutate: vi.fn(), read: vi.fn(), write: vi.fn(),
  pathMove: vi.fn(), linkMove: vi.fn(), replacePath: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({ collections: { resolve: mocks.resolve, mutate: mocks.mutate },
  externalDocuments: { read: mocks.read, write: mocks.write }, notebooks: { getAll: vi.fn() } }));
vi.mock('@/lib/collection-display-registry', () => ({ collectionDisplays: () => [] }));
vi.mock('@/lib/file-display-registry', () => ({ findFileDisplayId: () => null }));
vi.mock('@features/document/store/external-document-operation', () => ({ beginExternalDocumentRename: vi.fn() }));
vi.mock('@features/workspace/use-cases/notebook-path-move', () => ({ applyNotebookPathMove: mocks.pathMove }));
vi.mock('@features/workspace/use-cases/workspace-navigation', () => ({ replaceExternalDocumentPath: mocks.replacePath }));
vi.mock('@features/memo/services/note-link-rewriter', () => ({ updateNoteLinksAfterMove: mocks.linkMove }));

beforeEach(() => vi.resetAllMocks());

it('applies the confirmed folder move and sequence once without repairing files in the view layer', async () => {
  const original = createMediaLibrary('Old');
  original.collection.placement = 'folder';
  original.dataset.source = { scope: 'containing_folder' };
  const next = { ...original, collection: { ...original.collection, name: 'New', revision: 1 } };
  mocks.resolve.mockResolvedValue({ relativePath: 'Old/.index.yaml', collectionId: original.collection.id, indexSequence: 1 });
  mocks.read.mockResolvedValue(serializeMediaLibrary(original));
  mocks.mutate.mockResolvedValue({ operationId: 'rename', status: 'completed', collectionId: original.collection.id,
    actualName: 'New', actualRelativePath: 'New/.index.yaml', previousRelativePath: 'Moved/.index.yaml',
    notebookPath: '/book', actualRevision: 1, indexSequence: 7, content: serializeMediaLibrary(next), errorCode: null,
    directoryMove: { previousRelativePath: 'Moved', relativePath: 'New' } });
  const changes: unknown[] = [];
  const stop = subscribeLocalCollectionChanges((change) => changes.push(change));
  try {
    const result = await mutateCollectionFile({ notebookId: 'book', notebookPath: '/book', collectionId: original.collection.id, newName: 'New' });
    expect(result.filePath).toBe('/book/New/.index.yaml');
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.pathMove).not.toHaveBeenCalled();
    expect(mocks.linkMove).not.toHaveBeenCalled();
    expect(changes).toEqual([expect.objectContaining({ previousPath: '/book/Moved/.index.yaml', indexSequence: 7,
      item: expect.objectContaining({ relativePath: 'New/.index.yaml', name: 'New', revision: 1, indexSequence: 7 }) })]);
  } finally { stop(); }
});

it('rejects a reused locator before submitting an operation for the wrong collection', async () => {
  const original = createMediaLibrary('Old');
  mocks.resolve.mockResolvedValue({ relativePath: 'Old/.index.yaml' });
  mocks.read.mockResolvedValue(serializeMediaLibrary(createMediaLibrary('Replacement')));
  await expect(mutateCollectionFile({ notebookId: 'book', notebookPath: '/book', collectionId: original.collection.id, newName: 'New' }))
    .rejects.toThrow('集合身份已变化');
  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(mocks.pathMove).not.toHaveBeenCalled();
});
