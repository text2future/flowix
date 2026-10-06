import { describe, expect, it } from 'vitest';
import { addTableView, createTableDocument, parseTableDocument, serializeTableDocument, validateTableDocument } from './model';

describe('table format v1', () => {
  it('round trips a new table', () => {
    const table = createTableDocument();
    expect(table.version).toBe(1);
    expect(parseTableDocument(serializeTableDocument(table))).toEqual(table);
  });

  it('creates each view type over the shared records without requiring a data table view', () => {
    for (const type of ['table', 'kanban', 'calendar', 'gallery'] as const) {
      const document = createTableDocument(type);
      expect(document.table.views).toHaveLength(1);
      expect(document.table.views[0].type).toBe(type);
      expect(document.records).toEqual({ data: [], auto_collect: null });
      expect(parseTableDocument(serializeTableDocument(document))).toEqual(document);
    }
  });

  it('adds a second data table view without copying records', () => {
    const document = createTableDocument('gallery');
    const added = addTableView(document, 'table');
    expect(added.document.table.views.map((view) => view.type)).toEqual(['gallery', 'table']);
    expect(added.document.records).toBe(document.records);
  });

  it('rejects unsupported versions', () => {
    const table = createTableDocument();
    expect(() => parseTableDocument(serializeTableDocument({ ...table, version: 2 } as never))).toThrow('不支持');
  });

  it('rejects duplicate linked notes', () => {
    const table = createTableDocument();
    const records = ['a', 'b'].map((suffix) => ({
      id: `rec_${suffix.repeat(32)}`, updated_at: '', note_path: 'same.md',
    }));
    expect(() => parseTableDocument(serializeTableDocument({ ...table, records: { ...table.records, data: records } }))).toThrow('重复关联');
  });

  it('rejects property values duplicated in table records', () => {
    const table = createTableDocument();
    const record = {
      id: `rec_${'a'.repeat(32)}`,
      updated_at: '',
      note_path: '计划/项目.md',
      values: { status: '进行中' },
    };
    expect(() => validateTableDocument({ ...table, records: { ...table.records, data: [record] } })).toThrow('表格记录格式无效');
  });

  it('keeps conditions for note properties that are not table fields', () => {
    const table = createTableDocument();
    const withCondition = {
      ...table,
      records: {
        ...table.records,
        auto_collect: {
          condition: {
            property_match: 'union' as const,
            property_conditions: [{ field_id: 'workflow', operator: 'contains' as const, value: 'release' }],
          },
          excluded_note_paths: [],
        },
      },
    };

    expect(parseTableDocument(serializeTableDocument(withCondition))).toEqual(withCondition);
  });
});
