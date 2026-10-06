import { describe, expect, it } from 'vitest';

import type { PropertyFieldConfig } from '@/lib/constants';
import {
  getAllPresets,
  getCustomPresets,
  CUSTOM_PROPERTY_KINDS,
  isBuiltinPresetKey,
  PROPERTY_KINDS,
  resolvePropertyPreset,
} from './presets';
import {
  convertRowValue,
  rowsFromData,
} from '@features/document/components/note-properties/property-row-model';

const label = (key: string) => key;

describe('property preset runtime model', () => {
  const fields: PropertyFieldConfig[] = [
    { key: 'priority', type: 'Select', options: ['高', '低'] },
    { key: 'labels', type: 'MultiSelect', options: ['前端', '后端'] },
    { key: 'archived', type: 'Boolean' },
  ];

  it('exposes custom presets with the same shape as built-ins', () => {
    expect(getCustomPresets(fields)).toEqual([
      {
        source: 'custom',
        category: 'custom',
        key: 'priority',
        label: 'priority',
        kind: 'Select',
        options: ['高', '低'],
      },
      {
        source: 'custom',
        category: 'custom',
        key: 'labels',
        label: 'labels',
        kind: 'MultiSelect',
        options: ['前端', '后端'],
      },
      {
        source: 'custom',
        category: 'custom',
        key: 'archived',
        label: 'archived',
        kind: 'Boolean',
        options: undefined,
      },
    ]);
    expect(getAllPresets(fields, label).find((preset) => preset.key === 'priority'))
      .toMatchObject({ source: 'custom', label: 'priority', kind: 'Select' });
  });

  it('keeps built-in keys authoritative over conflicting custom settings', () => {
    expect(isBuiltinPresetKey('NAME')).toBe(true);
    expect(isBuiltinPresetKey('tag')).toBe(true);
    expect(getCustomPresets([
      { key: 'name', type: 'Text' },
      { key: 'TAG', type: 'Text' },
      { key: 'Priority', type: 'Number' },
      { key: 'priority', type: 'Text' },
    ])).toEqual([
      {
        source: 'custom',
        category: 'custom',
        key: 'Priority',
        label: 'Priority',
        kind: 'Number',
        options: undefined,
      },
    ]);
    expect(resolvePropertyPreset('name', [
      { key: 'name', type: 'Number' },
    ], label)).toMatchObject({ source: 'builtin', key: 'name' });
  });

  it('uses custom kind and options when materializing note rows', () => {
    const rows = rowsFromData(
      { priority: '高', labels: ['前端'], archived: true },
      new Map(fields.map((field) => [field.key, field])),
      label,
    );

    expect(rows.map((row) => [row.key, row.preset?.label, row.type])).toEqual([
      ['priority', 'priority', 'Select'],
      ['labels', 'labels', 'MultiSelect'],
      ['archived', 'archived', 'Boolean'],
    ]);
    expect(rows[0]?.preset?.options).toEqual(['高', '低']);
    expect(rows[1]?.preset?.options).toEqual(['前端', '后端']);
    expect(convertRowValue(rows[2]!)).toBe(true);
  });

  it('does not expose URL as a configurable custom type', () => {
    expect(PROPERTY_KINDS).not.toContain('URL');
    expect(PROPERTY_KINDS).toEqual([
      'Text', 'Boolean', 'Number', 'Date',
      'Select', 'MultiSelect', 'Tag', 'Tags', 'Color', 'Icon',
    ]);
    expect(CUSTOM_PROPERTY_KINDS).toEqual(['Text', 'Boolean', 'Number', 'Date', 'Tag']);
    expect(getAllPresets([], label).map((preset) => [preset.key, preset.kind])).toContainEqual(['tags', 'Tags']);
    expect(getAllPresets([], label).map((preset) => [preset.key, preset.kind])).toContainEqual(['flowix_colors', 'Color']);
  });

  it('ignores options for semantic tag and color presets', () => {
    expect(getCustomPresets([
      { key: 'topics', type: 'Tags', options: ['旧选项'] },
      { key: 'keywords', type: 'Tag', options: ['旧选项'] },
      { key: 'accent', type: 'Color', options: ['blue'] },
    ])).toEqual([
      {
        source: 'custom',
        category: 'custom',
        key: 'topics',
        label: 'topics',
        kind: 'Tags',
        options: undefined,
      },
      {
        source: 'custom',
        category: 'custom',
        key: 'keywords',
        label: 'keywords',
        kind: 'Tag',
        options: undefined,
      },
      {
        source: 'custom',
        category: 'custom',
        key: 'accent',
        label: 'accent',
        kind: 'Color',
        options: undefined,
      },
    ]);
  });
});
