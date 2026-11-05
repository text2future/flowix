import { describe, expect, it } from 'vitest';
import type { NoteEntry } from '@platform/tauri/client';
import { BUILTIN_TABLE_FIELDS, builtinTableFieldValue, NOTE_PATH_FIELD_ID, NOTE_SIZE_FIELD_ID, NOTE_CREATED_AT_FIELD_ID, NOTE_ICON_FIELD_ID, NOTE_TAGS_FIELD_ID, NOTE_COLORS_FIELD_ID, NOTE_PINNED_FIELD_ID, NOTE_DESCRIPTION_FIELD_ID, builtinPresetValue, builtinPresetTableField } from './builtin-fields';
import sharedFixture from '../../../fixtures/collections/table-builtin-fields.yaml?raw';
import { addTableView, createTableDocument, parseTableDocument, serializeTableDocument } from './model';
import { createFolderCollectionContent } from '../collection/folder-collection';

const note = { relativePath: '项目/方案.md', sizeBytes: 1_250_000, createdAt: NaN } as NoteEntry;

describe('builtin table fields', () => {
  it('formats notebook-relative directories and decimal file sizes', () => {
    expect(builtinTableFieldValue(NOTE_PATH_FIELD_ID, note, '/Notes/开发任务管理/')).toBe('项目');
    expect(builtinTableFieldValue(NOTE_PATH_FIELD_ID, { ...note, relativePath: '方案.md' }, '/Notes/开发任务管理')).toBe('');
    expect(builtinTableFieldValue(NOTE_SIZE_FIELD_ID, note, null)).toBe('1.25 MB');
    expect(builtinTableFieldValue(NOTE_SIZE_FIELD_ID, { ...note, sizeBytes: 0 }, null)).toBe('0 B');
  });

  it.each([
    [14, '14 B'], [350, '350 B'], [999, '999 B'],
    [1_000, '1.00 KB'], [2_565, '2.56 KB'], [8_149, '8.15 KB'],
    [999_000, '999.00 KB'], [1_000_000, '1.00 MB'],
  ])('formats %i bytes as %s without rounding small documents to zero', (sizeBytes, expected) => {
    expect(builtinTableFieldValue(NOTE_SIZE_FIELD_ID, { ...note, sizeBytes }, null)).toBe(expected);
  });

  it.each([-1, NaN, Infinity])('rejects invalid byte counts (%s)', (sizeBytes) => {
    expect(builtinTableFieldValue(NOTE_SIZE_FIELD_ID, { ...note, sizeBytes }, null)).toBe('—');
  });

  it('shows missing metadata as unavailable', () => {
    expect(builtinTableFieldValue(NOTE_SIZE_FIELD_ID, { ...note, sizeBytes: undefined }, null)).toBe('—');
    expect(builtinTableFieldValue(NOTE_CREATED_AT_FIELD_ID, note, null)).toBe('—');
    for (const field of BUILTIN_TABLE_FIELDS) {
      expect(builtinTableFieldValue(field.id, undefined, '/Notes')).toBe('');
    }
  });

  it('round trips visibility without adding schema properties, including hiding fields', () => {
    const document = createTableDocument();
    document.views.items[0].config.visible_fields = BUILTIN_TABLE_FIELDS.map((field) => field.id);
    expect(parseTableDocument(serializeTableDocument(document))).toEqual(document);
    document.views.items[0].config.visible_fields = [];
    expect(parseTableDocument(serializeTableDocument(document))).toEqual(document);
    expect(document.dataset.schema.fields).toHaveLength(1);
    document.views.items[0].config.visible_fields = ['__unknown__'];
    expect(() => parseTableDocument(serializeTableDocument(document))).toThrow('不存在的字段');
  });

  it('defaults folder tables to dates and path, keeping size and standalone defaults hidden', () => {
    const document = parseTableDocument(createFolderCollectionContent('notes', '项目'));
    const visible = document.views.items[0].config.visible_fields as string[];
    for (const field of BUILTIN_TABLE_FIELDS) expect(visible.includes(field.id)).toBe(field.defaultInFolder);
    document.views.items[0].config.visible_fields = [];
    const added = addTableView(document, 'table');
    for (const field of BUILTIN_TABLE_FIELDS) expect((added.view.config.visible_fields as string[]).includes(field.id)).toBe(field.defaultInFolder);
    expect(added.document.views.items[0].config.visible_fields).toEqual([]);
    expect(addTableView(createTableDocument(), 'table').view.config.visible_fields).toHaveLength(1);
    expect(createTableDocument().views.items[0].config.visible_fields).not.toContain(NOTE_SIZE_FIELD_ID);
  });
});

