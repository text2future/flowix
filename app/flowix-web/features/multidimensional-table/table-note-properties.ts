import type { NoteEntry } from '@platform/tauri/client';
import type { PropertyFieldConfig } from '@/lib/constants';
import { PROPERTY_URL_RE } from '@features/document/properties/property-type';
import { PROPERTY_TYPES_KEY, readPropertyTypes } from '@features/document/properties/property-type-metadata';
import { resolvePropertyPreset } from '@features/document/properties/presets';
import type { TableField, TableFieldType, TableFieldOption } from './model';
import { NOTE_CREATED_AT_FIELD_ID, NOTE_UPDATED_AT_FIELD_ID } from './builtin-fields';
import { migratedOptionValue } from './table-field-migration';

export function valueMatchesFieldType(value: unknown, type: TableFieldType, options: TableField['options'] = [], _multiple = false): boolean {
  if (value == null || value === '') return true;
  switch (type) {
    case 'primary': case 'Text': case 'Icon': return typeof value === 'string';
    case 'URL': return typeof value === 'string' && PROPERTY_URL_RE.test(value);
    case 'Boolean': return typeof value === 'boolean';
    case 'Number': return typeof value === 'number' && Number.isFinite(value);
    case 'Date': return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    case 'Select': return typeof value === 'string' && options.some((option) => option.id === value || option.label === value);
    case 'MultiSelect': return Array.isArray(value) && value.every((item) => typeof item === 'string' && options.some((option) => option.id === item || option.label === item));
    case 'Tag': case 'Color': return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'Image': return typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
  }
  return false;
}

/** Rename the value and its type declaration together. */
export function renameNoteProperty(
  note: NoteEntry,
  previousKey: string,
  nextKey: string,
  field: TableField,
  nextOptions: TableFieldOption[] | undefined,
  propertyFields: readonly PropertyFieldConfig[],
): NoteEntry {
  if (!Object.prototype.hasOwnProperty.call(note.properties, previousKey)) return note;
  const previousValue = note.properties[previousKey];
  const update = nextOptions ? migratedOptionValue(field, nextOptions, previousValue) : null;
  const properties = { ...note.properties };
  delete properties[previousKey];
  if (!update || !update.remove) properties[nextKey] = update ? update.value : previousValue;
  const types = readPropertyTypes(properties[PROPERTY_TYPES_KEY]);
  if (Object.prototype.hasOwnProperty.call(types, previousKey)) {
    types[nextKey] = types[previousKey];
    delete types[previousKey];
  }
  if (update?.remove || resolvePropertyPreset(nextKey, propertyFields)) delete types[nextKey];
  else if (field.type !== 'primary') types[nextKey] = field.type;
  if (Object.keys(types).length) properties[PROPERTY_TYPES_KEY] = types;
  else delete properties[PROPERTY_TYPES_KEY];
  return { ...note, properties };
}

export function notePropertyEditorValue(note: NoteEntry | undefined, field: TableField): unknown {
  if (field.type === 'primary') return note?.relativePath ?? null;
  const propertyKey = field.property_key ?? '';
  const value = note && Object.prototype.hasOwnProperty.call(note.properties, propertyKey)
    ? note.properties[propertyKey]
    : null;
  if (field.type === 'Select') {
    return field.options?.find((option) => option.label === value)?.id
      ?? field.options?.find((option) => option.id === value)?.id
      ?? value
      ?? '';
  }
  if (field.type === 'MultiSelect' && Array.isArray(value)) {
    return value.map((entry) => field.options?.find((option) => option.label === entry)?.id
      ?? field.options?.find((option) => option.id === entry)?.id
      ?? String(entry));
  }
  return value;
}

export function calendarCreatePropertyValue(field: TableField, value: unknown): { include: boolean; value: unknown } {
  if (field.type === 'Boolean') return { include: true, value: Boolean(value) };
  if (field.type === 'Number') {
    const number = typeof value === 'number' ? value : Number(String(value ?? '').trim());
    return { include: Number.isFinite(number) && String(value ?? '').trim() !== '', value: number };
  }
  if (field.type === 'Select') {
    const option = field.options?.find((item) => item.id === value);
    return { include: Boolean(option), value: option?.label ?? null };
  }
  if (field.type === 'MultiSelect') {
    const ids = Array.isArray(value) ? value.map(String) : [];
    const labels = ids.map((id) => field.options?.find((item) => item.id === id)?.label ?? id);
    return { include: labels.length > 0, value: labels };
  }
  if (field.type === 'Tag' || field.type === 'Color' || field.type === 'Image') {
    const values = Array.isArray(value) ? value.map(String) : field.type === 'Image' ? [String(value ?? '')] : String(value ?? '').split(',');
    const normalized = values.map((item) => item.trim()).filter(Boolean);
    return { include: normalized.length > 0, value: normalized };
  }
  const normalized = String(value ?? '').trim();
  return { include: Boolean(normalized), value: normalized || null };
}

export function isCalendarCreateWritableField(field: TableField): boolean {
  return field.type !== 'primary'
    && Boolean(field.property_key)
    && field.id !== NOTE_CREATED_AT_FIELD_ID
    && field.id !== NOTE_UPDATED_AT_FIELD_ID;
}
