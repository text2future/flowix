import { describe, expect, it } from 'vitest';

import { resolveRowCollectionType } from './collection-row-icon';

describe('resolveRowCollectionType', () => {
  it('trusts the index type for pinned rows whose title has no suffix', () => {
    expect(resolveRowCollectionType({ collectionType: 'table', fileName: '表格2221' })).toBe('table');
    expect(resolveRowCollectionType({ collectionType: 'media_library', fileName: '媒体库121' })).toBe('media_library');
    expect(resolveRowCollectionType({ collectionType: 'work_documents', fileName: '工作文档' })).toBe('work_documents');
  });

  it('keeps the index type ahead of a misleading filename', () => {
    expect(resolveRowCollectionType({ collectionType: 'table', fileName: 'report.lib.yaml' })).toBe('table');
  });

  it('falls back to the catalog identity for directory rows', () => {
    expect(resolveRowCollectionType({ fileName: '集合.index.yaml', hasTableIdentity: true })).toBe('table');
    expect(resolveRowCollectionType({ fileName: '集合.index.yaml', hasMediaLibraryIdentity: true })).toBe('media_library');
    expect(resolveRowCollectionType({ fileName: '工作文档.index.yaml', workDocumentsCollection: true })).toBe('work_documents');
  });

  it('classifies descriptive filenames that carry no identity yet', () => {
    expect(resolveRowCollectionType({ fileName: '数据.table.yaml' })).toBe('table');
    expect(resolveRowCollectionType({ fileName: '素材.lib.yaml' })).toBe('media_library');
  });

  it('leaves ambiguous index files and plain files without a type', () => {
    expect(resolveRowCollectionType({ fileName: '集合.index.yaml' })).toBeUndefined();
    expect(resolveRowCollectionType({ fileName: '报告.pdf' })).toBeUndefined();
    expect(resolveRowCollectionType({ collectionType: 'unknown_kind', fileName: '报告' })).toBeUndefined();
  });
});
