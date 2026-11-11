import { tableAutoCollectConfig, tableAutoCollectFilter, type MultidimensionalTableDocument } from './model';
import { tableNoteDirectory } from './table-note-directory';

/** The saved location is legacy-only; current note criteria apply to this table's database. */
export function tableDatabaseFilter(document: MultidimensionalTableDocument, relativePath?: string): Record<string, unknown> | null {
  const condition = tableAutoCollectConfig(document)?.condition;
  if (!condition) return null;
  const criteria = tableAutoCollectFilter({ ...condition, path: null });
  if (!criteria.conditions.length) return null;
  const legacyPath = `database/${document.collection.id}`;
  const path = relativePath?.replace(/\\/g, '/').startsWith(`${legacyPath}/`) ? legacyPath : tableNoteDirectory(document.collection.id);
  return { ...criteria, path };
}

export function isTableDatabaseNote(document: MultidimensionalTableDocument, relativePath: string): boolean {
  const path = relativePath.replace(/\\/g, '/');
  return path.startsWith(`${tableNoteDirectory(document.collection.id)}/`) || path.startsWith(`database/${document.collection.id}/`);
}
