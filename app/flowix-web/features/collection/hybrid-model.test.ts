import { describe, expect, it } from 'vitest';
import { createFolderHybridCollectionContent } from './folder-collection';
import YAML from 'yaml';
import { createTableDocument, parseTableDocument, serializeTableDocument, addTableView } from '@features/multidimensional-table/model';
import { createMediaLibrary, parseMediaLibrary } from '@features/media-library/model';
import { createWorkDocumentsCollection } from '@features/work-documents/model';
import {
  collectionSourceDomain,
  createCollectionMetadata,
  isHybridCollectionSource,
  parseCollectionDocumentV2,
  serializeHybridCollectionDocument,
  serializeProjectedCollectionDocument,
  type HybridCollectionDocument,
} from './model';

function buildHybridSource(options?: { fileTree?: boolean; placement?: 'standalone' | 'folder' }): string {
  const placement = options?.placement ?? 'folder';
  const source = placement === 'folder'
    ? { scope: 'containing_folder' as const }
    : { scope: 'notebook' as const };
  const table = createTableDocument('table', '项目', placement);
  table.dataset.source = source;
  const media = createMediaLibrary('项目');
  media.collection.placement = placement;
  media.dataset.source = source;
  const work = createWorkDocumentsCollection('项目');
  work.collection.placement = placement;
  work.dataset.source = source;
  const document: HybridCollectionDocument = {
    format: 'flowix.collection',
    schema_version: 3,
    collection: { ...createCollectionMetadata('hybrid', '项目', placement) },
    payload: {
      schema_version: 3,
      file_tree: options?.fileTree ?? true,
      domains: {
        notes: table.dataset,
        media: media.dataset,
        work_documents: work.dataset,
      },
      views: {
        default_by_domain: {
          notes: table.views.default_id,
          media: media.views.default_id,
          work_documents: work.views.default_id,
        },
        items: [
          ...table.views.items.map((view) => ({ ...view, domain: 'notes' as const })),
          ...media.views.items.map((view) => ({ ...view, domain: 'media' as const })),
          ...work.views.items.map((view) => ({ ...view, domain: 'work_documents' as const })),
        ],
      },
    },
  };
  return serializeHybridCollectionDocument(document);
}

describe('hybrid collection model', () => {
  it('round-trips through serialize and projects each domain by requested type', () => {
    const source = buildHybridSource();
    expect(isHybridCollectionSource(source)).toBe(true);
    const table = parseTableDocument(source);
    expect(table.collection.type).toBe('table');
    expect(table.collection.placement).toBe('folder');
    expect(table.dataset.source).toEqual({ scope: 'containing_folder' });
    const media = parseMediaLibrary(source);
    expect(media.collection.type).toBe('media_library');
    expect(media.dataset.source).toEqual({ scope: 'containing_folder' });
    const untyped = parseCollectionDocumentV2(source);
    expect(untyped.collection.type).toBe('table');
    expect(() => parseTableDocument(serializeTableDocument(table)).dataset).toBeDefined();
    // 表格投影再序列化仍是 v2 文件（v2 来源走原路径）
    expect(YAML.parse(serializeTableDocument(table)).schema_version).toBe(2);
  });

  it('merges a domain projection back without touching sibling domains', () => {
    const source = buildHybridSource();
    const table = parseTableDocument(source);
    const { document: next } = addTableView(table, 'gallery');
    const merged = serializeProjectedCollectionDocument(source, next, 'notes');
    expect(isHybridCollectionSource(merged)).toBe(true);
    const reparsedTable = parseTableDocument(merged);
    expect(reparsedTable.views.items.some((view) => view.id === next.views.default_id)).toBe(true);
    expect(reparsedTable.collection.revision).toBe(next.collection.revision);
    const media = parseMediaLibrary(merged);
    expect(media.views.items).toHaveLength(1);
    expect(media.collection.revision).toBe(next.collection.revision);
    expect(collectionSourceDomain(merged, 'table')).toBe('notes');
    expect(collectionSourceDomain(merged, 'media_library')).toBe('media');
    expect(collectionSourceDomain(serializeTableDocument(createTableDocument()), 'table')).toBeNull();
  });

  it('rejects invalid hybrid envelopes', () => {
    const source = buildHybridSource();
    // file_tree 在 standalone 上不允许
    const standalone = buildHybridSource({ placement: 'standalone', fileTree: false });
    expect(isHybridCollectionSource(standalone)).toBe(true);
    const standaloneWithTree = standalone.replace('file_tree: false', 'file_tree: true');
    expect(() => parseCollectionDocumentV2(standaloneWithTree, 'table')).toThrow();
    // 视图指向不存在的域
    const broken = source.replace('domain: notes', 'domain: bookmarks');
    expect(() => parseCollectionDocumentV2(broken, 'table')).toThrow();
    // 域存在但无视图
    const noMediaViews = YAML.parse(source) as {
      payload: { views: { items: { domain: string }[] } };
    };
    noMediaViews.payload.views.items = noMediaViews.payload.views.items.filter(
      (view) => view.domain !== 'media',
    );
    expect(() => parseCollectionDocumentV2(YAML.stringify(noMediaViews), 'table')).toThrow();
    // v2 文件不受影响
    expect(() => parseCollectionDocumentV2(serializeTableDocument(createTableDocument()), 'table')).not.toThrow();
  });
});


it.each(['notes', 'media', 'work_documents'] as const)('folder views are created on demand for %s only', (domain) => {
  const source = createFolderHybridCollectionContent('项目', '项目', [domain]);
  const wire = YAML.parse(source);
  expect(wire.payload.file_tree).toBe(true);
  expect(Object.keys(wire.payload.domains)).toEqual([domain]);
  expect(wire.payload.views.items).toHaveLength(1);
  expect(wire.payload.views.items[0].domain).toBe(domain);
});
