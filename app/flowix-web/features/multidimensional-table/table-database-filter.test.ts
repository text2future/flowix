import { expect, it } from 'vitest';
import { createTableDocument } from './model';
import { tableDatabaseFilter, isTableDatabaseNote } from './table-database-filter';
import { noteMatchesCollectionFilter } from './record-filter';
import type { NoteEntry } from '@platform/tauri/client';

it('applies note criteria only to this table database, independent of legacy location', () => {
  const table = createTableDocument();
  const id = table.dataset.schema.primary_field_id;
  table.dataset.filter = { path: 'Old', match: 'all', conditions: [{ field: 'file_name', op: 'contains', value: 'report' }] };
  const filter = tableDatabaseFilter(table)!;
  const matches = (relativePath: string) => noteMatchesCollectionFilter({ relativePath, title: relativePath, properties: {} } as NoteEntry, table.dataset.schema.fields, id, tableDatabaseFilter(table, relativePath)!);
  const path = `.flowix/database/${table.collection.id}/report.md`;
  expect(filter.path).toBe(`.flowix/database/${table.collection.id}`);
  expect(matches(path)).toBe(true);
  expect(matches(`.flowix/database/${table.collection.id}/other.md`)).toBe(false);
  expect(matches(`database/${table.collection.id}/report.md`)).toBe(true);
  expect(isTableDatabaseNote(table, `database/${table.collection.id}/report.md`)).toBe(true);
  expect(matches('Old/report.md')).toBe(false);
  expect(isTableDatabaseNote(table, path)).toBe(true);
  expect(isTableDatabaseNote(table, `database/${table.collection.id}2/report.md`)).toBe(false);
});

it('does not auto-collect database notes without actual criteria', () => {
  const table = createTableDocument();
  table.dataset.filter = { path: 'Old', match: 'all', conditions: [] };
  expect(tableDatabaseFilter(table)).toBeNull();
});
