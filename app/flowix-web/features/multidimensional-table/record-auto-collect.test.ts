import { describe, expect, it } from 'vitest';
import type { NoteEntry } from '@platform/tauri/client';
import { noteMatchesAutoCollect } from './record-auto-collect';
import type { TableAutoCollectCondition, TableField } from './model';

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

describe('noteMatchesAutoCollect', () => {
  it('matches a note property that is not configured as a table field', () => {
    const condition: TableAutoCollectCondition = {
      property_match: 'union',
      property_conditions: [{ field_id: 'workflow', operator: 'contains', value: 'release' }],
    };

    expect(noteMatchesAutoCollect(note, [primaryField], primaryField.id, condition)).toBe(true);
  });

  it('still matches configured fields through their property key', () => {
    const statusField: TableField = { id: `fld_${'b'.repeat(32)}`, type: 'Text', property_key: 'status' };
    const condition: TableAutoCollectCondition = {
      property_match: 'union',
      property_conditions: [{ field_id: statusField.id, operator: 'equals', value: 'done' }],
    };
    const statusNote = { ...note, properties: { status: 'done' } } as NoteEntry;

    expect(noteMatchesAutoCollect(statusNote, [primaryField, statusField], primaryField.id, condition)).toBe(true);
  });
});
