import { displayTitleFromFilename } from '@/lib/utils';
import type { TableField, TableRecord } from './model';
import { notePropertyEditorValue } from './table-note-properties';
import type { NoteEntry } from '@platform/tauri/client';

/** Formats a cell for non-editing views while keeping editor values typed. */
export function displayTableFieldValue(
  record: TableRecord,
  field: TableField,
  note: NoteEntry | undefined,
  notesLoadError: boolean,
): string {
  if (field.type === 'primary') {
    if (note) return note.title || displayTitleFromFilename(note.relativePath);
    if (!record.note_path) return '笔记不存在';
    return notesLoadError ? `无法确认关联：${record.note_path}` : `未找到笔记 ${displayTitleFromFilename(record.note_path)}`;
  }
  const value = notePropertyEditorValue(note, field);
  if (field.type === 'Select') return field.options?.find((option) => option.id === value)?.label
    ?? (value == null || value === '' ? '—' : String(value));
  if (field.type === 'MultiSelect') return Array.isArray(value)
    ? value.map((id) => field.options?.find((option) => option.id === id)?.label ?? id).join(', ')
    : '—';
  if (Array.isArray(value)) return value.map(String).join(', ');
  return value == null || value === '' ? '—' : String(value);
}
