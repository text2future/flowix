import { describe, expect, it } from 'vitest';
import type { NoteEntry } from '@platform/tauri/client';
import type { MultidimensionalTableDocument } from './model';
import { collectionConditionRecords, collectionDatasetRecords } from './collection-records';

/**
 * The row source rule was extracted from the table surface so the embedded-page
 * bridge can reuse it. These cases pin the two halves: rows the table links, and
 * rows it collects by condition (the reason a filter-driven collection has an
 * empty `records.include`).
 */
const PRIMARY = 'note';

function tableDocument(overrides: {
  include?: Array<{ id: string; note_path: string }>;
  exclude?: string[];
  filter?: Record<string, unknown> | null;
} = {}): MultidimensionalTableDocument {
  return {
    collection: { id: 'col_1' },
    dataset: {
      source: { scope: 'notebook', path: '', depth: 'descendants' },
      schema: {
        primary_field_id: PRIMARY,
        fields: [{ id: PRIMARY, type: 'primary', property_key: 'note' }],
        field_order: [PRIMARY],
        preset_fields: [],
      },
      records: {
        include: overrides.include ?? [],
        exclude: (overrides.exclude ?? []).map((note_path) => ({ note_path })),
      },
      filter: overrides.filter ?? null,
    },
    views: { default_id: 'v1', items: [] },
  } as unknown as MultidimensionalTableDocument;
}

function note(relativePath: string, properties: Record<string, unknown> = {}): NoteEntry {
  return {
    relativePath,
    title: relativePath.split('/').pop()!.replace(/\.md$/, ''),
    preview: '',
    thumbnail: null,
    tags: [],
    todos: [],
    agents: [],
    createdAt: 1,
    updatedAt: 1_700_000_000_000,
    favorited: false,
    icon: null,
    colors: [],
    properties,
  } as NoteEntry;
}

/** `.flowix/database/<id>` is where a table keeps its own notes. */
const DATABASE_NOTE = '.flowix/database/col_1/a.md';

describe('collection records', () => {
  it('keeps explicit records in stored order when nothing is collected', () => {
    const document = tableDocument({ include: [{ id: 'r1', note_path: '项目/a.md' }, { id: 'r2', note_path: '项目/b.md' }] });

    const records = collectionDatasetRecords({ document, notes: [note('项目/a.md')], filterFields: document.dataset.schema.fields });

    expect(records.map((record) => [record.id, record.note_path])).toEqual([['r1', '项目/a.md'], ['r2', '项目/b.md']]);
  });

  it('collects notes that match the table condition when no record is linked', () => {
    const document = tableDocument({
      filter: { path: '', match: 'all', conditions: [{ field: 'status', op: 'eq', value: '进行中' }] },
    });
    const notes = [note(DATABASE_NOTE, { status: '进行中' }), note('.flowix/database/col_1/b.md', { status: '已完成' })];

    const records = collectionConditionRecords({ document, notes, filterFields: document.dataset.schema.fields });

    expect(records.map((record) => record.note_path)).toEqual([DATABASE_NOTE]);
    expect(records[0].id).toBe('');
    expect(records[0].updated_at).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('gives the surface stable ids only when it asks for them', () => {
    const document = tableDocument({
      filter: { path: '', match: 'all', conditions: [{ field: 'status', op: 'eq', value: '进行中' }] },
    });
    const notes = [note(DATABASE_NOTE, { status: '进行中' })];

    const records = collectionConditionRecords({
      document, notes, filterFields: document.dataset.schema.fields, recordIdFor: () => 'rec_1',
    });

    expect(records[0].id).toBe('rec_1');
  });

  it('does not collect a note the table already links or excludes', () => {
    const filter = { path: '', match: 'all', conditions: [{ field: 'status', op: 'eq', value: '进行中' }] };
    const notes = [note('.flowix/database/col_1/a.md', { status: '进行中' }), note('.flowix/database/col_1/b.md', { status: '进行中' })];

    const linked = tableDocument({ include: [{ id: 'r1', note_path: '.flowix/database/col_1/a.md' }], filter });
    const excluded = tableDocument({ exclude: ['.flowix/database/col_1/b.md'], filter });

    expect(collectionConditionRecords({ document: linked, notes, filterFields: linked.dataset.schema.fields })
      .map((record) => record.note_path)).toEqual(['.flowix/database/col_1/b.md']);
    expect(collectionConditionRecords({ document: excluded, notes, filterFields: excluded.dataset.schema.fields })
      .map((record) => record.note_path)).toEqual(['.flowix/database/col_1/a.md']);
  });

  it('appends collected records after the linked ones', () => {
    const document = tableDocument({
      include: [{ id: 'r1', note_path: '项目/linked.md' }],
      filter: { path: '', match: 'all', conditions: [{ field: 'status', op: 'eq', value: '进行中' }] },
    });
    const notes = [note(DATABASE_NOTE, { status: '进行中' })];

    const records = collectionDatasetRecords({ document, notes, filterFields: document.dataset.schema.fields });

    expect(records.map((record) => record.note_path)).toEqual(['项目/linked.md', DATABASE_NOTE]);
  });
});
