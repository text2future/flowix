import { describe, expect, it } from 'vitest';
import type { NoteEntry } from '@platform/tauri/client';
import { noteMatchesCollectionFilter } from './record-filter';
import { NOTE_CREATED_AT_FIELD_ID, NOTE_PATH_FIELD_ID } from './builtin-fields';
import type { TableField } from './model';

const primaryField: TableField = {
  id: `fld_${'a'.repeat(32)}`,
  type: 'primary',
  property_key: 'note',
};

const note = {
  relativePath: 'Release.md',
  title: 'Release notes',
  properties: { workflow: 'release candidate' },
} as unknown as NoteEntry;

describe('noteMatchesCollectionFilter', () => {
  it('matches a note property that is not configured as a table field', () => {
    const filter = { all: [], any: [{ field: 'workflow', op: 'contains', value: 'release' }] };

    expect(noteMatchesCollectionFilter(note, [primaryField], primaryField.id, filter)).toBe(true);
  });

  it('still matches configured fields through their property key', () => {
    const statusField: TableField = { id: `fld_${'b'.repeat(32)}`, type: 'Text', property_key: 'status' };
    const filter = { all: [{ field: statusField.id, op: 'equals', value: 'done' }], any: [] };
    const statusNote = { ...note, properties: { status: 'done' } } as NoteEntry;

    expect(noteMatchesCollectionFilter(statusNote, [primaryField, statusField], primaryField.id, filter)).toBe(true);
  });

  it('compares Number properties numerically', () => {
    const countField: TableField = { id: `fld_${'c'.repeat(32)}`, type: 'Number', property_key: 'count' };
    const countNote = { ...note, properties: { count: 1 } } as NoteEntry;
    const filter = { path: null, match: 'all' as const, conditions: [{ field: 'count', op: 'eq', value: '1.0' }] };

    expect(noteMatchesCollectionFilter(countNote, [primaryField, countField], primaryField.id, filter)).toBe(true);
    expect(noteMatchesCollectionFilter(countNote, [primaryField], primaryField.id, filter)).toBe(true);
  });

  it('matches the calendar day for built-in creation dates', () => {
    const createdAt = new Date(2026, 4, 3, 18, 20).getTime();
    const datedNote = { ...note, createdAt } as NoteEntry;
    const filter = { path: null, match: 'all' as const, conditions: [{ field: NOTE_CREATED_AT_FIELD_ID, op: 'eq', value: '2026-05-03' }] };

    expect(noteMatchesCollectionFilter(datedNote, [primaryField], primaryField.id, filter)).toBe(true);
  });
});

describe('relative directory equality', () => {
  it.each(['eq', 'equals'])('matches only documents directly in the displayed directory with %s', (op) => {
    const filter = { all: [{ field: NOTE_PATH_FIELD_ID, op, value: '项目/子目录' }], any: [] };
    const matches = (relativePath: string) => noteMatchesCollectionFilter({ ...note, relativePath }, [], '', filter);
    expect(matches('项目/子目录/方案.md')).toBe(true);
    expect(matches('项目/子目录/其他.md')).toBe(true);
    expect(matches('项目\\子目录\\方案.md')).toBe(true);
    expect(matches('项目/子目录/更深/方案.md')).toBe(false);
    expect(matches('项目/子目录2/方案.md')).toBe(false);
    expect(matches('项目/方案.md')).toBe(false);
  });

  it('matches root documents with the empty displayed directory', () => {
    const filter = { all: [{ field: NOTE_PATH_FIELD_ID, op: 'eq', value: '' }], any: [] };
    expect(noteMatchesCollectionFilter(note, [], '', filter)).toBe(true);
    expect(noteMatchesCollectionFilter({ ...note, relativePath: '项目/方案.md' }, [], '', filter)).toBe(false);
  });
});
