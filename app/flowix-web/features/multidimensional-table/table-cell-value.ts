import type { TableField } from './model';

/** Convert editor-facing option ids into the labels stored in note frontmatter. */
export function persistedTableCellValue(field: TableField, value: unknown): unknown {
  if (field.type === 'Select') {
    return field.options?.find((option) => option.id === value)?.label ?? null;
  }
  if (field.type === 'MultiSelect' && Array.isArray(value)) {
    return value.map((id) => field.options?.find((option) => option.id === id)?.label ?? id);
  }
  return value;
}
