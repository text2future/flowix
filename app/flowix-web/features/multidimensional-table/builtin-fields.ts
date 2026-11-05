import { NOTE_CREATED_AT_FIELD_ID, NOTE_UPDATED_AT_FIELD_ID, NOTE_PATH_FIELD_ID, NOTE_SIZE_FIELD_ID, NOTE_FILTER_READONLY_FIELDS } from '@features/collection/public/note-filter-api';
export { NOTE_CREATED_AT_FIELD_ID, NOTE_UPDATED_AT_FIELD_ID, NOTE_PATH_FIELD_ID, NOTE_SIZE_FIELD_ID, NOTE_FILENAME_FIELD_ID } from '@features/collection/public/note-filter-api';
import type { NoteEntry } from '@platform/tauri/client';
import { BUILTIN_PRESETS } from '@features/document/properties/presets';
import type { TableField, TableFieldType } from './model';
import type { I18nKey } from '@/lib/i18n';
import { getPropertyTypeDefinition, type PropertyIconKind } from '@/lib/property-types';

export const NOTE_ICON_FIELD_ID = '__note_icon__';
export const NOTE_TAGS_FIELD_ID = '__note_tags__';
export const NOTE_COLORS_FIELD_ID = '__note_colors__';
const LEGACY_NOTE_TODOS_FIELD_ID = '__note_todos__';
export const NOTE_PINNED_FIELD_ID = '__note_pinned__';
export const NOTE_DESCRIPTION_FIELD_ID = '__note_description__';
export const NOTE_NAME_FIELD_ID = '__note_name__';

export const NOTE_STATUS_FIELD_ID = '__note_status__';
export const NOTE_CALENDAR_DATE_FIELD_ID = '__note_calendar_date__';

export interface BuiltinTableField {
  id: string;
  propertyKey?: string;
  label: string;
  type: TableFieldType;
  iconKind: PropertyIconKind;
  defaultInFolder: boolean;
}

type BuiltinPresetKey = (typeof BUILTIN_PRESETS)[number]['key'];
const PRESET_FIELD_IDS: Readonly<Record<BuiltinPresetKey, string>> = {
  name: NOTE_NAME_FIELD_ID,
  status: NOTE_STATUS_FIELD_ID,
  calendar_date: NOTE_CALENDAR_DATE_FIELD_ID,
  description: NOTE_DESCRIPTION_FIELD_ID,
  tags: NOTE_TAGS_FIELD_ID,
  flowix_colors: NOTE_COLORS_FIELD_ID,
  flowix_icon: NOTE_ICON_FIELD_ID,
  flowix_favorited: NOTE_PINNED_FIELD_ID,
};
const PRESET_FALLBACK_LABELS: Readonly<Record<BuiltinPresetKey, string>> = {
  name: '名称', description: '描述', tags: '标签', flowix_colors: '颜色', flowix_icon: '图标', flowix_favorited: '置顶',
  status: '状态', calendar_date: '日期',
};

export const BUILTIN_TABLE_FIELDS: readonly BuiltinTableField[] = [
  ...BUILTIN_PRESETS.flatMap((preset) => {
    const id = PRESET_FIELD_IDS[preset.key];
    if (!id) return [];
    return [{
      id,
      propertyKey: preset.key,
      label: PRESET_FALLBACK_LABELS[preset.key] ?? preset.key,
      type: preset.kind,
      iconKind: getPropertyTypeDefinition(preset.kind).iconKind,
      defaultInFolder: false,
    }];
  }),
  ...NOTE_FILTER_READONLY_FIELDS.map((field) => ({
    ...field,
    iconKind: getPropertyTypeDefinition(field.type).iconKind,
    defaultInFolder: field.id !== NOTE_SIZE_FIELD_ID,
  })),
];

export function isBuiltinTableFieldId(id: string): boolean {
  return id === LEGACY_NOTE_TODOS_FIELD_ID || BUILTIN_TABLE_FIELDS.some((field) => field.id === id);
}

export function builtinTableFieldLabel(field: BuiltinTableField, t: (key: I18nKey) => string): string {
  const preset = BUILTIN_PRESETS.find((item) => item.key === field.propertyKey);
  return preset ? t(preset.labelKey) : field.label;
}

export function builtinPresetTableField(id: string): TableField | null {
  const field = BUILTIN_TABLE_FIELDS.find((item) => item.id === id);
  return field?.propertyKey ? { id, property_key: field.propertyKey, type: field.type } : null;
}

/** Frontmatter includes pending local writes; index projections are the fallback. */
export function builtinPresetValue(id: string, note: NoteEntry | undefined): unknown {
  if (!note) return undefined;
  const key = BUILTIN_TABLE_FIELDS.find((field) => field.id === id)?.propertyKey;
  if (key && Object.prototype.hasOwnProperty.call(note.properties ?? {}, key)) return note.properties[key];
  if (id === NOTE_ICON_FIELD_ID) return note.icon;
  if (id === NOTE_TAGS_FIELD_ID) return note.tags;
  if (id === NOTE_COLORS_FIELD_ID) return note.colors;
  if (id === NOTE_PINNED_FIELD_ID) return note.favorited;
  return undefined;
}

function formatTimestamp(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(value) || !Number.isFinite(date.getTime())) return '—';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function builtinTableFieldValue(id: string, note: NoteEntry | undefined, _notebookPath: string | null): string {
  if (!note) return '';
  if (BUILTIN_TABLE_FIELDS.some((field) => field.id === id && field.propertyKey)) {
    const value = builtinPresetValue(id, note);
    return value == null ? '' : Array.isArray(value) ? value.join(', ') : String(value);
  }
  if (id === NOTE_CREATED_AT_FIELD_ID) return formatTimestamp(note.createdAt);
  if (id === NOTE_UPDATED_AT_FIELD_ID) return formatTimestamp(note.updatedAt);
  if (id === NOTE_SIZE_FIELD_ID) {
    const bytes = note.sizeBytes;
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1_000) return `${bytes} B`;
    if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(2)} KB`;
    return `${(bytes / 1_000_000).toFixed(2)} MB`;
  }
  if (id === NOTE_PATH_FIELD_ID) {
    return note.relativePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  }
  return '—';
}
