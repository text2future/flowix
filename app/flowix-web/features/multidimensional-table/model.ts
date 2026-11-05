import type { PropertyFieldConfig } from '@/lib/constants';
import { createCollectionMetadata, createUuidV7, parseCollectionDocumentV2, serializeCollectionDocumentV2, validateCollectionMetadata, reviseCollection, hasOnlyKeys, isRecord, type CollectionMetadata, type CollectionSource } from '@features/collection/model';
export { createUuidV7 } from '@features/collection/model';
import { isTablePropertyKind } from '@/lib/property-types';
import { normalizeCollectionLocation } from '@features/collection/public/dataset-filter-api';
import { TAG_COLUMN_MIN_WIDTH, TAG_COLUMN_MAX_WIDTH } from './tag-column-width';

import { NOTE_CREATED_AT_FIELD_ID, NOTE_UPDATED_AT_FIELD_ID, NOTE_CALENDAR_DATE_FIELD_ID, NOTE_TAGS_FIELD_ID, NOTE_ICON_FIELD_ID, NOTE_STATUS_FIELD_ID, BUILTIN_TABLE_FIELDS, builtinPresetTableField, isBuiltinTableFieldId } from './builtin-fields';
export { NOTE_CREATED_AT_FIELD_ID, NOTE_UPDATED_AT_FIELD_ID } from './builtin-fields';

export interface TableFieldOption {
  id: string;
  label: string;
}

export type {
  NoteFilterFieldType as TableFieldType,
  NoteFilterCondition as TableAutoCollectCondition,
  NoteFilterPropertyCondition as TableAutoCollectPropertyCondition,
  NoteFilterFileCondition as TableAutoCollectFileCondition,
  NoteFilterFileType as TableAutoCollectFileType,
  NoteFilterConfig as TableAutoCollectConfig,
} from '@features/collection/public/note-filter-api';
import type {
  NoteFilterFieldType as TableFieldType,
  NoteFilterCondition as TableAutoCollectCondition,
  NoteFilterPropertyCondition as TableAutoCollectPropertyCondition,
  NoteFilterFileCondition as TableAutoCollectFileCondition,
  NoteFilterConfig as TableAutoCollectConfig,
} from '@features/collection/public/note-filter-api';
import { compileNoteFilter } from '@features/collection/public/note-filter-api';

export interface TableField {
  id: string;
  /** Portable definition snapshot version; the user preset owns this ID. */
  preset_revision?: number;
  /** A local edit saved before its shared definition could be synchronized. */
  preset_pending?: boolean;
  type: TableFieldType;
  name?: string;
  /** Frontmatter property key shared by every view. */
  property_key?: string;
  options?: TableFieldOption[];
  multiple?: boolean;
}

export interface TableView {
  id: string;
  name: string;
  layout: TableViewType;
  filter: Record<string, unknown>;
  sort: Array<{ field: string; direction: 'asc' | 'desc' }>;
  config: Record<string, unknown>;
}

export type TableViewType = 'table' | 'kanban' | 'calendar' | 'gallery';

const VIEW_NAMES: Record<TableViewType, string> = {
  table: '表格', kanban: '看板', calendar: '日历', gallery: '画廊',
};

export interface TableRecord {
  id: string;
  updated_at: string;
  /** Notebook-relative note reference. Property values live in note frontmatter. */
  note_path: string;
}

export interface MultidimensionalTableDocument {
  collection: CollectionMetadata;
  dataset: {
    source: CollectionSource;
    schema: { primary_field_id: string; fields: TableField[]; field_order: string[]; preset_fields: string[]; deleted_presets?: Array<Omit<PropertyFieldConfig, 'options'> & { options?: string[]; optionIds?: string[] }> };
    records: { include: TableRecord[]; exclude: Array<{ note_path: string }> };
    filter: Record<string, unknown> | null;
  };
  /** default_id remembers the last explicitly opened view in this file. */
  views: { default_id: string; items: TableView[] };
}

