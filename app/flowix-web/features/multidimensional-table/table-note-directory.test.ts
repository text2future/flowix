import { describe, expect, it } from 'vitest';
import { createTableDocument } from './model';
import { tableNoteDirectory } from './table-note-directory';
import { legacyTableLocationFilter } from './table-legacy-location';

describe('table note storage and legacy location', () => {
  it('uses a stable notebook-relative database directory and rejects unsafe IDs', () => {
    expect(tableNoteDirectory('col_123')).toBe('.flowix/database/col_123');
    for (const id of ['../x', 'col_../x', 'col_', 'col_x/y']) expect(() => tableNoteDirectory(id)).toThrow();
  });
  it('does not automatically collect notes for new tables or folder collections', () => {
    const table = createTableDocument();
    expect(legacyTableLocationFilter(table)).toBeNull();
    table.dataset.filter = { path: null, match: 'all', conditions: [{ field: 'kind', op: 'eq', value: 'note' }] };
    expect(legacyTableLocationFilter(table)).toBeNull();
    table.collection.placement = 'folder';
    table.dataset.filter = { path: 'Project', match: 'all', conditions: [] };
    expect(legacyTableLocationFilter(table)).toBeNull();
  });
  it('preserves explicit legacy locations and their conditions', () => {
    const table = createTableDocument();
    table.dataset.filter = { path: 'Project', match: 'all', conditions: [{ field: 'kind', op: 'eq', value: 'note' }] };
    expect(legacyTableLocationFilter(table)).toEqual(table.dataset.filter);
    table.dataset.filter = null;
    table.dataset.source = { scope: 'folder', path: 'Old' };
    expect(legacyTableLocationFilter(table)).toEqual({ path: 'Old', match: 'all', conditions: [] });
  });
});
