import { expect, it, vi } from 'vitest';
import { createTableDocument, parseTableDocument, serializeTableDocument } from '@features/multidimensional-table/model';
import { createMediaLibrary, serializeMediaLibrary } from '@features/media-library/model';
import { matchesDatasetFilter, type DatasetFilter } from './rule-filter';
import { parseHybridCollection, serializeHybridCollectionDocument, serializeProjectedCollectionDocument } from './model';
import { assetConditionFromFilter } from './asset-filter';
import { createFolderHybridCollectionContent, addCollectionDomain, setCollectionAssetFilter } from './folder-collection';

const disk = vi.hoisted(() => ({ content: '' }));
vi.mock('@platform/tauri/client', () => ({
  files: { read: vi.fn(async () => disk.content) },
  externalDocuments: { write: vi.fn(async ({ content }: { content: string }) => {
    disk.content = content;
    return { status: 'saved', content };
  }) },
}));

it('a standalone calendar shares location and retains independent note and asset conditions after adding asset views', async () => {
  const calendar = createTableDocument('calendar', '独立日历');
  calendar.dataset.filter = { path: '项目', match: 'all', conditions: [
    { field: 'file_name', op: 'contains', value: '周报' },
  ] };
  disk.content = serializeTableDocument(calendar);
  await addCollectionDomain('/book/日历.index.yaml', '/book', 'media');
  let parsed = parseHybridCollection(disk.content);
  expect(parsed.payload.domains.media?.filter).toEqual({ path: '项目', match: 'all', conditions: [] });
  expect(parsed.payload.file_tree).toBe(false);

  await setCollectionAssetFilter('/book/日历.index.yaml', '/book', { path_contains: '客户', file_name_contains: '图片', file_types: ['image'] });
  parsed = parseHybridCollection(disk.content);
  expect(parsed.payload.domains.notes?.filter).toEqual({ path: '客户', match: 'all', conditions: [
    { field: 'file_name', op: 'contains', value: '周报' },
  ] });

  await addCollectionDomain('/book/日历.index.yaml', '/book', 'work_documents');
  parsed = parseHybridCollection(disk.content);
  expect(parsed.payload.domains.work_documents?.filter).toEqual(parsed.payload.domains.media?.filter);

  const notes = parsed.payload.domains.notes!;
  const noteFilter = notes.filter as Record<string, unknown>;
  disk.content = serializeProjectedCollectionDocument(disk.content, {
    collection: { ...parsed.collection, type: 'table', revision: parsed.collection.revision + 1 },
    dataset: { ...notes, filter: { ...noteFilter, path: '' } },
    views: { default_id: parsed.payload.views.default_by_domain.notes!, items: parsed.payload.views.items.filter((view) => view.domain === 'notes').map(({ domain: _domain, ...view }) => view) },
  }, 'notes');
  parsed = parseHybridCollection(disk.content);
  for (const domain of ['media', 'work_documents'] as const) {
    expect(assetConditionFromFilter(parsed.payload.domains[domain]?.filter as Record<string, unknown>)).toEqual({
      path_scope: 'all', file_name_contains: '图片', file_types: ['image'],
    });
  }

  await setCollectionAssetFilter('/book/日历.index.yaml', '/book', { file_name_contains: '合同' });
  parsed = parseHybridCollection(disk.content);
  expect((parsed.payload.domains.notes?.filter as Record<string, unknown>).path).toBeNull();
  expect((parsed.payload.domains.notes?.filter as Record<string, unknown>).conditions).toHaveLength(1);
});