export function tableAutoCollectConfig(document: MultidimensionalTableDocument): TableAutoCollectConfig | null {
  const filter = document.dataset.filter;
  if (!filter) return document.dataset.source.scope === 'folder'
    ? { condition: { path: document.dataset.source.path, match: 'all' } } : null;
  if (Array.isArray(filter.conditions) && (filter.match === 'all' || filter.match === 'any')) {
    const path = typeof filter.path === 'string' ? filter.path : null;
    return { condition: tableConditionFromRules(filter.conditions as Record<string, unknown>[], filter.match, path) };
  }
  const all = Array.isArray(filter.all) ? filter.all as Record<string, unknown>[] : [];
  const any = Array.isArray(filter.any) ? filter.any as Record<string, unknown>[] : [];
  const allPaths = all.filter((rule) => rule.field === 'path');
  const anyPaths = any.filter((rule) => rule.field === 'path');
  const path = pathFromLegacyRules([...allPaths, ...anyPaths]) ?? null;
  const nonPathAll = all.filter((rule) => rule.field !== 'path');
  const nonPathAny = any.filter((rule) => rule.field !== 'path');
  const grouped = nonPathAny.find((rule) => Array.isArray(rule.all));
  const chosenRules = nonPathAny.length
    ? grouped && nonPathAny.length === 1 ? grouped.all as Record<string, unknown>[] : nonPathAny
    : nonPathAll;
  const match = nonPathAny.length && !grouped ? 'any' : 'all';
  return { condition: tableConditionFromRules(chosenRules, match, path) };
}

function tableConditionFromRules(rules: Record<string, unknown>[], match: 'all' | 'any', path: string | null): TableAutoCollectCondition {
  const property_conditions = rules.flatMap((rule) => {
    if (typeof rule.field !== 'string' || ['kind', 'file_name', 'path'].includes(rule.field) || typeof rule.value !== 'string'
      || !['eq', 'equals', 'contains', 'gt', 'lt'].includes(String(rule.op))) return [];
    const operator: TableAutoCollectPropertyCondition['operator'] = rule.op === 'contains' ? 'contains'
      : rule.op === 'gt' || rule.op === 'lt' ? rule.op
        : 'equals';
    return [{ field_id: rule.field, operator, value: rule.value }];
  });
  const file_condition: TableAutoCollectFileCondition = {};
  for (const rule of rules) {
    if (rule.field === 'file_name' && rule.op === 'contains' && typeof rule.value === 'string') file_condition.file_name_contains = rule.value;
    if (rule.field === 'kind' && rule.op === 'eq' && rule.value === 'note') file_condition.file_type = 'markdown';
  }
  return {
    match,
    path,
    ...(property_conditions.length ? { property_conditions } : {}),
    ...(Object.keys(file_condition).length ? { file_condition } : {}),
  };
}

export function withTableAutoCollect(document: MultidimensionalTableDocument, config: TableAutoCollectConfig | null): MultidimensionalTableDocument {
  const next = { ...document, dataset: { ...document.dataset, filter: config ? tableAutoCollectFilter(config.condition) : null } };
  return normalizeCollectionLocation(next, true);
}

export const tableAutoCollectFilter = compileNoteFilter;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value).map(([key, entry]) => {
    const normalized = key === 'op' && entry === 'equals' ? 'eq' : stableValue(entry);
    // Sorting preserves duplicate counts while ignoring conjunction/disjunction order.
    if (key === 'conditions' && Array.isArray(normalized)) {
      normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }
    return [key, normalized] as const;
  });
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

