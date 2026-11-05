import { describe, expect, it } from 'vitest';
import { resolveCollectionSaveDirectory } from './save-location';
import type { CollectionSource } from './model';

const table = {
  filePath: '/notes/tables/project.index.yaml', notebookPath: '/notes',
  placement: 'standalone' as const, source: { scope: 'notebook' } as CollectionSource,
  defaultDirectory: '/notes/tables',
};

describe('table Browse and Save directory policy', () => {
  it('creates notes beside the YAML when no concrete Browse and Save folder is selected', () => {
    expect(resolveCollectionSaveDirectory(table)).toBe('/notes/tables');
  });

  it('uses the selected folder ahead of the YAML directory', () => {
    expect(resolveCollectionSaveDirectory({ ...table, filter: { path: 'projects/notes', match: 'all', conditions: [] } }))
      .toBe('/notes/projects/notes');
  });

  it('keeps folder tables bound to their folder even if an old filter specifies another location', () => {
    expect(resolveCollectionSaveDirectory({ ...table, placement: 'folder', filter: { path: 'old-location', match: 'all', conditions: [] },
      source: { scope: 'containing_folder' },
    })).toBe('/notes/tables');
  });

  it('rejects creation outside the source so a new note cannot disappear from the table', () => {
    expect(() => resolveCollectionSaveDirectory({ ...table, filter: { path: 'outside', match: 'all', conditions: [] },
      source: { scope: 'folder', path: 'tables' },
    })).toThrow('保存目录不在集合数据范围内');
  });
});
