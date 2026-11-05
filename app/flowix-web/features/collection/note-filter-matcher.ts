import type { NoteEntry } from '@platform/tauri/client';
import { compileNoteFilter, type NoteFilterCondition, type NoteFilterField } from './note-filter';
import { matchesDatasetFilter, type DatasetFilter } from '@features/collection/rule-filter';
import { NOTE_CREATED_AT_FIELD_ID, NOTE_TITLE_FIELD_ID, NOTE_PATH_FIELD_ID, NOTE_SIZE_FIELD_ID, NOTE_UPDATED_AT_FIELD_ID } from './note-filter-fields';

function formatTimestamp(value: number | undefined): string | undefined {
  const date = new Date(value ?? NaN);
  if (!Number.isFinite(date.getTime())) return undefined;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Compare date properties by calendar day, including the timestamp fields shown as local dates. */
function calendarDay(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[ T])/.exec(text);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      return Math.floor(date.getTime() / 86_400_000);
    }
    return null;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 86_400_000) : null;
}

export function noteMatchesCollectionFilter(
  note: Pick<NoteEntry, 'title' | 'relativePath' | 'properties' | 'createdAt' | 'updatedAt' | 'sizeBytes'>,
  fields: NoteFilterField[],
  primaryFieldId: string,
  filter: Record<string, unknown>,
): boolean {
  const path = note.relativePath.replace(/\\/g, '/');
  const filename = path.split('/').pop() ?? path;
  const directory = path.split('/').slice(0, -1).join('/');
  const ruleMatches = (rule: { field: string; op: string; value: unknown }): boolean => {
    const field = rule.field;
    const operator = rule.op;
    const expected = rule.value;
    const configuredField = fields.find((item) => item.id === field || item.property_key === field);
    let actual: unknown;
    if (field === 'kind') actual = 'note';
    else if (field === 'file_name') actual = filename;
    else if (field === 'path') actual = directory;
    else if (field === primaryFieldId || field === NOTE_TITLE_FIELD_ID) actual = note.title;
    else if (field === NOTE_CREATED_AT_FIELD_ID) actual = formatTimestamp(note.createdAt);
    else if (field === NOTE_UPDATED_AT_FIELD_ID) actual = formatTimestamp(note.updatedAt);
    else if (field === NOTE_PATH_FIELD_ID) actual = directory;
    else if (field === NOTE_SIZE_FIELD_ID) actual = note.sizeBytes;
    else {
      actual = configuredField?.type === 'primary'
        ? note.title
        : configuredField?.property_key
          ? note.properties[configuredField.property_key]
          : note.properties[field];
    }
    const values = Array.isArray(actual) ? actual : [actual];
    if (operator === 'in' && Array.isArray(expected)) {
      return values.some((value) => expected.some((candidate) => value != null && String(value) === String(candidate)));
    }
    if (expected === null || typeof expected === 'object') return false;
    const isDateField = configuredField?.type === 'Date'
      || field === NOTE_CREATED_AT_FIELD_ID
      || field === NOTE_UPDATED_AT_FIELD_ID;
    const isNumberField = configuredField?.type === 'Number' || field === NOTE_SIZE_FIELD_ID;
    return values.some((value) => {
      if (value == null) return false;
      const normalized = String(value);
      const expectedText = String(expected);
      const matchesEquality = () => {
        if (normalized === expectedText) return true;
        if (typeof value === 'number' || field === NOTE_SIZE_FIELD_ID || configuredField?.type === 'Number') {
          const expectedNumber = expectedText.trim() ? Number(expectedText) : Number.NaN;
          const actualNumber = typeof value === 'number'
            ? value
            : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
          if (Number.isFinite(expectedNumber) && Number.isFinite(actualNumber)) return actualNumber === expectedNumber;
        }
        // Date pickers store a calendar date. Built-in creation/update fields
        // display timestamps, so equality should compare their calendar day.
        return (field === NOTE_CREATED_AT_FIELD_ID || field === NOTE_UPDATED_AT_FIELD_ID)
          && /^\d{4}-\d{2}-\d{2}$/.test(expectedText)
          && normalized.startsWith(`${expectedText} `);
      };
      if (operator === 'gt' || operator === 'lt') {
        // A legacy range operator on a field without a known ordered type is
        // interpreted as equality, matching the operator shown by the menu.
        if (!isDateField && !isNumberField) return matchesEquality();
        const comparison = isDateField
          ? (() => {
            const actualDay = calendarDay(value);
            const expectedDay = calendarDay(expected);
            return actualDay === null || expectedDay === null ? null : actualDay - expectedDay;
          })()
          : (() => {
            const actualNumber = finiteNumber(value);
            const expectedNumber = finiteNumber(expected);
            return actualNumber === null || expectedNumber === null ? null : actualNumber - expectedNumber;
          })();
        if (comparison === null) return false;
        return operator === 'gt' ? comparison > 0 : comparison < 0;
      }
      if (operator === 'eq' || operator === 'equals') return matchesEquality();
      if (operator !== 'contains') return false;
      if (typeof expected !== 'string') return false;
      if (field === 'path') {
        if (expected === '') return true;
        const prefix = expected.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase();
        const directory = normalized.toLocaleLowerCase();
        return directory === prefix || directory.startsWith(`${prefix}/`);
      }
      if (field === 'file_name') return normalized.toLocaleLowerCase().includes(expected.trim().toLocaleLowerCase());
      return normalized.includes(expected);
    });
  };
  return matchesDatasetFilter(filter as unknown as DatasetFilter, ruleMatches);
}

/** Compile once per list operation; metadata-only filtering never opens Markdown files. */
export function createNoteFilterMatcher(condition?: NoteFilterCondition | null, fields: NoteFilterField[] = []) {
  const filter = condition ? compileNoteFilter(condition) : null;
  return (note: Parameters<typeof noteMatchesCollectionFilter>[0]): boolean =>
    !filter || noteMatchesCollectionFilter(note, fields, '', filter);
}
