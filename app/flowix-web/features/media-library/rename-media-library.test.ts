import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMediaLibrary, serializeMediaLibrary } from './model';
import { mutateCollectionFile, collectionNotebookId } from '@features/collection/mutations';
import { renameMediaLibraryFile } from './rename-media-library';

vi.mock('@platform/tauri/client', () => ({ files: {} }));
vi.mock('@features/collection/mutations', () => ({ mutateCollectionFile: vi.fn(), collectionNotebookId: vi.fn() }));

describe('media library collection rename', () => {
  beforeEach(() => { vi.resetAllMocks(); vi.mocked(collectionNotebookId).mockResolvedValue('book'); });
  it('uses the stable collection identity and returns the committed content', async () => {
    const document = createMediaLibrary('Old');
    const renamed = { ...document, collection: { ...document.collection, name: 'New', revision: 1 } };
    const content = serializeMediaLibrary(renamed);
    vi.mocked(mutateCollectionFile).mockResolvedValue({ operationId: 'op', status: 'completed', collectionId: document.collection.id, actualName: 'New', actualRelativePath: 'New.lib.yaml', actualRevision: 1, indexSequence: 4, filePath: '/book/New.lib.yaml', content, errorCode: null });
    const onRenamed = vi.fn();
    const result = await renameMediaLibraryFile({ filePath: '/book/stale.lib.yaml', notebookPath: '/book', collectionId: document.collection.id, title: 'New', onRenamed });
    expect(mutateCollectionFile).toHaveBeenCalledWith({ notebookId: 'book', notebookPath: '/book', collectionId: document.collection.id, newName: 'New' });
    expect(result.document).toEqual(renamed);
    expect(onRenamed).toHaveBeenCalledWith('/book/New.lib.yaml');
  });
  it('publishes the actual path when only part of the operation completed', async () => {
    const document = createMediaLibrary('New');
    vi.mocked(mutateCollectionFile).mockResolvedValue({ operationId: 'op', status: 'partial', collectionId: document.collection.id, actualName: 'New', actualRelativePath: 'Old.lib.yaml', actualRevision: 1, indexSequence: 4, filePath: '/book/Old.lib.yaml', content: serializeMediaLibrary(document), errorCode: 'FILE_EXISTS' });
    const onRenamed = vi.fn();
    const result = await renameMediaLibraryFile({ filePath: '/book/Old.lib.yaml', notebookPath: '/book', collectionId: document.collection.id, title: 'New', onRenamed });
    expect(result.metadataError).toBe('FILE_EXISTS');
    expect(onRenamed).toHaveBeenCalledWith('/book/Old.lib.yaml');
  });
});
