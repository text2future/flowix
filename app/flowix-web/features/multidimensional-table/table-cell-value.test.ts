import { describe, expect, it } from 'vitest';
import { persistedTableCellValue } from './table-cell-value';

describe('persistedTableCellValue', () => {
  const field = {
    id: 'fld_00000000000000000000000000000001',
    type: 'Select' as const,
    property_key: 'status',
    options: [
      { id: 'opt_00000000000000000000000000000001', label: '进行中' },
      { id: 'opt_00000000000000000000000000000002', label: '完成' },
    ],
  };

  it('persists select labels instead of editor option ids', () => {
    expect(persistedTableCellValue(field, field.options[0].id)).toBe('进行中');
    expect(persistedTableCellValue(field, 'unknown')).toBeNull();
  });

  it('persists multi-select labels and keeps unknown values', () => {
    expect(persistedTableCellValue({ ...field, type: 'MultiSelect' }, [field.options[0].id, 'legacy'])).toEqual(['进行中', 'legacy']);
  });

  it('does not transform scalar values for other field types', () => {
    expect(persistedTableCellValue({ ...field, type: 'Text' }, 'hello')).toBe('hello');
  });
});