/** The compact auto-collect form can edit only filters it can round-trip exactly. */
export function canEditTableAutoCollectFilter(document: MultidimensionalTableDocument): boolean {
  if (document.dataset.filter == null) return true;
  const filter = document.dataset.filter;
  if (!Array.isArray(filter.conditions)) return isEditableLegacyTableFilter(filter);
  const supported = (filter.conditions as Record<string, unknown>[]).every((rule) => (
    typeof rule.field === 'string' && typeof rule.value === 'string'
      && ((rule.field === 'kind' && rule.op === 'eq' && rule.value === 'note')
        || (rule.field === 'file_name' && rule.op === 'contains')
        || (!['path', 'kind', 'file_name'].includes(rule.field) && ['eq', 'equals', 'contains', 'gt', 'lt'].includes(String(rule.op))))
  ));
  if (!supported) return false;
  const roundTripped = withTableAutoCollect(document, tableAutoCollectConfig(document)).dataset.filter;
  return JSON.stringify(stableValue(document.dataset.filter)) === JSON.stringify(stableValue(roundTripped));
}

function isEditableLegacyTableFilter(filter: Record<string, unknown>): boolean {
  const all = Array.isArray(filter.all) ? filter.all as Record<string, unknown>[] : [];
  const any = Array.isArray(filter.any) ? filter.any as Record<string, unknown>[] : [];
  const allPaths = all.filter((rule) => rule.field === 'path');
  const anyPaths = any.filter((rule) => rule.field === 'path');
  // Path rules inside an OR branch cannot generally become the mandatory path.
  if (anyPaths.length || pathFromLegacyRules(allPaths) === undefined) return false;
  const allRules = all.filter((rule) => rule.field !== 'path');
  const anyRules = any.filter((rule) => rule.field !== 'path');
  const isLeaf = (rule: Record<string, unknown>) => typeof rule.field === 'string' && typeof rule.value === 'string'
    && ((rule.field === 'kind' && rule.op === 'eq' && rule.value === 'note')
      || (rule.field === 'file_name' && rule.op === 'contains')
      || (!['path', 'kind', 'file_name'].includes(rule.field) && ['eq', 'equals', 'contains', 'gt', 'lt'].includes(String(rule.op))));
  if (allRules.length && anyRules.length) return false;
  const hasDuplicateFileRules = (rules: Record<string, unknown>[]) => ['file_name', 'kind'].some((field) => rules.filter((rule) => rule.field === field).length > 1);
  if (anyRules.length === 1 && Array.isArray(anyRules[0].all)) {
    const group = anyRules[0];
    return Array.isArray(group.any) && group.any.length === 0 && !hasDuplicateFileRules(group.all as Record<string, unknown>[]) && (group.all as unknown[]).every((rule) => isRecord(rule) && isLeaf(rule as Record<string, unknown>));
  }
  return !hasDuplicateFileRules([...allRules, ...anyRules]) && [...allRules, ...anyRules].every(isLeaf);
}