describe('shared collection contract fixture', () => {
  it('preserves builtin visibility and rejects unknown fields through the full parser', () => {
    const document = parseTableDocument(sharedFixture);
    expect(document.views.items[0].config.visible_fields).toEqual([
      document.dataset.schema.primary_field_id, ...BUILTIN_TABLE_FIELDS.filter((field) => !builtinPresetTableField(field.id) || document.dataset.schema.preset_fields.includes(field.id)).map((field) => field.id),
    ]);
    expect(parseTableDocument(serializeTableDocument(document))).toEqual(document);
    document.views.items[0].config.visible_fields = [];
    expect(parseTableDocument(serializeTableDocument(document)).views.items[0].config.visible_fields).toEqual([]);
    document.views.items[0].config.visible_fields = ['__unknown__'];
    expect(() => parseTableDocument(serializeTableDocument(document))).toThrow('不存在的字段');
  });
});

it('reads preset metadata directly from the note index, leaving absent values empty', () => {
  const indexed = { ...note, icon: 'star', tags: ['项目', '计划'], colors: ['red', 'blue'], todos: [{ status: 'done' }, { status: 'todo' }] } as NoteEntry;
  expect(builtinTableFieldValue(NOTE_ICON_FIELD_ID, indexed, null)).toBe('star');
  expect(builtinTableFieldValue(NOTE_TAGS_FIELD_ID, indexed, null)).toBe('项目, 计划');
  expect(builtinTableFieldValue(NOTE_COLORS_FIELD_ID, indexed, null)).toBe('red, blue');
  const empty = { ...note, icon: null, tags: [], colors: [], todos: [] } as NoteEntry;
  for (const id of [NOTE_ICON_FIELD_ID, NOTE_TAGS_FIELD_ID, NOTE_COLORS_FIELD_ID]) {
    expect(builtinTableFieldValue(id, empty, null)).toBe('');
    expect(builtinTableFieldValue(id, undefined, null)).toBe('');
  }
});

it('binds editable columns to note presets and prefers pending frontmatter values over projections', () => {
  const indexed = { ...note, favorited: true, icon: 'star', properties: { description: '说明', flowix_icon: null, flowix_favorited: false, tags: ['新标签'], flowix_colors: [] } } as NoteEntry;
  expect(builtinPresetValue(NOTE_PINNED_FIELD_ID, indexed)).toBe(false);
  expect(builtinPresetValue(NOTE_ICON_FIELD_ID, indexed)).toBeNull();
  expect(builtinPresetValue(NOTE_TAGS_FIELD_ID, indexed)).toEqual(['新标签']);
  expect(builtinPresetValue(NOTE_COLORS_FIELD_ID, indexed)).toEqual([]);
  expect(builtinTableFieldValue(NOTE_DESCRIPTION_FIELD_ID, indexed, null)).toBe('说明');
  expect(builtinTableFieldValue(NOTE_DESCRIPTION_FIELD_ID, note, null)).toBe('');
  expect(builtinPresetTableField(NOTE_PINNED_FIELD_ID)).toEqual({ id: NOTE_PINNED_FIELD_ID, property_key: 'flowix_favorited', type: 'Boolean' });
  expect(builtinPresetTableField(NOTE_CREATED_AT_FIELD_ID)).toBeNull();
});
