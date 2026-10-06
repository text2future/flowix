import YAML from 'yaml';
import { isTablePropertyKind, type TablePropertyKind } from '@/lib/property-types';

export const NOTE_CREATED_AT_FIELD_ID = '__note_created_at__';
export const NOTE_UPDATED_AT_FIELD_ID = '__note_updated_at__';

export type TableFieldType = Exclude<TablePropertyKind, 'Note'> | 'primary';

export interface TableFieldOption {
  id: string;
  label: string;
}

export interface TableAutoCollectCondition {
  property_conditions?: TableAutoCollectPropertyCondition[];
  property_match?: 'union' | 'intersection';
  file_condition?: TableAutoCollectFileCondition;
}

export interface TableAutoCollectPropertyCondition {
  /**
   * A table field ID, or a raw note frontmatter property key when the
   * property is not configured as a table field.
   */
  field_id: string;
  operator: 'equals' | 'contains';
  value: string;
}

export type TableAutoCollectFileType = '' | 'markdown';

export interface TableAutoCollectFileCondition {
  file_name_contains?: string;
  file_type?: TableAutoCollectFileType;
  path_contains?: string;
}

export interface TableAutoCollectConfig {
  condition: TableAutoCollectCondition;
  excluded_note_paths: string[];
}

export interface TableField {
  id: string;
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
  type: TableViewType;
  config: Record<string, unknown>;
}

export type TableViewType = 'table' | 'kanban' | 'calendar' | 'gallery';

const VIEW_NAMES: Record<TableViewType, string> = {
  table: '表格', kanban: '看板', calendar: '日历', gallery: '画廊列表',
};

export interface TableRecord {
  id: string;
  updated_at: string;
  /** Notebook-relative note reference. Property values live in note frontmatter. */
  note_path: string;
}

export interface MultidimensionalTableDocument {
  format: 'flowix.table';
  version: 1;
  revision: number;
  table: {
    id: string;
    primary_field_id: string;
    fields: TableField[];
    views: TableView[];
  };
  records: {
    data: TableRecord[];
    auto_collect: TableAutoCollectConfig | null;
  };
}

export function createUuidV7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createTableId(): string {
  return `tbl_${createUuidV7()}`;
}

export function createTableView(document: MultidimensionalTableDocument, type: TableViewType, fieldId?: string): TableView {
  const fields = document.table.fields;
  const field = fields.find((item) => item.id === fieldId);
  if (type === 'kanban' && field?.type !== 'Select') throw new Error('看板需要单选属性');
  if (type === 'calendar' && fieldId && fieldId !== NOTE_CREATED_AT_FIELD_ID && fieldId !== NOTE_UPDATED_AT_FIELD_ID && field?.type !== 'Date') {
    throw new Error('日历需要日期属性');
  }
  const baseName = VIEW_NAMES[type];
  const names = new Set(document.table.views.map((view) => view.name));
  let name = baseName;
  for (let suffix = 2; names.has(name); suffix += 1) name = `${baseName} ${suffix}`;
  const config = type === 'table'
    ? { visible_fields: fields.map((item) => item.id) }
    : type === 'gallery'
      ? { visible_fields: fields.filter((item) => item.type !== 'primary').map((item) => item.id) }
      : type === 'calendar'
        ? { date_field: fieldId ?? NOTE_CREATED_AT_FIELD_ID, title_field: document.table.primary_field_id }
        : { group_by: fieldId };
  return { id: `view_${createUuidV7()}`, name, type, config };
}

export function addTableView(document: MultidimensionalTableDocument, type: TableViewType, fieldId?: string): { document: MultidimensionalTableDocument; view: TableView } {
  const view = createTableView(document, type, fieldId);
  return {
    view,
    document: {
      ...document,
      revision: document.revision + 1,
      table: { ...document.table, views: [...document.table.views, view] },
    },
  };
}

/** Adds a shared note property only when the user explicitly chooses to create one. */
export function addKanbanField(document: MultidimensionalTableDocument): { document: MultidimensionalTableDocument; field: TableField } {
  const keys = new Set(document.table.fields.map((field) => field.property_key?.toLocaleLowerCase()));
  let propertyKey = '状态';
  for (let suffix = 2; keys.has(propertyKey.toLocaleLowerCase()); suffix += 1) propertyKey = `状态 ${suffix}`;
  const field: TableField = {
    id: `fld_${createUuidV7()}`,
    type: 'Select',
    property_key: propertyKey,
    options: ['未开始', '进行中', '完成'].map((label) => ({ id: `opt_${createUuidV7()}`, label })),
  };
  return {
    field,
    document: {
      ...document,
      table: {
        ...document.table,
        fields: [...document.table.fields, field],
        views: document.table.views.map((view) => view.type === 'table'
          ? { ...view, config: { ...view.config, visible_fields: [...view.config.visible_fields as string[], field.id] } }
          : view),
      },
    },
  };
}