function pathFromLegacyRules(rules: Record<string, unknown>[]): string | null | undefined {
  if (rules.some((rule) => rule.op !== 'contains' || typeof rule.value !== 'string')) return rules.length ? undefined : null;
  const paths = [...new Set(rules.map((rule) => String(rule.value).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')))];
  const nonEmpty = paths.filter(Boolean);
  if (nonEmpty.some((path) => nonEmpty.some((other) => path !== other
    && !path.startsWith(`${other}/`) && !other.startsWith(`${path}/`)))) return undefined;
  return nonEmpty.sort((left, right) => right.length - left.length)[0] ?? (rules.length ? '' : null);
}

function completeFieldOrder(
  primaryId: string,
  fields: TableField[],
  presetFields: string[],
  preferredOrder: string[] = [],
): string[] {
  const addedPresets = new Set(presetFields);
  const availableIds = [
    ...fields.map((field) => field.id),
    ...BUILTIN_TABLE_FIELDS.filter((field) => !builtinPresetTableField(field.id) || addedPresets.has(field.id)).map((field) => field.id),
  ];
  return [primaryId, ...new Set([...preferredOrder, ...availableIds].filter((id) => id !== primaryId && availableIds.includes(id)))];
}

export function createTableView(document: MultidimensionalTableDocument, type: TableViewType, fieldId?: string): TableView {
  const fields = document.dataset.schema.fields;
  const field = fields.find((item) => item.id === fieldId);
  if (type === 'kanban' && field?.type !== 'Select') throw new Error('看板需要单选属性');
  if (type === 'calendar' && fieldId && fieldId !== NOTE_CREATED_AT_FIELD_ID && fieldId !== NOTE_UPDATED_AT_FIELD_ID && fieldId !== NOTE_CALENDAR_DATE_FIELD_ID && field?.type !== 'Date') {
    throw new Error('日历需要日期属性');
  }
  const baseName = VIEW_NAMES[type];
  const names = new Set(document.views.items.map((view) => view.name));
  let name = baseName;
  for (let suffix = 2; names.has(name); suffix += 1) name = `${baseName} ${suffix}`;
  const config = type === 'table'
    ? { visible_fields: [
      ...fields.map((item) => item.id),
      ...(document.collection.placement === 'folder'
        ? BUILTIN_TABLE_FIELDS.filter((item) => item.defaultInFolder).map((item) => item.id)
        : []),
    ] }
    : type === 'gallery'
      ? { visible_fields: fields.filter((item) => item.type !== 'primary').map((item) => item.id) }
      : type === 'calendar'
        ? { date_field: fieldId ?? NOTE_CREATED_AT_FIELD_ID, title_field: document.dataset.schema.primary_field_id }
        : { group_by: fieldId };
  return { id: `view_${createUuidV7()}`, name, layout: type, filter: { all: [], any: [] }, sort: [{ field: 'modified_at', direction: 'desc' }], config };
}

export function addTableView(document: MultidimensionalTableDocument, type: TableViewType, fieldId?: string): { document: MultidimensionalTableDocument; view: TableView } {
  const view = createTableView(document, type, fieldId);
  return {
    view,
    document: {
      ...document,
      collection: reviseCollection(document.collection),
      views: { ...document.views, default_id: view.id, items: [...document.views.items, view] },
    },
  };
}

/** Adds a shared note property only when the user explicitly chooses to create one. */
export function findKanbanStatusField(document: MultidimensionalTableDocument): TableField | undefined {
  return document.dataset.schema.fields.find((field) => field.property_key?.trim().toLocaleLowerCase() === 'status');
}

export function addKanbanField(document: MultidimensionalTableDocument): { document: MultidimensionalTableDocument; field: TableField } {
  const statusKeyField = findKanbanStatusField(document);
  if (statusKeyField && statusKeyField.type !== 'Select') throw new Error('系统预设字段 status 已存在，但不是单选类型');
  const existing = statusKeyField;
  const field: TableField = existing ?? {
    id: `fld_${createUuidV7()}`,
    type: 'Select',
    property_key: 'status',
    options: ['未开始', '进行中', '完成'].map((label) => ({ id: `opt_${createUuidV7()}`, label })),
  };
  const fields = existing ? document.dataset.schema.fields : [...document.dataset.schema.fields, field];
  const presetFields = document.dataset.schema.preset_fields.filter((id) => id !== NOTE_STATUS_FIELD_ID);
  const fieldOrder = [...new Set([
    ...document.dataset.schema.field_order.filter((id) => id !== NOTE_STATUS_FIELD_ID),
    field.id,
  ])];
  return {
    field,
    document: {
      ...document,
      dataset: { ...document.dataset, schema: {
        ...document.dataset.schema,
        fields,
        preset_fields: presetFields,
        field_order: fieldOrder,
      } },
      views: { ...document.views, items: document.views.items.map((view) => view.layout === 'table'
        ? { ...view, config: { ...view.config, visible_fields: [...new Set([
          ...(view.config.visible_fields as string[]).filter((id) => id !== NOTE_STATUS_FIELD_ID),
          field.id,
        ])] } }
        : view) },
    },
  };
}

/** Add a status field when needed, then create a kanban view grouped by it. */
function createKanbanViewDocument(document: MultidimensionalTableDocument): { document: MultidimensionalTableDocument; view: TableView; field: TableField } {
  const { document: withStatus, field } = addKanbanField(document);
  const view = createTableView(withStatus, 'kanban', field.id);
  return {
    field,
    view,
    document: { ...withStatus, views: { ...withStatus.views, default_id: view.id, items: [...withStatus.views.items, view] } },
  };
}

export function addKanbanView(document: MultidimensionalTableDocument): { document: MultidimensionalTableDocument; view: TableView; field: TableField } {
  const created = createKanbanViewDocument(document);
  return {
    ...created,
    document: { ...created.document, collection: reviseCollection(document.collection) },
  };
}

/** Adds the calendar date preset and creates a calendar view that uses it. */
export function addCalendarDateView(document: MultidimensionalTableDocument): { document: MultidimensionalTableDocument; view: TableView } {
  const existing = document.dataset.schema.fields.find((field) => field.property_key?.trim().toLowerCase() === 'calendar_date');
  if (existing && existing.type !== 'Date') throw new Error('日期属性已存在，但不是日期类型');
  if (existing) return addTableView(document, 'calendar', existing.id);
  const presetFields = document.dataset.schema.preset_fields.includes(NOTE_CALENDAR_DATE_FIELD_ID)
    ? document.dataset.schema.preset_fields
    : [...document.dataset.schema.preset_fields, NOTE_CALENDAR_DATE_FIELD_ID];
  const withCalendarDate: MultidimensionalTableDocument = {
    ...document,
    collection: reviseCollection(document.collection),
    dataset: { ...document.dataset, schema: {
      ...document.dataset.schema,
      preset_fields: presetFields,
      field_order: completeFieldOrder(document.dataset.schema.primary_field_id, document.dataset.schema.fields, presetFields, document.dataset.schema.field_order),
    } },
  };
  const view = createTableView(withCalendarDate, 'calendar', NOTE_CALENDAR_DATE_FIELD_ID);
  return {
    view,
    document: { ...withCalendarDate, views: { ...withCalendarDate.views, default_id: view.id, items: [...withCalendarDate.views.items, view] } },
  };
}

export function createTableDocument(initialViewType: TableViewType = 'table', name = '多维表格', placement: CollectionMetadata['placement'] = 'standalone'): MultidimensionalTableDocument {
  const noteFieldId = `fld_${createUuidV7()}`;
  let document: MultidimensionalTableDocument = {
    collection: { ...createCollectionMetadata('table', name), placement },
    dataset: { source: { scope: 'notebook' },
      schema: {
        primary_field_id: noteFieldId,
        fields: [{ id: noteFieldId, type: 'primary', property_key: 'note' }],
        preset_fields: [NOTE_TAGS_FIELD_ID, NOTE_ICON_FIELD_ID, ...(initialViewType === 'calendar' ? [NOTE_CALENDAR_DATE_FIELD_ID] : [])],
        field_order: [],
      },
      records: { include: [], exclude: [] }, filter: null },
    views: { default_id: '', items: [] },
  };
  const fieldId = initialViewType === 'calendar' ? NOTE_CALENDAR_DATE_FIELD_ID : undefined;
  document.dataset.schema.field_order = completeFieldOrder(
    document.dataset.schema.primary_field_id,
    document.dataset.schema.fields,
    document.dataset.schema.preset_fields,
  );
  if (initialViewType === 'kanban') {
    const created = createKanbanViewDocument(document);
    document = { ...created.document, views: { ...created.document.views, default_id: created.view.id } };
  } else {
    const view = createTableView(document, initialViewType, fieldId);
    document.views = { default_id: view.id, items: [view] };
  }
  return document;
}

export function parseTableDocument(source: string): MultidimensionalTableDocument {
  const parsed = parseCollectionDocumentV2(source, 'table');
  const document = normalizeCollectionLocation(validateTableDocument({ collection: parsed.collection, dataset: parsed.payload.dataset, views: parsed.payload.views }), true);
  const removedTodoId = '__note_todos__';
  document.dataset.schema.field_order = document.dataset.schema.field_order.filter((id) => id !== removedTodoId);
  for (const view of document.views.items) {
    if (view.layout === 'table' || view.layout === 'gallery') {
      view.config.visible_fields = (view.config.visible_fields as string[]).filter((id) => id !== removedTodoId);
    }
    view.sort = (view.sort ?? []).filter((sort) => sort.field !== removedTodoId);
  }
  return document;
}

export function validateTableDocument(parsed: unknown): MultidimensionalTableDocument {
  if (!parsed || typeof parsed !== 'object') throw new Error('表格文件必须是 YAML 对象');
  const value = parsed as Partial<MultidimensionalTableDocument>;
  validateCollectionMetadata(value.collection, 'table');
  if (!value.dataset || !Array.isArray(value.dataset.schema?.fields)
      || !value.views || !Array.isArray(value.views.items) || !value.dataset.records || !Array.isArray(value.dataset.records.include)) {
    throw new Error('不支持的多维表格文件格式');
  }
  // Keep older saved tables readable, then return the canonical type on the next save.
  for (const field of value.dataset.schema.fields) {
    const legacyField = field as unknown as { type?: unknown };
    if (legacyField?.type === 'Tags' || legacyField?.type === 'noteTag') legacyField.type = 'Tag';
  }
  if (!hasOnlyKeys(value, ['collection', 'dataset', 'views'])) throw new Error('多维表格文件包含未知字段');
  const fieldIds = new Set<string>();
  const fieldKeys = new Set<string>();
  for (const field of value.dataset?.schema.fields) {
    if (!field || !hasOnlyKeys(field, ['id', 'type', 'name', 'property_key', 'options', 'multiple', 'preset_revision', 'preset_pending'])
      || !/^fld_[0-9a-f]{32}$/.test(field.id) || fieldIds.has(field.id) || !(field.type === 'primary' || (String(field.type) !== 'Note' && isTablePropertyKind(field.type)))) {
      throw new Error('表格字段 ID 或类型无效');
    }
    if (field.type !== 'primary' && (typeof field.property_key !== 'string' || !field.property_key.trim())) {
      throw new Error('表格字段缺少笔记属性键');
    }
    if (field.name !== undefined && (typeof field.name !== 'string' || !field.name.trim())) throw new Error('表格字段显示名无效');
    if (field.type === 'primary' && field.property_key !== 'note') throw new Error('主字段的属性键必须是 note');
    if (field.preset_pending !== undefined && typeof field.preset_pending !== 'boolean') throw new Error('预设同步状态无效');
    if (field.preset_revision !== undefined && (!Number.isSafeInteger(field.preset_revision) || field.preset_revision < 1)) throw new Error('预设版本无效');
    const fieldKey = field.property_key?.trim().toLocaleLowerCase();
    if (fieldKey === 'flowix_property_types') throw new Error('类型元数据不能作为表格属性');
    if (fieldKey) {
      if (fieldKeys.has(fieldKey)) throw new Error(`属性键重复：${field.property_key}`);
      fieldKeys.add(fieldKey);
    }
    const optionIds = new Set<string>();
    const optionLabels = new Set<string>();
    if (field.options !== undefined && !Array.isArray(field.options)) throw new Error('表格字段选项格式无效');
    for (const option of field.options ?? []) {
      if (!option || !hasOnlyKeys(option, ['id', 'label']) || !/^opt_[0-9a-f]{32}$/.test(option.id) || optionIds.has(option.id) || typeof option.label !== 'string' || !option.label.trim()) throw new Error(`字段“${field.property_key ?? '笔记文档'}”的选项定义无效`);
      optionIds.add(option.id);
      const label = option.label.trim();
      if (optionLabels.has(label)) throw new Error(`字段“${field.property_key}”的选项名称重复`);
      optionLabels.add(label);
    }
    fieldIds.add(field.id);
  }
  if (value.dataset?.schema.fields[0]?.type !== 'primary' || value.dataset?.schema.fields.filter((field) => field.type === 'primary').length !== 1) {
    throw new Error('多维表格首列必须是唯一的笔记引用字段');
  }
  if (value.dataset?.schema.primary_field_id !== value.dataset?.schema.fields[0].id) throw new Error('多维表格主字段必须是笔记引用字段');
  const order = value.dataset.schema.field_order;
  if (order !== undefined && (!Array.isArray(order) || new Set(order).size !== order.length
    || order.some((id) => typeof id !== 'string' || (!fieldIds.has(id) && !isBuiltinTableFieldId(id)))
    || (order.length > 0 && order[0] !== value.dataset.schema.primary_field_id))) throw new Error('笔记字段顺序无效');
  const presetFields = value.dataset.schema.preset_fields;
  const presetFieldIds = new Set<string>(BUILTIN_TABLE_FIELDS.filter((field) => builtinPresetTableField(field.id)).map((field) => field.id));
  if (presetFields !== undefined && (!Array.isArray(presetFields) || new Set(presetFields).size !== presetFields.length
    || presetFields.some((id) => typeof id !== 'string' || !presetFieldIds.has(id)))) throw new Error('预设属性列表无效');
  const deletedPresets = value.dataset.schema.deleted_presets;
  if (deletedPresets !== undefined) {
    if (!Array.isArray(deletedPresets)) throw new Error('已删除预设列表无效');
    const deletedIds = new Set<string>();
    for (const preset of deletedPresets) {
      if (!preset || typeof preset !== 'object' || !/^fld_[0-9a-f]{32}$/.test(preset.id ?? '')
        || deletedIds.has(preset.id!) || typeof preset.key !== 'string' || !preset.key.trim()
        || !isTablePropertyKind(preset.type)
        || !Number.isSafeInteger(preset.revision) || (preset.revision ?? 0) < 1
        || (preset.options !== undefined && (!Array.isArray(preset.options) || preset.options.some((option) => typeof option !== 'string')))
        || (preset.optionIds !== undefined && (!Array.isArray(preset.optionIds) || preset.optionIds.some((id) => typeof id !== 'string' || !/^opt_[0-9a-f]{32}$/.test(id))))) {
        throw new Error('已删除预设定义无效');
      }
      deletedIds.add(preset.id!);
    }
  }
  const viewIds = new Set<string>();
  if (typeof value.views.default_id !== 'string' || !hasOnlyKeys(value.views, ['default_id', 'items'])) throw new Error('表格视图定义无效');
  if (value.views?.items.length === 0) throw new Error('多维表格至少需要一个视图');
  for (const view of value.views?.items) {
    if (!view || !hasOnlyKeys(view, ['id', 'name', 'layout', 'filter', 'sort', 'config']) || !/^view_[0-9a-f]{32}$/.test(view.id) || viewIds.has(view.id) || typeof view.name !== 'string' || !view.name.trim() || !['table', 'kanban', 'calendar', 'gallery'].includes(view.layout) || !view.config || typeof view.config !== 'object' || Array.isArray(view.config)) throw new Error('表格视图定义无效');
    viewIds.add(view.id);
    const referencedFields: string[] = [];
    const visibleFields = view.config.visible_fields;
    if ((view.layout === 'table' || view.layout === 'gallery')
      && (!Array.isArray(visibleFields) || visibleFields.some((item) => typeof item !== 'string'))) {
      throw new Error(`视图“${view.name}”的显示字段配置无效`);
    }
    if (view.layout === 'table' || view.layout === 'gallery') {
      referencedFields.push(...(visibleFields as string[]).filter((id) => view.layout !== 'table' || !isBuiltinTableFieldId(id)));
    }
    if (referencedFields.some((id) => !fieldIds.has(id))) throw new Error(`视图“${view.name}”引用了不存在的字段`);
    // Keep accepting the old manual width so saved table documents remain readable.
    const allowedConfigKeys = view.layout === 'table'
      ? ['visible_fields', 'tag_column_width']
      : view.layout === 'gallery'
        ? ['visible_fields']
      : view.layout === 'kanban' ? ['group_by'] : ['date_field', 'title_field', 'week_start'];
    if (!hasOnlyKeys(view.config, allowedConfigKeys)) throw new Error(`视图“${view.name}”包含未知配置`);
    if (view.layout === 'kanban' && view.config.group_by !== undefined && typeof view.config.group_by !== 'string') {
      throw new Error(`看板视图“${view.name}”的分组字段配置无效`);
    }
    if (view.layout === 'calendar'
      && ((view.config.date_field !== undefined && typeof view.config.date_field !== 'string')
        || (view.config.title_field !== undefined && typeof view.config.title_field !== 'string'))) {
      throw new Error(`日历视图“${view.name}”的字段配置无效`);
    }
    if (view.layout === 'table' && view.config.tag_column_width !== undefined
      && (typeof view.config.tag_column_width !== 'number' || !Number.isFinite(view.config.tag_column_width)
        || view.config.tag_column_width < TAG_COLUMN_MIN_WIDTH || view.config.tag_column_width > TAG_COLUMN_MAX_WIDTH)) {
      throw new Error(`视图“${view.name}”的标签列宽度无效`);
    }
    if (view.layout === 'calendar') {
      if (view.config.week_start !== undefined && view.config.week_start !== 1) throw new Error(`日历视图“${view.name}”的周起始日无效`);
    }
  }
  const recordIds = new Set<string>();
  const linkedNotes = new Set<string>();
  for (const record of value.dataset.records.include) {
    if (!record || !/^rec_[0-9a-f]{32}$/.test(record.id) || recordIds.has(record.id)
      || typeof record.updated_at !== 'string'
      || typeof record.note_path !== 'string'
      || Object.keys(record).some((key) => !['id', 'updated_at', 'note_path'].includes(key))) throw new Error('表格记录格式无效');
    recordIds.add(record.id);
    if (record.note_path) {
      const normalized = record.note_path.replace(/\\/g, '/');
      if (linkedNotes.has(normalized)) throw new Error(`笔记重复关联：${normalized}`);
      linkedNotes.add(normalized);
    }
  }
  const document = value as unknown as MultidimensionalTableDocument;
  const legacyAddedPresets = value.dataset.schema.preset_fields ?? BUILTIN_TABLE_FIELDS
    .filter((field) => builtinPresetTableField(field.id)
      && value.views!.items.some((view) => view.layout === 'table' && (view.config.visible_fields as string[]).includes(field.id)))
    .map((field) => field.id);
  const fieldOrder = completeFieldOrder(
    value.dataset.schema.primary_field_id,
    value.dataset.schema.fields,
    legacyAddedPresets,
    value.dataset.schema.field_order ?? [],
  );
  return {
    ...document,
    views: viewIds.has(document.views.default_id) ? document.views
      : { ...document.views, default_id: document.views.items[0].id },
    dataset: { ...document.dataset, schema: { ...document.dataset.schema, preset_fields: legacyAddedPresets, field_order: fieldOrder } },
  };
}

export function serializeTableDocument(document: MultidimensionalTableDocument): string {
  const { views } = validateTableDocument(document);
  return serializeCollectionDocumentV2({ format: 'flowix.collection', schema_version: 2, collection: document.collection,
    payload: { schema_version: 2, dataset: { ...document.dataset, schema: { ...document.dataset.schema, deleted_presets: undefined } }, views } });
}
