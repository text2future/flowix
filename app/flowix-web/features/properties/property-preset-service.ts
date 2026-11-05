import type { PropertyFieldConfig } from '@/lib/constants';
import { createLogger } from '@/lib/logger';
import { createPropertyId } from '@/lib/property-identity';
import { externalDocuments, collections, notebooks, notes } from '@platform/tauri/client';
import { usePropertyPresetStore, persistPropertyRegistry, savePropertyPreset } from './property-preset-store';
import { parseTableDocument, type MultidimensionalTableDocument, type TableField } from '@features/multidimensional-table/model';
import { bindTableField, comparablePropertyKey, presetFromTableField, samePresetDefinition, tableFieldFromPreset, hydrateTablePresets } from '@features/multidimensional-table/table-preset-bindings';
import { builtinPresetTableField } from '@features/multidimensional-table/builtin-fields';
import { joinNotebookMemoPath } from '@/lib/path';
import { canonicalizePropertyKey } from './property-key';
import { compareAndPatchDocumentProperties, removeDocumentProperty } from '@features/document/public/path-properties';
import type { NoteEntry } from '@platform/tauri/client';

const logger = createLogger('property-preset');

export interface PropertyKeyMigrationResult {
  moved: number;
  failed: number;
}

interface TableSnapshot { notebookId: string; path: string; content: string; document: MultidimensionalTableDocument }
async function allTables(): Promise<TableSnapshot[]> {
  const result: TableSnapshot[] = [];
  for (const notebook of await notebooks.getAll()) {
    for (const item of await collections.list(notebook.id, 'table')) {
      if (!item.collectionId || item.relativePath.endsWith('/.index.yaml') || item.relativePath === '.index.yaml') continue;
      const path = joinNotebookMemoPath(notebook.path, item.relativePath);
      if (!path) continue;
      const content = await externalDocuments.read(path, notebook.path);
      result.push({ notebookId: notebook.id, path, content, document: parseTableDocument(content) });
    }
  }
  return result;
}

export async function ensureTableFieldPreset(field: TableField): Promise<PropertyFieldConfig> {
  if (!usePropertyPresetStore.getState().loaded) await usePropertyPresetStore.getState().load();
  const registry = usePropertyPresetStore.getState().registry;
  const snapshot = presetFromTableField(field);
  const current = [...(registry.systemFields ?? []), ...registry.fields].find((item) => comparablePropertyKey(item.key) === comparablePropertyKey(snapshot.key));
  if (current) {
    if (!samePresetDefinition(current, snapshot)) throw new Error(`属性“${snapshot.key}”已有不同定义，请使用已有预设`);
    return current;
  }
  if (registry.deletedFields?.some((item) => item.id === snapshot.id)) snapshot.id = createPropertyId();
  await savePropertyPreset(snapshot, null);
  return usePropertyPresetStore.getState().registry.fields.find((item) => item.id === snapshot.id)!;
}

/** Import missing legacy definitions once; established definitions always come from DB.
 * A pending snapshot is an explicitly saved local edit, never an ordinary import.
 */
export async function bindTablePresetsFromSnapshot(document: MultidimensionalTableDocument): Promise<MultidimensionalTableDocument> {
  if (!usePropertyPresetStore.getState().loaded) {
    try { await usePropertyPresetStore.getState().load(); }
    catch (error) { logger.warn('预设数据库暂不可用，保留当前表格定义', { error }); return document; }
  }
  let next = document;
  for (const legacyId of document.dataset.schema.preset_fields) {
    const legacy = builtinPresetTableField(legacyId);
    if (!legacy) continue;
    const preset = usePropertyPresetStore.getState().registry.systemFields?.find((field) => field.key === legacy.property_key);
    if (!preset) continue;
    if (!next.dataset.schema.fields.some((field) => field.id === preset.id)) {
      next = { ...next, dataset: { ...next.dataset, schema: { ...next.dataset.schema,
        fields: [...next.dataset.schema.fields, { ...tableFieldFromPreset(preset), id: legacyId }],
      } } };
    }
    next = bindTableField(next, legacyId, preset);
    next = { ...next, dataset: { ...next.dataset, schema: { ...next.dataset.schema,
      preset_fields: next.dataset.schema.preset_fields.filter((id) => id !== preset.id),
    } } };
  }
  for (const field of [...next.dataset.schema.fields]) {
    if (field.type === 'primary' || !field.property_key) continue;
    const registry = usePropertyPresetStore.getState().registry;
    const retired = registry.deletedFields?.some((item) => item.id === field.id);
    if (retired) continue;
    const current = [...(registry.systemFields ?? []), ...registry.fields].find((item) => item.id === field.id)
      ?? [...(registry.systemFields ?? []), ...registry.fields].find((item) => comparablePropertyKey(item.key) === comparablePropertyKey(field.property_key!));
    if (!current) {
      try { await ensureTableFieldPreset(field); }
      catch (error) { logger.warn('当前表格字段已保留，预设注册待重试', { error }); }
    } else if (field.preset_pending && !samePresetDefinition(current, presetFromTableField(field))) {
      try { await updatePresetFromTable(field, presetFromTableField(field)); }
      catch (error) { logger.warn('保留当前表格修改，预设同步待重试', { error }); }
    }
  }
  return hydrateTablePresets(next);
}

