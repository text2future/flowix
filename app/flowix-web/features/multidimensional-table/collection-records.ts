import type { NoteEntry } from '@platform/tauri/client';
import { noteMatchesCollectionFilter, type NoteFilterField } from '@features/collection/public/note-filter-api';
import type { MultidimensionalTableDocument, TableRecord, TableView } from './model';
import { isTableDatabaseNote, tableDatabaseFilter } from './table-database-filter';
import { legacyTableLocationFilter } from './table-legacy-location';
import { noteKeyForRecord } from './table-view-helpers';
import { applyTableView } from './view-records';

/**
 * Which notes a table holds. Two sources answer that question:
 *
 *   - `records.include` — the table links these explicitly;
 *   - a condition (auto-collect) or a legacy location — the table collects
 *     whatever note in the notebook matches.
 *
 * The second source is why a filter-driven collection has an empty `include`.
 * The table surface and the embedded-page data bridge must agree on it, so the
 * rule lives here once instead of inside the view component.
 */
export interface CollectionRecordOptions {
  document: MultidimensionalTableDocument;
  notes: NoteEntry[];
  /**
   * Fields a filter may address: the schema fields plus whatever preset fields
   * the surface exposes. Note built-ins (`__note_updated_at__`, …) are resolved
   * by the matcher itself and need not be listed.
   */
  filterFields: NoteFilterField[];
  /**
   * Stable id for a note the condition picked up. Surfaces that only read the
   * rows pass `() => ''`; the editor keeps ids across renders in a ref.
   */
  recordIdFor?: (notePath: string) => string;
}

/** Normalizes path separators once, the way every record key is compared. */
const slash = (path: string): string => path.replace(/\\/g, '/');

function noteLookup(notes: NoteEntry[]): (record: TableRecord) => NoteEntry | undefined {
  const byKey = new Map(notes.map((note) => [slash(note.relativePath), note]));
  return (record) => {
    const key = noteKeyForRecord(record);
    return key ? byKey.get(slash(key)) : undefined;
  };
}

/**
 * Notes collected by the table's condition, minus the ones it links or excludes
 * explicitly. Empty when the table collects nothing.
 */
export function collectionConditionRecords({
  document, notes, filterFields, recordIdFor,
}: CollectionRecordOptions): TableRecord[] {
  const primaryFieldId = document.dataset.schema.fields[0]?.id;
  if (!primaryFieldId) return [];
  const legacyFilter = legacyTableLocationFilter(document);
  const databaseFilter = tableDatabaseFilter(document);
  const linkedPaths = new Set(document.dataset.records.include.map((record) => slash(record.note_path)).filter(Boolean));
  const excludedPaths = new Set(document.dataset.records.exclude.map((record) => slash(record.note_path)));
  return notes.flatMap((note) => {
    const notePath = slash(note.relativePath);
    const matchesLegacy = legacyFilter
      && noteMatchesCollectionFilter(note, filterFields, primaryFieldId, legacyFilter);
    const matchesDatabase = databaseFilter
      && noteMatchesCollectionFilter(note, filterFields, primaryFieldId, tableDatabaseFilter(document, notePath)!);
    if (linkedPaths.has(notePath) || excludedPaths.has(notePath) || (!matchesLegacy && !matchesDatabase)) return [];
    return [{
      id: recordIdFor ? recordIdFor(notePath) : '',
      updated_at: new Date(note.updatedAt).toISOString(),
      note_path: notePath,
    }];
  });
}

/**
 * Every record of the table in stored order: explicit links first (re-checked
 * against the database filter, because a linked record can drift out of it),
 * then condition-derived ones.
 */
export function collectionDatasetRecords(
  options: CollectionRecordOptions & { conditionRecords?: TableRecord[] },
): TableRecord[] {
  const { document, notes, filterFields } = options;
  const conditionRecords = options.conditionRecords ?? collectionConditionRecords(options);
  const filter = tableDatabaseFilter(document);
  const primaryFieldId = document.dataset.schema.primary_field_id;
  const noteForRecord = noteLookup(notes);
  const explicit = document.dataset.records.include.filter((record) => {
    if (!filter || !isTableDatabaseNote(document, record.note_path)) return true;
    const note = noteForRecord(record);
    return !note
      || noteMatchesCollectionFilter(note, filterFields, primaryFieldId, tableDatabaseFilter(document, record.note_path)!);
  });
  return [...explicit, ...conditionRecords];
}

/**
 * The rows a reader actually sees: the collection's records with the active
 * view's filter and sort applied. Reading `dataset.records.include` directly
 * gives stored order, which is neither what the table shows nor what a
 * dashboard showing the same collection should show.
 */
export function collectionViewRecords(
  options: CollectionRecordOptions & { view?: TableView; records?: TableRecord[] },
): TableRecord[] {
  const records = options.records ?? collectionDatasetRecords(options);
  const { document, notes, view } = options;
  const fields = document.dataset.schema.fields;
  const primaryFieldId = document.dataset.schema.primary_field_id || fields[0]?.id || '';
  if (!view || !primaryFieldId) return records;
  return applyTableView(records, view, fields, primaryFieldId, noteLookup(notes));
}
