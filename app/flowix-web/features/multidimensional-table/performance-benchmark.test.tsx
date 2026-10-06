import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createTableDocument, createUuidV7, parseTableDocument, serializeTableDocument, validateTableDocument, type TableField, type TableRecord } from './model';
import { groupRecordsByValue } from './view-index';
import { TableKanbanView, TableCalendarView } from './table-secondary-views';

const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil((values.length - 1) * fraction))];

function measure(operation: () => void, rounds = 25) {
  const samples: number[] = [];
  for (let i = 0; i < rounds; i += 1) {
    const start = performance.now();
    operation();
    samples.push(performance.now() - start);
  }
  return { rounds, medianMs: Number(percentile(samples, 0.5).toFixed(2)), p95Ms: Number(percentile(samples, 0.95).toFixed(2)) };
}

describe('multidimensional table 1k x 20 frontend benchmark', () => {
  it('reports parse, serialize, grouping, pagination and view render costs', () => {
    const document = createTableDocument();
    const noteField = document.table.fields[0];
    const fields: TableField[] = [noteField];
    for (let index = 0; index < 19; index += 1) {
      fields.push({ id: `fld_${createUuidV7()}`, type: index === 0 ? 'Select' : index === 1 ? 'Date' : index === 2 ? 'Image' : 'Text', property_key: `field_${index}`,
        ...(index === 2 ? { multiple: true } : {}),
        ...(index === 0 ? { options: Array.from({ length: 10 }, (_, option) => ({ id: `opt_${createUuidV7()}`, label: `status_${option}` })) } : {}) });
    }
    const fieldsById = new Map(fields.map((field) => [field.id, field]));
    const propertiesByPath = new Map<string, Record<string, unknown>>();
    const records: TableRecord[] = Array.from({ length: 1_000 }, (_, index) => {
      const notePath = `notes/note-${index}.md`;
      const properties = Object.fromEntries(fields.slice(1).map((field, fieldIndex) => [
        field.property_key!,
        field.type === 'Select' ? `status_${index % 10}`
          : field.type === 'Date' ? `2026-01-${String(index % 28 + 1).padStart(2, '0')}`
            : field.type === 'Image' ? index < 200 ? [`assets/image-${index}.png`] : []
              : `value-${index}-${fieldIndex}`,
      ]));
      propertiesByPath.set(notePath, properties);
      return {
      id: `rec_${createUuidV7()}`,
      updated_at: '2026-01-01T00:00:00.000Z',
      note_path: notePath,
    };
    });
    document.table.fields = fields;
    document.table.views[0].config.visible_fields = fields.map(({ id }) => id);
    document.records.data = records;
    const source = serializeTableDocument(document);
    const statusField = fields[1];
    const dateField = fields[2];
    const grouped = groupRecordsByValue(records, (record) => {
      const label = propertiesByPath.get(record.note_path)?.[statusField.property_key ?? ''];
      return statusField.options?.find((option) => option.label === label)?.id;
    });
    const calendarGroups = groupRecordsByValue(records, (record) => String(propertiesByPath.get(record.note_path)?.[dateField.property_key ?? ''] ?? ''));
    const visibleRows = records.slice(0, 100);
    const display = (record: TableRecord, field: TableField) => field.type === 'primary'
      ? record.note_path.split('/').pop() ?? '—'
      : String(propertiesByPath.get(record.note_path)?.[field.property_key ?? ''] ?? '—');
    const days = Array.from({ length: 42 }, (_, index) => ({ date: new Date(2026, 0, index + 1), iso: `2026-01-${String(index % 28 + 1).padStart(2, '0')}`, inMonth: index < 31 }));
    const results = {
      yamlBytes: new TextEncoder().encode(source).length,
      rowsPerPage: visibleRows.length,
      parse: measure(() => { parseTableDocument(source); }),
      serialize: measure(() => { serializeTableDocument(document); }),
      validateInMemory: measure(() => { validateTableDocument(document); }),
      group1k: measure(() => { groupRecordsByValue(records, (record) => String(propertiesByPath.get(record.note_path)?.[statusField.property_key ?? ''] ?? '')); }),
      paginationSlice100: measure(() => { records.slice(0, 100); }, 50),
      kanbanRender1k: measure(() => { renderToStaticMarkup(<TableKanbanView groupField={fields[1]} titleField={fields[0]} groups={grouped} renderValue={display} onDropRecord={() => {}} onReorderLane={() => {}} />); }, 7),
      calendarRender1k: measure(() => { renderToStaticMarkup(<TableCalendarView cursor={new Date(2026, 0, 1)} onCursorChange={() => {}} days={days} groups={calendarGroups} dateFieldId={fields[2].id} titleField={fields[0]} renderValue={display} onMoveRecord={() => {}} />); }, 7),
    };
    console.info('TABLE_PERF_1K_X_20', JSON.stringify(results));
    expect(parseTableDocument(source).records.data).toHaveLength(1_000);
    expect(fieldsById.size).toBe(20);
    expect(visibleRows).toHaveLength(100);
    expect([...propertiesByPath.values()].filter((properties) => Array.isArray(properties.field_2) && properties.field_2.length > 0)).toHaveLength(200);
  });
});