export function createTableDocument(initialViewType: TableViewType = 'table'): MultidimensionalTableDocument {
  const id = createTableId();
  const noteFieldId = `fld_${createUuidV7()}`;
  let document: MultidimensionalTableDocument = {
    format: 'flowix.table',
    version: 1,
    revision: 1,
    table: {
      id,
      primary_field_id: noteFieldId,
    fields: [{ id: noteFieldId, type: 'primary', property_key: 'note' }],
      views: [],
    },
    records: { data: [], auto_collect: null },
  };
  let fieldId: string | undefined;
  if (initialViewType === 'kanban') {
    const added = addKanbanField(document);
    document = added.document;
    fieldId = added.field.id;
  }
  document.table.views = [createTableView(document, initialViewType, fieldId)];
  return document;
}

export function parseTableDocument(source: string): MultidimensionalTableDocument {
  return validateTableDocument(YAML.parse(source));
}

export function validateTableDocument(parsed: unknown): MultidimensionalTableDocument {
  if (!parsed || typeof parsed !== 'object') throw new Error('表格文件必须是 YAML 对象');
  const value = parsed as Partial<MultidimensionalTableDocument>;
  if (value.format !== 'flowix.table' || value.version !== 1 || !Number.isInteger(value.revision) || !value.table || !/^tbl_[0-9a-f]{32}$/.test(value.table.id) || !Array.isArray(value.table.fields)
      || !Array.isArray(value.table.views) || !value.records || Array.isArray(value.records) || !Array.isArray(value.records.data)) {
    throw new Error('不支持的多维表格文件格式');
  }
  if (!hasOnlyKeys(value, ['format', 'version', 'revision', 'table', 'records'])
    || !hasOnlyKeys(value.table, ['id', 'primary_field_id', 'fields', 'views'])
    || !hasOnlyKeys(value.records, ['data', 'auto_collect'])) throw new Error('多维表格文件包含未知字段');
  const fieldIds = new Set<string>();
  const fieldKeys = new Set<string>();
  for (const field of value.table.fields) {
    if (!field || !hasOnlyKeys(field, ['id', 'type', 'name', 'property_key', 'options', 'multiple'])
      || !/^fld_[0-9a-f]{32}$/.test(field.id) || fieldIds.has(field.id) || !(field.type === 'primary' || (String(field.type) !== 'Note' && isTablePropertyKind(field.type)))) {
      throw new Error('表格字段 ID 或类型无效');
    }
    if (field.type !== 'primary' && (typeof field.property_key !== 'string' || !field.property_key.trim())) {
      throw new Error('表格字段缺少笔记属性键');
    }
    if (field.name !== undefined && (typeof field.name !== 'string' || !field.name.trim())) throw new Error('表格字段显示名无效');
    if (field.type === 'primary' && field.property_key !== 'note') throw new Error('主字段的属性键必须是 note');
    const fieldKey = field.property_key?.trim().toLocaleLowerCase();
    if (fieldKey) {
      if (fieldKeys.has(fieldKey)) throw new Error(`属性键重复：${field.property_key}`);
      fieldKeys.add(fieldKey);
    }
    const optionIds = new Set<string>();
    if (field.options !== undefined && !Array.isArray(field.options)) throw new Error('表格字段选项格式无效');
    for (const option of field.options ?? []) {
      if (!option || !hasOnlyKeys(option, ['id', 'label']) || !/^opt_[0-9a-f]{32}$/.test(option.id) || optionIds.has(option.id) || typeof option.label !== 'string' || !option.label.trim()) throw new Error(`字段“${field.property_key ?? '笔记文档'}”的选项定义无效`);
      optionIds.add(option.id);
    }
    fieldIds.add(field.id);
  }
  if (value.table.fields[0]?.type !== 'primary' || value.table.fields.filter((field) => field.type === 'primary').length !== 1) {
    throw new Error('多维表格首列必须是唯一的笔记引用字段');
  }
  if (value.table.primary_field_id !== value.table.fields[0].id) throw new Error('多维表格主字段必须是笔记引用字段');
  const viewIds = new Set<string>();
  if (value.table.views.length === 0) throw new Error('多维表格至少需要一个视图');
  for (const view of value.table.views) {
    if (!view || !hasOnlyKeys(view, ['id', 'name', 'type', 'config']) || !/^view_[0-9a-f]{32}$/.test(view.id) || viewIds.has(view.id) || typeof view.name !== 'string' || !view.name.trim() || !['table', 'kanban', 'calendar', 'gallery'].includes(view.type) || !view.config || typeof view.config !== 'object' || Array.isArray(view.config)) throw new Error('表格视图定义无效');
    viewIds.add(view.id);
    const referencedFields = [view.config.group_by, view.config.title_field]
      .filter((item): item is string => typeof item === 'string');
    if (typeof view.config.date_field === 'string'
      && view.config.date_field !== NOTE_CREATED_AT_FIELD_ID
      && view.config.date_field !== NOTE_UPDATED_AT_FIELD_ID) {
      referencedFields.push(view.config.date_field);
    }
    const visibleFields = view.config.visible_fields;
    if ((view.type === 'table' || view.type === 'gallery')
      && (!Array.isArray(visibleFields) || visibleFields.some((item) => typeof item !== 'string'))) {
      throw new Error(`视图“${view.name}”的显示字段配置无效`);
    }
    if (view.type === 'table' || view.type === 'gallery') referencedFields.push(...visibleFields as string[]);
    if (referencedFields.some((id) => !fieldIds.has(id))) throw new Error(`视图“${view.name}”引用了不存在的字段`);
    const allowedConfigKeys = view.type === 'table' || view.type === 'gallery'
      ? ['visible_fields']
      : view.type === 'kanban' ? ['group_by'] : ['date_field', 'title_field', 'week_start'];
    if (!hasOnlyKeys(view.config, allowedConfigKeys)) throw new Error(`视图“${view.name}”包含未知配置`);
    if (view.type === 'kanban') {
      const groupField = value.table.fields.find((field) => field.id === view.config.group_by);
      if (!groupField || groupField.type !== 'Select') throw new Error(`看板视图“${view.name}”需要单选属性`);
    }
    if (view.type === 'calendar') {
      const dateFieldId = view.config.date_field;
      const dateField = typeof dateFieldId === 'string' ? value.table.fields.find((field) => field.id === dateFieldId) : undefined;
      if (dateFieldId !== NOTE_CREATED_AT_FIELD_ID && dateFieldId !== NOTE_UPDATED_AT_FIELD_ID && dateField?.type !== 'Date') {
        throw new Error(`日历视图“${view.name}”需要日期属性`);
      }
      if (typeof view.config.title_field !== 'string') throw new Error(`日历视图“${view.name}”的标题字段无效`);
      if (view.config.week_start !== undefined && view.config.week_start !== 1) throw new Error(`日历视图“${view.name}”的周起始日无效`);
    }
  }
  const recordIds = new Set<string>();
  const linkedNotes = new Set<string>();
  const autoCollect = value.records.auto_collect;
  if (autoCollect === undefined) throw new Error('缺少笔记条件匹配配置');
  if (autoCollect !== null && !isTableAutoCollectConfig(autoCollect)) {
    throw new Error('笔记条件匹配配置无效');
  }
  for (const record of value.records.data) {
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
  return value as MultidimensionalTableDocument;
}

export function isTableAutoCollectConfig(value: unknown): value is TableAutoCollectConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Partial<TableAutoCollectConfig>;
  const condition = config.condition;
  if (!hasOnlyKeys(config, ['condition', 'excluded_note_paths'])
    || !condition || typeof condition !== 'object' || Array.isArray(condition)
    || !hasOnlyKeys(condition, ['property_conditions', 'property_match', 'file_condition'])
    || !Array.isArray(config.excluded_note_paths)
    || config.excluded_note_paths.some((path) => typeof path !== 'string')) return false;
  if (condition.property_match !== undefined && !['union', 'intersection'].includes(condition.property_match)) return false;
  if (condition.property_match !== undefined && !condition.property_conditions?.length) return false;
  if (condition.property_conditions !== undefined && (!Array.isArray(condition.property_conditions) || condition.property_conditions.length === 0
    || condition.property_conditions.some((item) => !item || !hasOnlyKeys(item, ['field_id', 'operator', 'value']) || typeof item.field_id !== 'string' || !item.field_id.trim()
      || !['equals', 'contains'].includes(item.operator) || typeof item.value !== 'string' || !item.value.trim()))) return false;
  if (condition.property_conditions?.length && condition.property_match === undefined) return false;
  if (condition.file_condition !== undefined) {
    const fileCondition = condition.file_condition;
    if (!fileCondition || typeof fileCondition !== 'object' || Array.isArray(fileCondition)
      || !hasOnlyKeys(fileCondition, ['file_name_contains', 'file_type', 'path_contains'])) return false;
    for (const key of ['file_name_contains', 'file_type', 'path_contains'] as const) {
      if (fileCondition[key] !== undefined && typeof fileCondition[key] !== 'string') return false;
    }
    if (fileCondition.file_type !== undefined && fileCondition.file_type !== '' && fileCondition.file_type !== 'markdown') return false;
    if (!Object.values(fileCondition).some((item) => typeof item === 'string' && item.trim())) return false;
  }
  if (!condition.property_conditions?.length && !condition.file_condition) return false;
  return true;
}

function hasOnlyKeys(value: object, allowedKeys: string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

export function serializeTableDocument(document: MultidimensionalTableDocument): string {
  return YAML.stringify(document, { lineWidth: 0, indent: 2 });
}