/** Shared definition update. Current-table persistence is owned by its editor.
 * A user preset's key is its user-facing name, so renaming is allowed here;
 * system presets keep their fixed key and never rename.
 */
export async function updatePresetFromTable(field: TableField, next: PropertyFieldConfig): Promise<void> {
  const registry = usePropertyPresetStore.getState().registry;
  const current = [...(registry.systemFields ?? []), ...registry.fields].find((item) => item.id === field.id);
  if (!current) throw new Error('找不到此列关联的预设');
  if (registry.systemFields?.some((item) => item.id === field.id)) {
    const optionEditable = current.type === 'Select' || current.type === 'MultiSelect';
    if (next.key !== current.key || next.type !== current.type
      || (next.name !== undefined && next.name !== current.name)
      || (next.multiple !== undefined && next.multiple !== current.multiple)
      || (!optionEditable && JSON.stringify(next.options ?? []) !== JSON.stringify(current.options ?? []))) {
      throw new Error('系统预设只允许修改单选或多选选项');
    }
    await savePropertyPreset({
      ...current,
      options: optionEditable ? next.options : current.options,
    }, field.preset_revision ?? current.revision ?? 1);
    return;
  }
  await savePropertyPreset({ ...next, id: current.id }, field.preset_revision ?? current.revision ?? 1);
}

/** Move a property key across every note in every notebook. The target key must
 * be free; a note that already has it is left untouched and counted as failed.
 * `transform` can rewrite the moved value (used to migrate option labels).
 */
export async function migrateNotePropertyKey(
  previousKey: string,
  nextKey: string,
  transform?: (value: unknown) => { value: unknown; remove: boolean } | null,
): Promise<PropertyKeyMigrationResult> {
  const from = canonicalizePropertyKey(previousKey);
  const to = canonicalizePropertyKey(nextKey);
  let moved = 0;
  let failed = 0;
  if (!from || !to || from === to) return { moved, failed };
  for (const notebook of await notebooks.getAll()) {
    const entries = await notes.list(notebook.id);
    for (const note of entries) {
      if (!Object.prototype.hasOwnProperty.call(note.properties, from)) continue;
      if (Object.prototype.hasOwnProperty.call(note.properties, to)) { failed += 1; continue; }
      const path = joinNotebookMemoPath(notebook.path, note.relativePath);
      if (!path) { failed += 1; continue; }
      const previousValue = note.properties[from];
      const update = transform?.(previousValue) ?? null;
      try {
        const expected = {
          [from]: { exists: true, value: previousValue },
          [to]: { exists: false },
        };
        const next = update?.remove
          ? { [from]: { exists: false, value: undefined } }
          : {
              [from]: { exists: false, value: undefined },
              [to]: { exists: true, value: update ? update.value : previousValue },
            };
        const saved = await compareAndPatchDocumentProperties(path, expected, next);
        if (saved) moved += 1; else failed += 1;
      } catch {
        failed += 1;
      }
    }
  }
  return { moved, failed };
}

/** Retire the definition, then remove its property value and type metadata from every note. */
export async function deletePresetEverywhere(preset: PropertyFieldConfig): Promise<PropertyKeyMigrationResult> {
  const registry = usePropertyPresetStore.getState().registry;
  if (registry.systemFields?.some((field) => field.id === preset.id)) throw new Error('系统预设不能删除');
  await persistPropertyRegistry(registry.fields.filter((field) => field.id !== preset.id), [
    ...(registry.deletedFields ?? []).filter((field) => field.id !== preset.id), preset,
  ]);
  return removeNoteProperty(preset.key);
}

/** Delete a frontmatter property (value and its type declaration) from every note. */
export async function removeNoteProperty(key: string): Promise<PropertyKeyMigrationResult> {
  const propertyKey = canonicalizePropertyKey(key);
  let moved = 0;
  let failed = 0;
  if (!propertyKey) return { moved, failed };
  for (const notebook of await notebooks.getAll()) {
    let entries: NoteEntry[] = [];
    try { entries = await notes.list(notebook.id); } catch { failed += 1; continue; }
    for (const note of entries) {
      if (!Object.prototype.hasOwnProperty.call(note.properties, propertyKey)) continue;
      const path = joinNotebookMemoPath(notebook.path, note.relativePath);
      if (!path) { failed += 1; continue; }
      try {
        const saved = await removeDocumentProperty(path, propertyKey);
        if (saved) moved += 1; else failed += 1;
      } catch {
        failed += 1;
      }
    }
  }
  return { moved, failed };
}

export async function countPresetTableReferences(presetId: string): Promise<number> {
  return (await allTables()).filter(({ document }) => document.dataset.schema.fields.some((field) => field.id === presetId)).length;
}