it('preserves valid legacy media OR groups when the shared note location changes', async () => {
  const media = createMediaLibrary('旧图墙');
  const any = [
    { field: 'file_name', op: 'contains', value: '截图' },
    { field: 'file_name', op: 'contains', value: '照片' },
  ];
  media.dataset.filter = { all: [], any };
  disk.content = serializeMediaLibrary(media);
  await addCollectionDomain('/book/旧图墙.index.yaml', '/book', 'notes');
  const parsed = parseHybridCollection(disk.content);
  disk.content = serializeProjectedCollectionDocument(disk.content, {
    collection: { ...parsed.collection, type: 'table', revision: parsed.collection.revision + 1 },
    dataset: { ...parsed.payload.domains.notes!, filter: { path: '项目', match: 'all', conditions: [] } },
    views: { default_id: parsed.payload.views.default_by_domain.notes!, items: parsed.payload.views.items.filter((view) => view.domain === 'notes').map(({ domain: _domain, ...view }) => view) },
  }, 'notes');
  const filter = parseHybridCollection(disk.content).payload.domains.media!.filter as DatasetFilter;
  expect(filter).toEqual({ all: [{ field: 'path', op: 'contains', value: '项目' }], any });
  const matches = (path: string, name: string) => matchesDatasetFilter(filter, (rule) =>
    rule.field === 'path' ? path.startsWith(String(rule.value)) : name.includes(String(rule.value)));
  expect(matches('项目', '截图.png')).toBe(true);
  expect(matches('项目', '照片.jpg')).toBe(true);
  expect(matches('项目', '其他.png')).toBe(false);
  expect(matches('其他', '截图.png')).toBe(false);
});

it.each(['客户', '', null])('secondary asset saves preserve the latest disk location %s', async (path) => {
  const calendar = createTableDocument('calendar', '日历');
  calendar.dataset.filter = { path, match: 'all', conditions: [] };
  disk.content = serializeTableDocument(calendar);
  await addCollectionDomain('/book/日历.index.yaml', '/book', 'media');
  await setCollectionAssetFilter('/book/日历.index.yaml', '/book', {
    path_contains: '旧位置', file_name_contains: '新条件',
  }, { updateLocation: false });
  const domains = parseHybridCollection(disk.content).payload.domains;
  for (const domain of ['notes', 'media'] as const) {
    expect((domains[domain]!.filter as Record<string, unknown>).path).toBe(path);
  }
  expect((domains.media!.filter as Record<string, unknown>).conditions).toEqual([
    { field: 'file_name', op: 'contains', value: '新条件' },
  ]);
});

it('a note-only save upgrades old folder notes without changing sibling datasets', () => {
  const old = parseHybridCollection(createFolderHybridCollectionContent('Project', 'Project'));
  old.payload.domains.notes!.source = { scope: 'containing_folder', depth: 'direct_children' };
  const source = serializeHybridCollectionDocument(old);
  const saved = parseHybridCollection(serializeProjectedCollectionDocument(source, parseTableDocument(source), 'notes'));
  expect(saved.payload.domains.notes!.source).toEqual({ scope: 'containing_folder' });
  expect(saved.payload.domains.media).toEqual(old.payload.domains.media);
  expect(saved.payload.domains.work_documents).toEqual(old.payload.domains.work_documents);
});

it('sharing a changed location keeps every domain recursive without a depth setting', () => {
  const old = parseHybridCollection(createFolderHybridCollectionContent('Project', 'Old'));
  const source = serializeHybridCollectionDocument(old);
  const table = parseTableDocument(source);
  table.dataset.filter = { path: 'Project', match: 'all', conditions: [] };
  const saved = parseHybridCollection(serializeProjectedCollectionDocument(source, table, 'notes'));
  expect((saved.payload.domains.media!.filter as Record<string, unknown>).path).toBe('Project');
  expect(saved.payload.domains.media!.source).toEqual(old.payload.domains.media!.source);
  expect(saved.payload.domains.work_documents!.source).toEqual(old.payload.domains.work_documents!.source);
});

it('adding an asset domain to recursive folder notes uses the same recursive scope', async () => {
  disk.content = createFolderHybridCollectionContent('Project', 'Project', ['notes']);
  await addCollectionDomain('/book/Project/.index.yaml', '/book', 'media');
  const domains = parseHybridCollection(disk.content).payload.domains;
  expect(domains.notes!.source).toEqual({ scope: 'containing_folder' });
  expect(domains.media!.source).toEqual({ scope: 'containing_folder' });
});
