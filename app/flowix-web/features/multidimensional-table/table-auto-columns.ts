import { propertyImagePaths } from '@features/document/public/table-property-input-api';
import { canonicalizePropertyKey } from '@features/properties/public/property-key-api';
import type { I18nKey } from '@/lib/i18n';
import { displayTitleFromFilename } from '@/lib/utils';
import type { NoteEntry } from '@platform/tauri/client';

import {
  BUILTIN_TABLE_FIELDS,
  builtinPresetTableField,
  builtinPresetValue,
  builtinTableFieldValue,
  isBuiltinTableFieldId,
} from './builtin-fields';
import type { MultidimensionalTableDocument, TableRecord, TableView } from './model';
import { notePropertyEditorValue } from './table-note-properties';
import { fieldLabel } from './table-view-helpers';
import { visibleFieldIds } from './table-view-config';
import type { AutoColumnContent } from './use-auto-content-column-widths';

/**
 * 自动列宽的「内容采样」：把当前页每行每列的显示文本取出来，交给
 * `useAutoContentColumnWidths` 量宽。这里只做数据整形——不碰 DOM、不读 ref，
 * 所以从视图组件里搬出来后可以单独测，也让那个两千行的视图少一段重复的类型分派。
 */
export function computeAutoSizedColumns({
  document,
  activeView,
  columnSizingRecords,
  noteForRecord,
  notebookPath,
  propertyFields,
  conditionRecordIds,
  t,
}: {
  document: MultidimensionalTableDocument | null;
  activeView: TableView | undefined;
  columnSizingRecords: TableRecord[];
  noteForRecord: (record: TableRecord) => NoteEntry | undefined;
  notebookPath: string | null;
  propertyFields: Parameters<typeof fieldLabel>[1];
  conditionRecordIds: ReadonlySet<string>;
  t: (key: I18nKey) => string;
}): AutoColumnContent[] {
  if (!document || activeView?.layout !== 'table') return [];
  const visibleIds = visibleFieldIds(activeView);
  const fields = [
    ...document.dataset.schema.fields.filter((field) => visibleIds.includes(field.id)),
    ...BUILTIN_TABLE_FIELDS.filter((field) => visibleIds.includes(field.id)).flatMap((field) => {
      const preset = builtinPresetTableField(field.id);
      return [preset ?? { id: field.id, name: field.label, type: field.type, property_key: field.propertyKey ?? field.id }];
    }),
  ];
  return fields.flatMap<AutoColumnContent>((field) => {
    const label = fieldLabel(field, propertyFields, t);
    if (field.type === 'Tag') return [{
      id: field.id,
      label,
      type: 'tags' as const,
      isNoteTags: canonicalizePropertyKey(field.property_key ?? '') === 'tags',
      itemGapWidth: 4.8,
      values: columnSizingRecords.map((record) => {
        const note = noteForRecord(record);
        const value = builtinPresetTableField(field.id) ? builtinPresetValue(field.id, note) : notePropertyEditorValue(note, field);
        return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : [];
      }),
    }];
    if (field.type === 'primary') return [{
      id: field.id,
      label,
      type: 'primary' as const,
      textValues: columnSizingRecords.map((record) => {
        const note = noteForRecord(record);
        const text = note
          ? displayTitleFromFilename(note.relativePath)
          : !record.note_path ? '笔记不存在' : `未找到笔记 ${displayTitleFromFilename(record.note_path)}`;
        return { text, extraWidth: note ? 24 + (conditionRecordIds.has(record.id) ? 15 : 0) : 0 };
      }),
    }];
    if (field.type === 'Select' || field.type === 'MultiSelect') return [{
      id: field.id,
      label,
      type: 'chips' as const,
      extraWidth: 22,
      itemGapWidth: 4,
      values: columnSizingRecords.map((record) => {
        const note = noteForRecord(record);
        const value = builtinPresetTableField(field.id)
          ? builtinPresetValue(field.id, note)
          : notePropertyEditorValue(note, field);
        const optionLabel = (item: unknown) => field.options?.find((option) => option.id === item || option.label === item)?.label ?? String(item);
        if (field.type === 'Select') return value == null || value === '' ? [] : [optionLabel(value)];
        const selected = Array.isArray(value)
          ? value
          : typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
        return selected.map(optionLabel);
      }),
    }];
    return [{
      id: field.id,
      label,
      type: 'text' as const,
      textValues: columnSizingRecords.map((record) => {
        const note = noteForRecord(record);
        const builtinPreset = builtinPresetTableField(field.id);
        const value = builtinPreset
          ? builtinPresetValue(field.id, note)
          : isBuiltinTableFieldId(field.id)
            ? builtinTableFieldValue(field.id, note, notebookPath)
            : notePropertyEditorValue(note, field);
        if (field.type === 'Boolean') return { text: '', extraWidth: 16 };
        if (field.type === 'Icon') return { text: '', extraWidth: value ? 48 : 20 };
        if (field.type === 'Color') {
          const colors = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
          const count = colors.map(String).filter(Boolean).length;
          return { text: '', extraWidth: count ? count * 15 - 6 : 0 };
        }
        if (field.type === 'Image') {
          const hasImage = propertyImagePaths(value).length > 0;
          return { text: hasImage ? '' : 'Upload', extraWidth: hasImage ? 36 : 0 };
        }
        return {
          text: value == null ? '' : String(value),
          extraWidth: field.type === 'Number'
            ? isBuiltinTableFieldId(field.id) ? 0 : 24
            : field.type === 'Date' && value && !isBuiltinTableFieldId(field.id) ? 20 : 0,
        };
      }),
    }];
  });
}
