import { beforeEach, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { externalDocuments } from '@platform/tauri/client';
import { createTableDocument, parseTableDocument, serializeTableDocument } from '@features/multidimensional-table/model';
import { createMediaLibrary, parseMediaLibrary, serializeMediaLibrary } from '@features/media-library/model';
import { createFolderCollectionContent } from './folder-collection';
import { repairCollectionFile } from './recovery';

vi.mock('@platform/tauri/client', () => ({
  externalDocuments: { read: vi.fn(), write: vi.fn() },
  notebooks: { getAll: vi.fn().mockResolvedValue([{ id: 'book', path: '/book' }]) },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(externalDocuments.write).mockImplementation(async ({ filePath, content }) => ({ status: 'saved', path: filePath, content }));
});

it.each([
  ['notes', 'standalone'], ['notes', 'folder'], ['media', 'standalone'], ['media', 'folder'],
] as const)('recovers %s content with invalid placement at a %s location', async (type, placement) => {
  const validSource = placement === 'folder' ? createFolderCollectionContent(type, '项目', '11测试')
    : type === 'notes' ? serializeTableDocument(createTableDocument('calendar', '项目', 'standalone'))
      : serializeMediaLibrary(createMediaLibrary('项目'));
  const wire = YAML.parse(validSource);
  const record = {
    id: 'rec_01a12e0b2ab97d089eeff757ebd4e643', updated_at: '2026-10-12T02:57:27.436Z',
    ...(type === 'notes' ? { note_path: 'Welcome111.md' } : { relative_path: 'photo.png', resource_id: 'image-1' }),
  };
  wire.payload.dataset.records.include.push(record);
  wire.collection.placement = 'standalone1';
  const damaged = YAML.stringify(wire);
  vi.mocked(externalDocuments.read).mockResolvedValue(damaged);
  const path = `/book/11测试/${placement === 'folder' ? '.index.yaml' : '新建多维日历.index.yaml'}`;
  const result = await repairCollectionFile(path, '/book');
  const write = vi.mocked(externalDocuments.write).mock.calls[0][0];
  const repaired = type === 'notes' ? parseTableDocument(write.content) : parseMediaLibrary(write.content);
  expect(write).toMatchObject({ filePath: path, scopePath: '/book', expectedContent: damaged });
  expect(result.placement).toBe(placement);
  expect(repaired.collection.id).toBe(wire.collection.id);
  expect(repaired.dataset.records.include).toEqual([type === 'notes' ? record : { ...record, resource_id: 'book::photo.png' }]);
  expect(repaired.views).toEqual(wire.payload.views);
  if (placement === 'folder') expect(repaired.dataset.source).toEqual({ scope: 'containing_folder' });
});

it('falls back to a valid table when the file has no recoverable YAML or collection type', async () => {
  vi.mocked(externalDocuments.read).mockResolvedValue('collection: [\ninvalid: {');
  const result = await repairCollectionFile('/book/11测试/broken.index.yaml', '/book');
  expect(result).toMatchObject({ collectionType: 'table', placement: 'standalone' });
  const write = vi.mocked(externalDocuments.write).mock.calls[0][0];
  expect(() => parseTableDocument(write.content)).not.toThrow();
});
