import { describe, expect, it } from 'vitest';
import { groupRecordsByValue } from './view-index';
import type { TableRecord } from './model';

describe('groupRecordsByValue', () => {
  it('preserves order and skips empty values', () => {
    const records = ['a', 'b', 'c', 'd'].map((id) => ({ id, note_path: `${id}.md`, updated_at: '' } satisfies TableRecord));
    const values: Record<string, string> = { a: 'todo', b: '', c: 'done', d: 'todo' };
    const grouped = groupRecordsByValue(records, (record) => values[record.id]);
    expect(grouped.get('todo')?.map((record) => record.id)).toEqual(['a', 'd']);
    expect(grouped.get('done')?.map((record) => record.id)).toEqual(['c']);
    expect(grouped.has('')).toBe(false);
  });
});
