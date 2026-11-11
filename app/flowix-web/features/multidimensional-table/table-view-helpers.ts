import type { CollectionSource } from '@features/collection/model';
import { canonicalDirectoryPath, notebookRelativeDirectoryPath, parentDirectoryPath } from '@/lib/path';
import type { I18nKey } from '@/lib/i18n';
import { ADDABLE_TABLE_PROPERTY_KINDS, getPropertyTypeDefinition, type PropertyIconKind, type PropertyKind } from '@/lib/property-types';
import { resolvePropertyDisplayName } from '@features/document/properties/presets';
import type { usePropertyPresets } from '@features/properties/public-api';
import type { TableField, TableFieldType, TableRecord } from './model';

export const FIELD_TYPE_CHOICES: TableFieldType[] = ADDABLE_TABLE_PROPERTY_KINDS.filter((kind) => kind !== 'Note');

export const SCROLL_PAGE_SIZE = 50;
export const EMBEDDED_TABLE_PAGE_SIZE = 10;
export const EMBEDDED_GALLERY_PAGE_SIZE = 14;
export const TABLE_ACTION_COLUMN_MIN_WIDTH = 120;

// Default column widths are selected by type and applied through the colgroup.
export const TABLE_FIELD_WIDTHS: Record<TableFieldType, number> = {
  primary: 240,
  Text: 120,
  Boolean: 120,
  Number: 120,
  Date: 120,
  URL: 180,
  Select: 120,
  MultiSelect: 120,
  Tag: 120,
  Color: 120,
  Icon: 120,
  Image: 120,
};

export function noteInCollectionSource(
  notePath: string,
  source: CollectionSource | undefined,
  collectionFilePath: string,
  notebookPath: string | null,
): boolean {
  if (!notePath) return true;
  if (!source || source.scope === 'notebook') return true;
  let base = source.path ?? '';
  if (source.scope === 'containing_folder') {
    if (!notebookPath) return false;
    const root = canonicalDirectoryPath(notebookPath).replace(/\/$/, '');
    const parent = canonicalDirectoryPath(collectionFilePath.replace(/[\\/][^\\/]*$/, '')).replace(/\/$/, '');
    if (parent === root) base = '';
    else if (parent.startsWith(`${root}/`)) base = parent.slice(root.length + 1);
    else return false;
  }
  const normalized = notePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const prefix = base.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!prefix) return true;
  if (!normalized.startsWith(`${prefix}/`)) return false;
  return true;
}

/** Resolve the table YAML's folder as the second choice for notes created from its rows. */
export function resolveTableNoteParentRelativePath(filePath: string, notebookPath: string | null): string | undefined {
  if (!filePath || !notebookPath) return undefined;
  const notebookRoot = canonicalDirectoryPath(notebookPath);
  const tableDirectory = parentDirectoryPath(filePath, notebookRoot);
  const relativePath = notebookRelativeDirectoryPath(notebookRoot, tableDirectory);
  return relativePath ?? undefined;
}

export function fieldTypeLabel(type: PropertyKind | 'primary', t: (key: I18nKey) => string): string {
  return t(getPropertyTypeDefinition(type === 'primary' ? 'Note' : type).labelKey);
}

export function fieldTypeIconKind(type: TableFieldType): PropertyIconKind {
  return type === 'primary' ? 'note' : getPropertyTypeDefinition(type).iconKind;
}

export function fieldLabel(
  field: TableField,
  propertyFields: ReturnType<typeof usePropertyPresets>['fields'],
  t: (key: I18nKey) => string,
): string {
  if (field.type === 'primary') return '笔记名称';
  // A user preset's key IS its display name; only system presets resolve a
  // separate localized label.
  return resolvePropertyDisplayName(field.property_key ?? '', propertyFields, t);
}

export function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function calendarDateKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/.exec(value)?.[1] ?? null;
}

export function calendarDateTimeForTimestamp(timestamp: number | undefined): string | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return `${isoDate(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function noteKeyForRecord(record: TableRecord): string {
  return record.note_path;
}

export function upsertTableRecord(records: TableRecord[], nextRecord: TableRecord): TableRecord[] {
  if (!records.some((record) => record.id === nextRecord.id)) return [...records, nextRecord];
  return records.map((record) => record.id === nextRecord.id ? nextRecord : record);
}
