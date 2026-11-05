import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mediaResources, notebookAssets } from '@platform/tauri/client';
import { resolveMediaLibraryAddDirectory } from './add-location';
import { importMediaLibraryFiles } from './media-import';
import { createMediaLibrary, createMediaLibraryRecord, mediaCollectionFilterFromCondition, type MediaLibraryDocument } from './model';

vi.mock('@platform/tauri/client', () => ({
  notebookAssets: { saveFromPath: vi.fn() },
  mediaResources: { get: vi.fn(), delete: vi.fn() },
  files: {},
}));

const filePath = '/notes/library.index.yaml';
const notebookPath = '/notes';
const setFolder = (document: MediaLibraryDocument, path: string) => ({
  ...document, dataset: { ...document.dataset, filter: mediaCollectionFilterFromCondition({ path_contains: path }) },
});

function options(document = createMediaLibrary('Library')) {
  return {
    paths: ['/local/photo.jpg'], notebookId: 'notebook', notebookPath, filePath, document,
    persist: vi.fn(async (mutate: (current: MediaLibraryDocument) => MediaLibraryDocument) => {
      mutate(document);
      return true;
    }),
    readLatest: vi.fn(async () => document as MediaLibraryDocument | null),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(mediaResources.get).mockRejectedValue(new Error('Not indexed yet'));
  vi.mocked(mediaResources.delete).mockResolvedValue(true);
  vi.mocked(notebookAssets.saveFromPath).mockResolvedValue({ path: '/notes/attachments/photo.jpg', created: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('media upload destination', () => {
  it('uses the backend attachments default so first uploads can create the directory', async () => {
    const result = await importMediaLibraryFiles(options());
    expect(result.completed).toEqual(['/notes/attachments/photo.jpg']);
    expect(notebookAssets.saveFromPath).toHaveBeenCalledWith('/local/photo.jpg', {
      notebookId: 'notebook', deduplicate: true, reuseNotebookFile: false, reuseExistingAttachment: false,
    });
  });

  it('imports into Browse and Save without reusing a copy in attachments', async () => {
    const input = options(setFolder(createMediaLibrary('Library'), 'gallery'));
    vi.mocked(notebookAssets.saveFromPath).mockResolvedValue({ path: '/notes/gallery/photo.jpg', created: true });
    await importMediaLibraryFiles(input);
    expect(notebookAssets.saveFromPath).toHaveBeenCalledWith('/local/photo.jpg', expect.objectContaining({
      targetDirectoryPath: '/notes/gallery', reuseNotebookFile: false, reuseExistingAttachment: false,
    }));
  });

  it('binds folder libraries to the index file directory', () => {
    const document = setFolder(createMediaLibrary('Library'), 'elsewhere');
    document.collection.placement = 'folder';
    document.dataset.source = { scope: 'containing_folder' };
    expect(resolveMediaLibraryAddDirectory({ document, notebookPath, filePath: '/notes/gallery/.index.yaml' }))
      .toBe('/notes/gallery');
  });

  it('rejects a save directory outside a restricted source before copying', async () => {
    const document = setFolder(createMediaLibrary('Library'), 'elsewhere');
    document.dataset.source = { scope: 'folder', path: 'gallery' };
    await expect(importMediaLibraryFiles(options(document))).rejects.toThrow('保存目录不在集合数据范围内');
    expect(notebookAssets.saveFromPath).not.toHaveBeenCalled();
  });

  it('rejects traversal paths before copying', async () => {
    await expect(importMediaLibraryFiles(options(setFolder(createMediaLibrary('Library'), '../outside'))))
      .rejects.toThrow('集合保存目录无效');
    expect(notebookAssets.saveFromPath).not.toHaveBeenCalled();
  });
});

describe('media import persistence and rollback', () => {
  it('counts a reused destination once and adds only one record', async () => {
    const input = options();
    input.paths = ['/local/photo.jpg', '/another/photo.jpg'];
    vi.mocked(notebookAssets.saveFromPath).mockResolvedValue({ path: '/notes/attachments/photo.jpg', created: false });
    let persisted: MediaLibraryDocument | undefined;
    input.persist.mockImplementation(async (mutate) => { persisted = mutate(input.document); return true; });
    const result = await importMediaLibraryFiles(input);
    expect(result.completed).toHaveLength(1);
    expect(persisted?.dataset.records.include).toHaveLength(1);
  });

  it('rolls back a new copy when records cannot be saved', async () => {
    const input = options();
    input.persist.mockResolvedValue(false);
    const result = await importMediaLibraryFiles(input);
    expect(result).toEqual({ completed: [], failed: 0, recordSaveFailed: true, cleanupFailed: 0 });
    expect(mediaResources.delete).toHaveBeenCalledWith('/notes/attachments/photo.jpg', notebookPath);
  });

  it('never deletes a reused file after save failure', async () => {
    const input = options();
    vi.mocked(notebookAssets.saveFromPath).mockResolvedValue({ path: '/notes/attachments/photo.jpg', created: false });
    input.persist.mockResolvedValue(false);
    expect((await importMediaLibraryFiles(input)).completed).toEqual([]);
    expect(mediaResources.delete).not.toHaveBeenCalled();
  });

  it('preserves new copies that were linked by a concurrent writer', async () => {
    const input = options();
    input.persist.mockResolvedValue(false);
    input.readLatest.mockResolvedValue({ ...input.document, dataset: { ...input.document.dataset,
      records: { include: [createMediaLibraryRecord('notebook-1', 'attachments/photo.jpg')], exclude: [] },
    } });
    expect((await importMediaLibraryFiles(input)).completed).toEqual(['/notes/attachments/photo.jpg']);
    expect(mediaResources.delete).not.toHaveBeenCalled();
  });

  it('rolls back when a concurrent edit changes the save destination', async () => {
    const input = options();
    input.persist.mockImplementation(async (mutate) => { mutate(setFolder(input.document, 'elsewhere')); return true; });
    const result = await importMediaLibraryFiles(input);
    expect(result.recordSaveFailed).toBe(true);
    expect(result.completed).toEqual([]);
    expect(mediaResources.delete).toHaveBeenCalledTimes(1);
  });

  it('preserves copies and reports incomplete cleanup when the latest document cannot be read', async () => {
    const input = options();
    input.persist.mockRejectedValue(new Error('write failed'));
    input.readLatest.mockRejectedValue(new Error('read failed'));
    const result = await importMediaLibraryFiles(input);
    expect(result.completed).toEqual([]);
    expect(result.cleanupFailed).toBe(1);
    expect(mediaResources.delete).not.toHaveBeenCalled();
  });

  it('continues importing after one file fails', async () => {
    const input = options();
    input.paths = ['/local/bad.jpg', '/local/photo.jpg'];
    vi.mocked(notebookAssets.saveFromPath).mockRejectedValueOnce(new Error('copy failed'));
    const result = await importMediaLibraryFiles(input);
    expect(result.failed).toBe(1);
    expect(result.completed).toEqual(['/notes/attachments/photo.jpg']);
  });
});

it('uses a mandatory legacy path without decoding the secondary OR rules', () => {
  const document = createMediaLibrary('Gallery');
  document.dataset.filter = {
    all: [{ field: 'path', op: 'contains', value: 'projects/photos' }],
    any: [
      { field: 'file_name', op: 'contains', value: 'cover' },
      { field: 'file_name', op: 'contains', value: 'banner' },
    ],
  };
  expect(resolveMediaLibraryAddDirectory({ document, notebookPath, filePath })).toBe('/notes/projects/photos');
});
