import { usePropertyPresetStore } from '@features/properties/property-preset-store';
import type { PropertyFieldConfig } from '@/lib/constants';
import { isPresetPropertyKind } from '@/lib/property-types';
import { legacyPropertyId } from '@/lib/property-identity';
import type { MultidimensionalTableDocument, TableField } from './model';
import { BUILTIN_TABLE_FIELDS, builtinPresetTableField } from './builtin-fields';
import { canonicalizePropertyKey } from '@features/properties/property-key';

export const comparablePropertyKey = (key: string) => canonicalizePropertyKey(key).toLowerCase();

/**
 * 这张表的字段里是否已经有这个属性键：先按规范化 key 比对已有字段，
 * 再看对应的内置预设是否已在此表的 preset_fields 里登记。
 * 供「从预设选择」菜单置灰判断用，所以只吃 key，不认识 UI 侧的 PropertyPreset。
 */
export function tableFieldUsesPropertyKey(document: MultidimensionalTableDocument, presetKey: string): boolean {
  const propertyKey = canonicalizePropertyKey(presetKey).toLocaleLowerCase();
  if (document.dataset.schema.fields.some((field) => field.property_key
    && canonicalizePropertyKey(field.property_key).toLocaleLowerCase() === propertyKey)) return true;
  const builtin = BUILTIN_TABLE_FIELDS.find((field) => builtinPresetTableField(field.id)?.property_key === propertyKey);
  return Boolean(builtin && document.dataset.schema.preset_fields.includes(builtin.id));
}

export function presetFromTableField(field: TableField): PropertyFieldConfig {
  if (!field.property_key || !isPresetPropertyKind(field.type)) throw new Error('此字段不能转为用户预设');
  return {
    id: field.id, key: canonicalizePropertyKey(field.property_key),
    type: field.type, revision: field.preset_revision ?? 1,
    options: field.options?.map((option) => ({ ...option })),
    multiple: field.multiple,
  };
}

export function tableFieldFromPreset(preset: PropertyFieldConfig): TableField {
  return {
    id: preset.id ?? legacyPropertyId(preset.key), property_key: preset.key, type: preset.type,
    preset_revision: preset.revision ?? 1,
    ...((preset.type === 'Select' || preset.type === 'MultiSelect') && preset.options?.length ? {
      options: preset.options.map((option) => ({ ...option })),
    } : {}),
    ...(preset.type === 'Image' ? { multiple: preset.multiple !== false } : {}),
  };
}

function rewriteReferences(value: unknown, previous: string, next: string | null, parentKey = ''): unknown {
  if (Array.isArray(value)) return value.flatMap((item) => {
    if (['field_order', 'visible_fields', 'preset_fields'].includes(parentKey) && item === previous) return next === null ? [] : [next];
    if (item && typeof item === 'object' && ('field' in item || 'field_id' in item)
      && ((item as { field?: string }).field === previous || (item as { field_id?: string }).field_id === previous) && next === null) return [];
    return [rewriteReferences(item, previous, next, parentKey)];
  });
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (['field', 'field_id', 'group_by', 'date_field', 'title_field'].includes(key) && item === previous) {
      return next === null ? [] : [[key, next]];
    }
    if (key === 'value') return [[key, item]];
    return [[key, rewriteReferences(item, previous, next, key)]];
  }));
}

/** Keep primary/record identities and replace only attribute references. */
export function bindTableField(document: MultidimensionalTableDocument, oldId: string, preset: PropertyFieldConfig): MultidimensionalTableDocument {
  const nextId = preset.id ?? legacyPropertyId(preset.key);
  const next = rewriteReferences(document, oldId, nextId) as MultidimensionalTableDocument;
  return { ...next, dataset: { ...next.dataset, schema: { ...next.dataset.schema,
    fields: next.dataset.schema.fields.map((field) => field.id === oldId ? tableFieldFromPreset(preset) : field),
  } } };
}

/** Remove a deleted field while preserving secondary views so they can show their missing-field state. */
export function retireTablePreset(document: MultidimensionalTableDocument, preset: PropertyFieldConfig): MultidimensionalTableDocument {
  const ids = document.dataset.schema.fields.filter((field) => field.type !== 'primary' && field.id === preset.id).map((field) => field.id);
  let next = document;
  for (const id of ids) {
    const affectedViews = new Map(next.views.items.filter((view) =>
      view.config.group_by === id || view.config.date_field === id || view.config.title_field === id)
      .map((view) => [view.id, view.config]));
    next = rewriteReferences(next, id, null) as MultidimensionalTableDocument;
    next = rewriteReferences(next, preset.key, null) as MultidimensionalTableDocument;
    next = { ...next, dataset: { ...next.dataset, schema: { ...next.dataset.schema,
      fields: next.dataset.schema.fields.filter((field) => field.id !== id),
    } }, views: { ...next.views, items: next.views.items.map((view) => {
      const previousConfig = affectedViews.get(view.id);
      if (!previousConfig) return view;
      const config = { ...view.config };
      for (const key of ['group_by', 'date_field', 'title_field'] as const) {
        if (previousConfig[key] === id) config[key] = id;
      }
      return { ...view, config };
    }) } };
  }
  return next;
}

export function samePresetDefinition(left: PropertyFieldConfig, right: PropertyFieldConfig): boolean {
  return comparablePropertyKey(left.key) === comparablePropertyKey(right.key) && left.type === right.type
    && (left.multiple ?? true) === (right.multiple ?? true)
    && JSON.stringify(left.options ?? []) === JSON.stringify(right.options ?? []);
}

/** Derive active columns from DB without rewriting every table file. Pending local edits survive. */
export function hydrateTablePresets(document: MultidimensionalTableDocument): MultidimensionalTableDocument {
  const registry = usePropertyPresetStore.getState().registry;
  const presets = [...(registry.systemFields ?? []), ...registry.fields];
  let next = document;
  for (const retired of registry.deletedFields ?? []) next = retireTablePreset(next, retired);
  for (const field of [...next.dataset.schema.fields]) {
    if (field.type === 'primary') continue;
    const preset = presets.find((item) => item.id === field.id)
      ?? presets.find((item) => comparablePropertyKey(item.key) === comparablePropertyKey(field.property_key ?? ''));
    const systemPreset = registry.systemFields?.some((item) => item.id === preset?.id) ?? false;
    if (!preset || (field.preset_pending && !systemPreset && !samePresetDefinition(preset, presetFromTableField(field)))) continue;
    next = bindTableField(next, field.id, preset);
  }
  return JSON.stringify(next) === JSON.stringify(document) ? document : next;
}
