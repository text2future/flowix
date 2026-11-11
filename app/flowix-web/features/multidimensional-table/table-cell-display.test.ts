import { describe, expect, it } from 'vitest';
import type { NoteEntry } from '@platform/tauri/client';
import { displayTableFieldValue } from './table-cell-display';

const record = { id: 'rec_00000000000000000000000000000001', updated_at: '', note_path: 'missing.md' };

describe('displayTableFieldValue', () => {
  it('formats missing primary records according to lookup state', () => {
    const field = { id: 'fld_00000000000000000000000000000001', type: 'primary' as const, property_key: 'note' };
    expect(displayTableFieldValue(record, field, undefined, false)).toContain('未找到笔记');
    expect(displayTableFieldValue(record, field, undefined, true)).toContain('无法确认关联');
  });

  it('formats option labels for read-only views', () => {
    const field = {
      id: 'fld_00000000000000000000000000000002', type: 'Select' as const, property_key: 'status',
      options: [{ id: 'opt_00000000000000000000000000000001', label: '完成' }],
    };
    const note = { ...record, title: '任务', relativePath: '任务.md', properties: { status: '完成' } };
    expect(displayTableFieldValue(record, field, note as unknown as NoteEntry, false)).toBe('完成');
  });
});
