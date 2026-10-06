import type { NoteEntry } from '@platform/tauri/client';
import type { TableAutoCollectCondition, TableField } from './model';

const MARKDOWN_FILE_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx']);

function matchesAutoCollectFileType(type: string, extension: string): boolean {
  return type === 'markdown' && MARKDOWN_FILE_EXTENSIONS.has(extension);
}

export function noteMatchesAutoCollect(
  note: NoteEntry,
  fields: TableField[],
  primaryFieldId: string,
  condition: TableAutoCollectCondition,
): boolean {
  const propertyConditions = (condition.property_conditions ?? [])
    .map((item) => ({ ...item, field_id: item.field_id.trim(), value: item.value.trim() }))
    .filter((item) => item.field_id && item.value);
  const fileCondition = condition.file_condition;
  const filenameQuery = fileCondition?.file_name_contains?.trim().toLowerCase() ?? '';
  const typeQuery = fileCondition?.file_type?.trim().replace(/^\./, '').toLowerCase() ?? '';
  const pathQuery = fileCondition?.path_contains?.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase() ?? '';
  const hasFileCriteria = Boolean(filenameQuery || typeQuery || pathQuery);
  if (propertyConditions.length === 0 && !hasFileCriteria) return false;

  const normalizedPath = note.relativePath.replace(/\\/g, '/');
  const filename = normalizedPath.split('/').pop() ?? normalizedPath;
  const extensionStart = filename.lastIndexOf('.');
  const extension = extensionStart > 0 ? filename.slice(extensionStart + 1).toLowerCase() : '';
  const normalizedNotePath = normalizedPath.toLowerCase();
  const fileMatches = [
    Boolean(filenameQuery) && filename.toLowerCase().includes(filenameQuery),
    Boolean(typeQuery) && matchesAutoCollectFileType(typeQuery, extension),
    Boolean(pathQuery) && normalizedNotePath.startsWith(`${pathQuery}/`),
  ].some(Boolean);

  const matchesPropertyCondition = (propertyCondition: (typeof propertyConditions)[number]) => {
    const field = fields.find((item) => item.id === propertyCondition.field_id);
    const value = field?.id === primaryFieldId
      ? note.title
      : field?.property_key
        ? note.properties[field.property_key]
        : note.properties[propertyCondition.field_id];
    const values = Array.isArray(value) ? value : [value];
    return values.some((item) => {
      if (item == null) return false;
      const actual = String(item);
      return propertyCondition.operator === 'equals' ? actual === propertyCondition.value : actual.includes(propertyCondition.value);
    });
  };
  const propertyMatches = propertyConditions.length > 0 && (condition.property_match === 'intersection'
    ? propertyConditions.every(matchesPropertyCondition)
    : propertyConditions.some(matchesPropertyCondition));
  return propertyMatches || fileMatches;
}
