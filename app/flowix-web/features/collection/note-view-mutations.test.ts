import { beforeEach, expect, it, vi } from 'vitest';
import { createTableDocument, parseTableDocument, serializeTableDocument } from '@features/multidimensional-table/public/create-api';
import { createMediaLibrary, serializeMediaLibrary } from '@features/media-library/model';
import { parseHybridCollection } from './model';
import { addCollectionDomain } from './folder-collection';
import { addCollectionNoteView } from './note-view-mutations';

const io = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn(), write: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({ files: { read: io.read, create: io.create }, externalDocuments: { write: io.write } }));
beforeEach(() => {
  vi.resetAllMocks();
  io.write.mockImplementation(async ({ content }) => ({ status: 'saved', content }));
});

it.each(['table', 'gallery', 'kanban', 'calendar'] as const)('creates only the requested %s view in a new folder collection', async (layout) => {
  io.read.mockResolvedValue(null);
  const result = await addCollectionNoteView('/book/project/.index.yaml', '/book', layout, '/book/project');
  const content = io.create.mock.calls[0][1];
  const hybrid = parseHybridCollection(content);
  const table = parseTableDocument(content);
  expect(hybrid.payload.file_tree).toBe(true);
  expect(Object.keys(hybrid.payload.domains)).toEqual(['notes']);
  expect(table.views.items).toHaveLength(1);
  expect(table.views.items[0].layout).toBe(layout);
  expect(table.views.default_id).toBe(result.viewId);
  expect(table.dataset.source).toEqual({ scope: 'containing_folder', depth: 'direct_children' });
  expect(hybrid.collection.properties.banner_image).toBeUndefined();
  expect(hybrid.collection.properties.banner_hidden).toEqual({ type: 'Boolean', value: true });
  expect(io.write).not.toHaveBeenCalled();
});

it.each(['table', 'gallery', 'kanban', 'calendar'] as const)('adds %s to an existing note collection without replacing prior views', async (layout) => {
  const original = createTableDocument('table', '笔记');
  const source = serializeTableDocument(original);
  io.read.mockResolvedValue(source);
  const result = await addCollectionNoteView('/book/笔记.index.yaml', '/book', layout);
  const write = io.write.mock.calls[0][0];
  const table = parseTableDocument(write.content);
  expect(write.expectedContent).toBe(source);
  expect(table.collection.id).toBe(original.collection.id);
  expect(table.views.items[0].id).toBe(original.views.items[0].id);
  expect(table.views.items).toHaveLength(2);
  expect(table.views.items.find((view) => view.id === result.viewId)?.layout).toBe(layout);
});

it('adds a calendar to a standalone media collection while preserving its identity, views and filter', async () => {
  const media = createMediaLibrary('图片');
  media.dataset.filter = { all: [{ field: 'path', op: 'contains', value: 'img' }], any: [] };
  io.read.mockResolvedValue(serializeMediaLibrary(media));
  const result = await addCollectionNoteView('/book/图片.lib.yaml', '/book', 'calendar');
  const hybrid = parseHybridCollection(io.write.mock.calls[0][0].content);
  expect(hybrid.collection.id).toBe(media.collection.id);
  expect(hybrid.collection.placement).toBe('standalone');
  expect(hybrid.payload.file_tree).toBe(false);
  expect(hybrid.payload.domains.media).toEqual(media.dataset);
  expect(hybrid.payload.views.items[0].id).toBe(media.views.items[0].id);
  expect(hybrid.payload.views.items.find((view) => view.id === result.viewId)?.layout).toBe('calendar');
});

it('reports a concurrent write instead of replacing a newer collection file', async () => {
  io.read.mockResolvedValue(serializeTableDocument(createTableDocument()));
  io.write.mockResolvedValue({ status: 'conflict' });
  await expect(addCollectionNoteView('/book/笔记.index.yaml', '/book', 'gallery')).rejects.toThrow('集合文件已变化');
  expect(io.create).not.toHaveBeenCalled();
});


it('expands a standalone media file with a list domain using notebook scope', async () => {
  const media = createMediaLibrary('图片');
  io.read.mockResolvedValue(serializeMediaLibrary(media));
  const result = await addCollectionDomain('/book/图片.lib.yaml', '/book', 'work_documents');
  const hybrid = parseHybridCollection(io.write.mock.calls[0][0].content);
  expect(hybrid.collection.id).toBe(media.collection.id);
  expect(hybrid.collection.placement).toBe('standalone');
  expect(hybrid.payload.file_tree).toBe(false);
  expect(hybrid.payload.domains.media).toEqual(media.dataset);
  expect(hybrid.payload.domains.work_documents?.source).toEqual({ scope: 'notebook', depth: 'descendants' });
  expect(result.domains).toEqual(['media', 'work_documents']);
});

it.each(['__note_created_at__', '__note_updated_at__'] as const)('preserves a selected system calendar field %s', async (fieldId) => {
  const original = createTableDocument('table', '笔记');
  io.read.mockResolvedValue(serializeTableDocument(original));
  const result = await addCollectionNoteView('/book/笔记.index.yaml', '/book', 'calendar', null, fieldId);
  const saved = parseTableDocument(io.write.mock.calls[0][0].content);
  expect(saved.views.items.find((view) => view.id === result.viewId)?.config.date_field).toBe(fieldId);
});
it('groups a new kanban by the chosen existing custom Select field', async () => {
  const original = createTableDocument('table', '笔记');
  const field = { id: `fld_${'a'.repeat(32)}`, property_key: 'priority', type: 'Select' as const, options: [] };
  original.dataset.schema.fields.push(field);
  original.dataset.schema.field_order.push(field.id);
  io.read.mockResolvedValue(serializeTableDocument(original));
  const result = await addCollectionNoteView('/book/笔记.index.yaml', '/book', 'kanban', null, field.id);
  const saved = parseTableDocument(io.write.mock.calls[0][0].content);
  expect(saved.views.items.find((view) => view.id === result.viewId)?.config.group_by).toBe(field.id);
  expect(saved.dataset.schema.fields.some((item) => item.property_key === 'status')).toBe(false);
});
