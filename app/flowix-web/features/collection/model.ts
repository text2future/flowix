import YAML from 'yaml';
import { datasetLocation, shareDatasetLocation } from './shared-dataset-location';

/** Runtime names stay stable while schema v2 uses the user-facing dataset names. */
export type CollectionType = 'table' | 'media_library' | 'work_documents';
/** 集合身份里的类型：v3 hybrid 额外允许 'hybrid'。 */
export type CollectionMetadataType = CollectionType | 'hybrid';
export type CollectionPlacement = 'standalone' | 'folder';
export interface CollectionSource {
  scope: 'containing_folder' | 'notebook' | 'folder';
  path?: string;
}
export type CollectionPropertyType = 'Text' | 'Number' | 'Boolean' | 'Date' | 'URL' | 'Icon' | 'Color' | 'Tag';
export interface CollectionProperty {
  type: CollectionPropertyType;
  name?: string;
  value: string | number | boolean | string[];
}
export interface CollectionMetadata {
  id: string;
  type: CollectionMetadataType;
  placement: CollectionPlacement;
  /** Legacy name retained when reading old files; the path is authoritative. */
  name?: string;
  revision: number;
  created_at: string;
  updated_at: string;
  properties: Record<string, CollectionProperty>;
}
export interface CollectionDocumentV2 {
  format: 'flowix.collection';
  schema_version: 2;
  collection: CollectionMetadata;
  payload: { schema_version: 2; dataset: Record<string, unknown>; views: Record<string, unknown> };
}

/** v3 hybrid 数据域。notes=多维表格，media=图墙（媒体域），work_documents=列表。 */
export type CollectionDomain = 'notes' | 'media' | 'work_documents';
export const COLLECTION_DOMAINS: readonly CollectionDomain[] = ['notes', 'media', 'work_documents'];
const DOMAIN_RUNTIME_TYPES: Record<CollectionDomain, CollectionType> = {
  notes: 'table', media: 'media_library', work_documents: 'work_documents',
};
const RUNTIME_TYPE_DOMAINS: Record<CollectionType, CollectionDomain> = {
  table: 'notes', media_library: 'media', work_documents: 'work_documents',
};
export function collectionDomainType(domain: CollectionDomain): CollectionType {
  return DOMAIN_RUNTIME_TYPES[domain];
}
export function collectionTypeDomain(type: CollectionType): CollectionDomain {
  return RUNTIME_TYPE_DOMAINS[type];
}

export interface HybridCollectionView {
  id: string;
  name: string;
  domain: CollectionDomain;
  layout: string;
  filter?: Record<string, unknown>;
  sort?: unknown[];
  config: Record<string, unknown>;
}
export interface HybridCollectionPayload {
  schema_version: 3;
  file_tree: boolean;
  domains: Partial<Record<CollectionDomain, Record<string, unknown>>>;
  views: {
    default_by_domain: Partial<Record<CollectionDomain, string>>;
    items: HybridCollectionView[];
  };
}
export interface HybridCollectionDocument {
  format: 'flowix.collection';
  schema_version: 3;
  collection: CollectionMetadata;
  payload: HybridCollectionPayload;
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
export const createCollectionId = () => `col_${createUuidV7()}`;
export function createCollectionMetadata(
  type: CollectionMetadataType,
  _name: string,
  placement: CollectionPlacement = 'standalone',
): CollectionMetadata {
  const now = new Date().toISOString();
  return { id: createCollectionId(), type, placement, revision: 0, created_at: now, updated_at: now, properties: {} };
}
export function collectionDisplayName(filePath: string, placement: CollectionPlacement): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  if (placement === 'folder') return parts[parts.length - 2] ?? '';
  return (parts[parts.length - 1] ?? '').replace(/\.(?:index\.ya?ml|(?:table|lib|workdocs)\.ya?ml)$/i, '');
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function isNotebookRelativePath(path: unknown): path is string {
  return typeof path === 'string' && Boolean(path) && !path.startsWith('/') && !path.includes('\\')
    && path.split('/').every((part) => part && part !== '.' && part !== '..');
}
function filterRules(filter: Record<string, unknown>): Record<string, unknown>[] {
  return [...(filter.all as Record<string, unknown>[]), ...(filter.any as Record<string, unknown>[])].flatMap((entry) =>
    'field' in entry ? [entry] : filterRules(entry));
}
function validateRuleFilter(filter: unknown, depth = 0): filter is { all: Record<string, unknown>[]; any: Record<string, unknown>[] } {
  if (!isRecord(filter) || !hasOnlyKeys(filter, ['all', 'any'])) return false;
  return ['all', 'any'].every((key) => Array.isArray(filter[key]) && (filter[key] as unknown[]).every((raw) => {
    if (!isRecord(raw)) return false;
    if ('all' in raw || 'any' in raw) return depth === 0 && validateRuleFilter(raw, 1);
    if (!hasOnlyKeys(raw, ['field', 'op', 'value']) || typeof raw.field !== 'string' || !raw.field.trim()) return false;
    if (!['eq', 'equals', 'contains', 'in', 'gt', 'lt'].includes(String(raw.op))) return false;
    if (raw.op === 'contains') return typeof raw.value === 'string';
    if (raw.op === 'in') return Array.isArray(raw.value) && raw.value.length > 0;
    return typeof raw.value === 'string' || typeof raw.value === 'number' || typeof raw.value === 'boolean';
  }));
}
function ruleFilterMatchesCollectionType(filter: unknown, type: CollectionMetadataType, sharedAssetKinds = false): boolean {
  if (!validateRuleFilter(filter)) return false;
  return filterRules(filter).every((rule) => {
    const field = rule.field;
    if (type === 'table') {
      if (field === 'file_name' || field === 'path') return rule.op === 'contains';
      if (field === 'kind') return (rule.op === 'eq' && rule.value === 'note')
        || (rule.op === 'in' && Array.isArray(rule.value) && rule.value.length === 1 && rule.value[0] === 'note');
      return rule.op === 'eq' || rule.op === 'equals' || rule.op === 'contains' || rule.op === 'in' || rule.op === 'gt' || rule.op === 'lt';
    }
    if (field === 'file_name' || field === 'path') return rule.op === 'contains' && typeof rule.value === 'string';
    if (field === 'kind' && sharedAssetKinds && (type === 'media_library' || type === 'work_documents')) {
      const kinds = ['image', 'video', 'document', 'spreadsheet', 'presentation', 'web', 'archive', 'database'];
      return (rule.op === 'eq' && kinds.includes(String(rule.value)))
        || (rule.op === 'in' && Array.isArray(rule.value) && rule.value.every((kind) => kinds.includes(String(kind))));
    }
    if (field === 'kind' && type === 'media_library') return (rule.op === 'eq' && (rule.value === 'image' || rule.value === 'video'))
      || (rule.op === 'in' && Array.isArray(rule.value) && rule.value.every((kind) => kind === 'image' || kind === 'video'));
    if (field === 'kind' && type === 'work_documents') {
      const kinds = ['document', 'spreadsheet', 'presentation', 'web', 'archive', 'database'];
      return (rule.op === 'eq' && typeof rule.value === 'string' && kinds.includes(rule.value))
        || (rule.op === 'in' && Array.isArray(rule.value) && rule.value.length > 0
          && rule.value.every((kind) => typeof kind === 'string' && kinds.includes(kind)));
    }
    return false;
  });
}
function datasetFilterMatchesCollectionType(filter: unknown, type: CollectionMetadataType): boolean {
  if (!isRecord(filter) || !hasOnlyKeys(filter, ['path', 'match', 'conditions'])) {
    return ruleFilterMatchesCollectionType(filter, type);
  }
  if (!(filter.path === null || filter.path === '' || isNotebookRelativePath(filter.path))
    || (filter.match !== 'all' && filter.match !== 'any')
    || !Array.isArray(filter.conditions)
    || filter.conditions.some((condition) => !isRecord(condition) || 'all' in condition || 'any' in condition)) return false;
  if (type === 'media_library' && filter.match !== 'all') return false;
  const legacyShape = { all: filter.conditions, any: [] };
  if (!filter.conditions.every((condition) => isRecord(condition) && condition.field !== 'path')) return false;
  return ruleFilterMatchesCollectionType(legacyShape, type, true);
}
export function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
export function validateCollectionProperty(property: unknown): property is CollectionProperty {
  if (!isRecord(property) || !hasOnlyKeys(property, ['type', 'name', 'value'])
    || (property.name !== undefined && (typeof property.name !== 'string' || !property.name.trim()))) return false;
  const value = property.value;
  switch (property.type) {
    case 'Number': return typeof value === 'number' && Number.isFinite(value);
    case 'Boolean': return typeof value === 'boolean';
    case 'Date': return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    case 'Tag': case 'Color': return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'Text': case 'URL': case 'Icon': return typeof value === 'string';
    default: return false;
  }
}
export function validateCollectionMetadata(value: unknown, type?: CollectionType): CollectionMetadata {
  const normalizedType = value && typeof value === 'object' && 'type' in value
    ? (value.type === 'notes' ? 'table' : value.type === 'media' ? 'media_library' : value.type)
    : undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'type', 'placement', 'name', 'revision', 'created_at', 'updated_at', 'properties'])
    || typeof value.id !== 'string' || !/^col_[0-9a-f]{32}$/.test(value.id)
    || !['table', 'media_library', 'work_documents', 'hybrid'].includes(String(normalizedType)) || (type && normalizedType !== type)
    || (value.placement !== undefined && !['standalone', 'folder'].includes(String(value.placement)))
    || (value.name !== undefined && (typeof value.name !== 'string' || !value.name.trim() || value.name !== value.name.trim()))
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))
    || typeof value.updated_at !== 'string' || !Number.isFinite(Date.parse(value.updated_at))
    || !isRecord(value.properties) || Object.entries(value.properties).some(([key, property]) => (
      !/^[a-z][a-z0-9_]*$/.test(key) || !validateCollectionProperty(property)
    ))) throw new Error('集合身份、版本或自有属性无效');
  return { ...value, type: normalizedType, placement: (value.placement as CollectionPlacement | undefined) ?? 'standalone' } as unknown as CollectionMetadata;
}

function validateV2Envelope(value: Record<string, unknown>): { collection: CollectionMetadata; payload: Record<string, unknown> } {
  if (!isRecord(value.collection) || !isRecord(value.payload) || !hasOnlyKeys(value.payload, ['schema_version', 'dataset', 'views'])
    || value.payload.schema_version !== 2 || !isRecord(value.payload.dataset) || !isRecord(value.payload.views)) {
    throw new Error('集合数据集或视图格式无效');
  }
  const collection = validateCollectionMetadata(value.collection);
  const dataset = value.payload.dataset;
  if (!hasOnlyKeys(dataset, ['source', 'schema', 'records', 'filter']) || !isRecord(dataset.source)
    || !isRecord(dataset.schema) || !isRecord(dataset.records) || !hasOnlyKeys(dataset.records, ['include', 'exclude'])
    || !Array.isArray(dataset.records.include) || !Array.isArray(dataset.records.exclude)
    || !isRecord(value.payload.views) || !Array.isArray(value.payload.views.items)) {
    throw new Error('集合数据集格式无效');
  }
  const source = dataset.source;
  if (!hasOnlyKeys(source, ['scope', 'depth', 'path'])
    || !['containing_folder', 'notebook', 'folder'].includes(String(source.scope))
    || (source.depth !== undefined && !['direct_children', 'descendants'].includes(String(source.depth)))) throw new Error('集合数据范围无效');
  if (collection.placement === 'folder') {
    if (source.scope !== 'containing_folder' || source.path !== undefined) throw new Error('文件夹集合的数据范围必须绑定所在目录');
  } else if (source.scope === 'containing_folder' || (source.scope === 'folder' && !isNotebookRelativePath(source.path))) {
    throw new Error('独立集合的数据范围无效');
  }
  if (source.scope !== 'folder' && source.path !== undefined) throw new Error('集合数据范围不应包含 path');
  // `depth` was an earlier user setting. Keep accepting its old valid values,
  // but drop it from the normalized model so all collection domains recurse.
  const normalizedSource: CollectionSource = {
    scope: source.scope as CollectionSource['scope'],
    ...(source.scope === 'folder' ? { path: source.path as string } : {}),
  };
  if (!hasOnlyKeys(dataset.schema, collection.type === 'table' ? ['primary_field_id', 'fields', 'field_order', 'preset_fields', 'deleted_presets'] : ['fields'])) throw new Error('集合字段定义包含未知字段');
  if (collection.type === 'table' && (typeof dataset.schema.primary_field_id !== 'string' || !dataset.schema.primary_field_id.trim())) throw new Error('笔记集合缺少主字段');
  if (dataset.schema.preset_fields !== undefined && (!Array.isArray(dataset.schema.preset_fields)
    || (dataset.schema.preset_fields as unknown[]).some((id) => typeof id !== 'string'))) throw new Error('预设属性列表无效');
  if ((collection.type === 'media_library' || collection.type === 'work_documents') && (!Array.isArray(dataset.schema.fields) || dataset.schema.fields.length > 0)) throw new Error('此集合不支持自定义字段');
  for (const kind of ['include', 'exclude'] as const) {
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    for (const record of dataset.records[kind] as unknown[]) {
      if (!isRecord(record) || (record.id !== undefined && (typeof record.id !== 'string' || !/^rec_[0-9a-f]{32}$/.test(record.id) || seenIds.has(record.id)))
        || (record.updated_at !== undefined && (typeof record.updated_at !== 'string' || !Number.isFinite(Date.parse(record.updated_at))))) throw new Error('集合记录格式无效');
      if (record.id !== undefined) seenIds.add(record.id as string);
      const path = collection.type === 'table' ? record.note_path : record.relative_path;
      const isDraftNote = collection.type === 'table' && kind === 'include' && path === '';
      if (!isDraftNote && !isNotebookRelativePath(path)) throw new Error('集合记录路径无效');
      if (!isDraftNote && seenPaths.has(path)) throw new Error('集合记录重复');
      if (!isDraftNote) seenPaths.add(path);
      if (collection.type === 'media_library' && (typeof record.resource_id !== 'string' || !record.resource_id.trim())) throw new Error('媒体记录缺少资源 ID');
      if (collection.type === 'work_documents') throw new Error('工作文档集合不支持手动记录');
      if (collection.type === 'table' && !hasOnlyKeys(record, ['id', 'updated_at', 'note_path'])) throw new Error('笔记记录包含未知字段');
      if (collection.type === 'media_library' && !hasOnlyKeys(record, ['id', 'updated_at', 'resource_id', 'relative_path'])) throw new Error('媒体记录包含未知字段');
    }
  }
  const views = value.payload.views;
  const viewItems = Array.isArray(views.items) ? views.items : null;
  if (typeof views.default_id !== 'string' || !viewItems || viewItems.length === 0
    || viewItems.some((view) => !isRecord(view) || !/^view_[0-9a-f]{32}$/.test(String(view.id))
      || typeof view.name !== 'string' || !view.name.trim() || typeof view.layout !== 'string'
      || !isRecord(view.config) || (view.filter !== undefined && !isRecord(view.filter))
      || (view.sort !== undefined && !Array.isArray(view.sort)))) throw new Error('集合视图格式无效');
  const validLayouts = collection.type === 'table' ? ['table', 'kanban', 'calendar', 'gallery']
    : collection.type === 'media_library' ? ['waterfall'] : ['gallery'];
  if (viewItems.some((view) => !isRecord(view) || !validLayouts.includes(String(view.layout))
    || (view.filter !== undefined && !ruleFilterMatchesCollectionType(view.filter, collection.type))
    || (Array.isArray(view.sort) && view.sort.some((sort) => !isRecord(sort) || !hasOnlyKeys(sort, ['field', 'direction'])
      || typeof sort.field !== 'string' || !sort.field || (sort.direction !== 'asc' && sort.direction !== 'desc')
      || (collection.type === 'media_library' && (sort.field !== 'created_at' || sort.direction !== 'desc')))))) throw new Error('集合视图筛选、排序或布局无效');
  // A deleted remembered table view is recoverable; the table model selects the first view.
  if (collection.type !== 'table' && !viewItems.some((view) => isRecord(view) && view.id === views.default_id)) throw new Error('默认集合视图不存在');
  if (value.payload.dataset.filter !== null && value.payload.dataset.filter !== undefined && !datasetFilterMatchesCollectionType(value.payload.dataset.filter, collection.type)) {
    throw new Error('集合规则筛选格式无效');
  }

  return { collection, payload: { ...value.payload, dataset: { ...dataset, source: normalizedSource } } };
}

/** 校验 v3 hybrid 信封。每个数据域复用 v2 校验器（合成单类型文档），与
 *  Rust `validate_collection_hybrid` 的伪文档策略逐条对齐。 */
function validateHybridEnvelope(value: Record<string, unknown>): { collection: CollectionMetadata; payload: HybridCollectionPayload } {
  if (!isRecord(value.collection) || !isRecord(value.payload)
    || !hasOnlyKeys(value.payload, ['schema_version', 'file_tree', 'domains', 'views'])
    || value.payload.schema_version !== 3) {
    throw new Error('集合混合文档格式无效');
  }
  const collection = validateCollectionMetadata(value.collection);
  if (collection.type !== 'hybrid') throw new Error('集合混合文档格式无效');
  const fileTree = value.payload.file_tree;
  if (typeof fileTree !== 'boolean' || (fileTree && collection.placement !== 'folder')) {
    throw new Error('集合文件树标记无效');
  }
  const rawDomains = value.payload.domains;
  if (!isRecord(rawDomains)) throw new Error('集合数据域无效');
  const domainKeys = Object.keys(rawDomains).filter((key): key is CollectionDomain =>
    (COLLECTION_DOMAINS as readonly string[]).includes(key));
  const rawViews = value.payload.views;
  const defaultsByKey = isRecord(rawViews) && isRecord(rawViews.default_by_domain) ? rawViews.default_by_domain : null;
  if (!isRecord(rawViews) || !hasOnlyKeys(rawViews, ['default_by_domain', 'items'])
    || defaultsByKey === null || !Array.isArray(rawViews.items)) {
    throw new Error('集合视图格式无效');
  }
  const folderOnly = collection.placement === 'folder' && fileTree
    && Object.keys(rawDomains).length === 0 && rawViews.items.length === 0
    && Object.keys(defaultsByKey).length === 0;
  if (folderOnly) {
    return {
      collection,
      payload: {
        schema_version: 3,
        file_tree: true,
        domains: {},
        views: { default_by_domain: {}, items: [] },
      },
    };
  }
  if (domainKeys.length === 0 || domainKeys.length !== Object.keys(rawDomains).length
    || domainKeys.some((key) => !isRecord(rawDomains[key]))) {
    throw new Error('集合数据域无效');
  }
  if (rawViews.items.length === 0) throw new Error('集合视图格式无效');
  const viewsByDomain = new Map<CollectionDomain, HybridCollectionView[]>();
  const seenIds = new Set<string>();
  for (const view of rawViews.items) {
    if (!isRecord(view) || !hasOnlyKeys(view, ['id', 'name', 'domain', 'layout', 'filter', 'sort', 'config'])
      || typeof view.id !== 'string' || !/^view_[0-9a-f]{32}$/.test(view.id) || seenIds.has(view.id)
      || typeof view.name !== 'string' || !view.name.trim() || typeof view.layout !== 'string'
      || !isRecord(view.config) || (view.filter !== undefined && !isRecord(view.filter))
      || (view.sort !== undefined && !Array.isArray(view.sort))) {
      throw new Error('集合视图格式无效');
    }
    seenIds.add(view.id);
    if (!(COLLECTION_DOMAINS as readonly string[]).includes(String(view.domain))
      || !domainKeys.includes(view.domain as CollectionDomain)) {
      throw new Error('集合视图数据域无效');
    }
    const domain = view.domain as CollectionDomain;
    const list = viewsByDomain.get(domain) ?? [];
    list.push(view as unknown as HybridCollectionView);
    viewsByDomain.set(domain, list);
  }
  // 域存在 ⇔ 该域 views 非空，且 default_by_domain 与域键一一对应。
  if (viewsByDomain.size !== domainKeys.length
    || !domainKeys.every((key) => typeof defaultsByKey[key] === 'string')
    || Object.keys(defaultsByKey).some((key) => !domainKeys.includes(key as CollectionDomain))) {
    throw new Error('集合数据域与默认视图不匹配');
  }
  const normalizedDomains: HybridCollectionPayload['domains'] = {};
  for (const domain of domainKeys) {
    const items = (viewsByDomain.get(domain) ?? []).map(({ domain: _domain, ...rest }) => rest);
    const checkedDomain = validateV2Envelope({
      collection: { ...collection, type: DOMAIN_RUNTIME_TYPES[domain] },
      payload: {
        schema_version: 2,
        dataset: rawDomains[domain],
        views: { default_id: defaultsByKey[domain], items },
      },
    });
    normalizedDomains[domain] = checkedDomain.payload.dataset as Record<string, unknown>;
  }
  return {
    collection,
    payload: {
      schema_version: 3,
      file_tree: fileTree,
      domains: normalizedDomains,
      views: {
        default_by_domain: defaultsByKey as HybridCollectionPayload['views']['default_by_domain'],
        items: rawViews.items as unknown as HybridCollectionView[],
      },
    },
  };
}

/** 解析 v3 hybrid 集合文档（完整校验，不投影）。 */
export function parseHybridCollection(source: string): { collection: CollectionMetadata; payload: HybridCollectionPayload } {
  const value: unknown = YAML.parse(source);
  if (!isRecord(value) || !hasOnlyKeys(value, ['format', 'schema_version', 'collection', 'payload'])
    || value.format !== 'flowix.collection') throw new Error('不支持的集合文件格式或版本');
  return validateHybridEnvelope(value);
}

export function serializeHybridCollectionDocument(document: { collection: CollectionMetadata; payload: HybridCollectionPayload }): string {
  const validated = validateHybridEnvelope({ collection: { ...document.collection }, payload: document.payload });
  const checked = validateCollectionMetadata(document.collection);
  const wireCollection = {
    id: checked.id,
    type: 'hybrid',
    placement: checked.placement,
    revision: checked.revision,
    created_at: checked.created_at,
    updated_at: checked.updated_at,
    properties: checked.properties,
  };
  return YAML.stringify({ format: 'flowix.collection', schema_version: 3, collection: wireCollection, payload: validated.payload }, { lineWidth: 0, indent: 2 });
}

/** 各域视图运行时的扁平文档形态（表格 / 媒体库 / 工作文档模型共用）。 */
export interface ProjectedCollectionDocument {
  collection: CollectionMetadata;
  dataset: Record<string, unknown>;
  views: { default_id: string; items: unknown[] };
}

/** 把投影出的单类型文档写回来源。
 *  来源是 hybrid → 只替换该域并保留其余域；来源是 v1/v2 → 走原 v2 序列化。 */
export function serializeProjectedCollectionDocument(source: string, document: ProjectedCollectionDocument, domain: CollectionDomain | null): string {
  if (domain === null) {
    return serializeCollectionDocumentV2({ format: 'flowix.collection', schema_version: 2,
      collection: document.collection, payload: { schema_version: 2, dataset: document.dataset, views: document.views } });
  }
  const value: unknown = YAML.parse(source);
  if (!isRecord(value) || !hasOnlyKeys(value, ['format', 'schema_version', 'collection', 'payload'])
    || value.format !== 'flowix.collection') throw new Error('不支持的集合文件格式或版本');
  const parsed = validateHybridEnvelope(value);
  if (!parsed.payload.domains[domain]) throw new Error('集合不包含该数据域');
  const payload: HybridCollectionPayload = {
    schema_version: 3,
    file_tree: parsed.payload.file_tree,
    domains: { ...parsed.payload.domains, [domain]: document.dataset },
    views: {
      default_by_domain: { ...parsed.payload.views.default_by_domain, [domain]: document.views.default_id },
      items: [
        ...parsed.payload.views.items.filter((view) => view.domain !== domain),
        ...document.views.items.map((view) => ({ ...(view as Record<string, unknown>), domain } as unknown as HybridCollectionView)),
      ],
    },
  };
  const previousDataset = parsed.payload.domains[domain]!;
  if (domain !== 'notes' && datasetLocation(previousDataset) !== datasetLocation(document.dataset)) {
    payload.domains = { ...shareDatasetLocation(payload.domains, document.dataset), ...(payload.domains.notes ? { notes: payload.domains.notes } : {}) };
  }
  return serializeHybridCollectionDocument({
    collection: {
      ...parsed.collection,
      revision: document.collection.revision,
      updated_at: document.collection.updated_at,
    },
    payload,
  });
}

/**
 * 集合文件的**写回内容**，唯一一处决定「v2 序列化 还是 按域合并」。
 *
 * 调用方都各自持有本类型的 v2 序列化（会做类型自己的归一化），所以 `domain === null`
 * 必须走 `serialize`，不能退化成通用 v2 分支；hybrid 必须按域合并，直接 v2 序列化
 * 会把其它数据域整块抹掉。这条不变式只在这里写一次，避免 6 个调用点各写一份再漂移。
 */
export function collectionWriteContent<T>(params: {
  /** 磁盘上的现有内容（hybrid 合并的基线，保留其它域）。 */
  source: string;
  /** 本域在来源里的位置；null = v1/v2 单类型文件。 */
  domain: CollectionDomain | null;
  document: T;
  /** 本类型的 v2 序列化；hybrid 时不调用。 */
  serialize: (document: T) => string;
}): string {
  const { source, domain, document, serialize } = params;
  if (domain === null) return serialize(document);
  return serializeProjectedCollectionDocument(source, document as unknown as ProjectedCollectionDocument, domain);
}

/** 判断集合来源文本是否为 v3 hybrid 文档。需要完整 YAML 解析（无廉价探测途径），
 *  不要在热路径上对同一来源反复调用。 */
export function isHybridCollectionSource(source: string): boolean {
  const value: unknown = YAML.parse(source);
  return isRecord(value) && value.format === 'flowix.collection'
    && value.schema_version === 3 && isRecord(value.payload) && value.payload.schema_version === 3;
}

/** 判断来源中与期望集合类型对应的数据域。v1/v2 返回 null；hybrid 缺域返回 null。 */
export function collectionSourceDomain(source: string, fallback: CollectionType): CollectionDomain | null {
  const value: unknown = YAML.parse(source);
  if (!isRecord(value) || value.format !== 'flowix.collection' || !isRecord(value.payload)) return null;
  if (value.schema_version !== 3 || value.payload.schema_version !== 3) return null;
  const domain = RUNTIME_TYPE_DOMAINS[fallback];
  return isRecord(value.payload.domains) && domain in value.payload.domains ? domain : null;
}

/** Read v1 files once and normalize them into the canonical v2 document. */
export function parseCollectionDocumentV2(source: string, type?: CollectionType): CollectionDocumentV2 {
  const value: unknown = YAML.parse(source);
  if (!isRecord(value) || !hasOnlyKeys(value, ['format', 'schema_version', 'collection', 'payload'])
    || value.format !== 'flowix.collection' || !isRecord(value.payload)) throw new Error('不支持的集合文件格式或版本');
  if (value.schema_version !== value.payload.schema_version) throw new Error('不支持的集合文件格式或版本');
  if (value.schema_version === 1 && value.payload.schema_version === 1) {
    if (!isRecord(value.collection)) throw new Error('旧集合身份数据无效');
    const legacyCollection = value.collection;
    const collection = validateCollectionMetadata({
      id: legacyCollection.id, type: legacyCollection.type, placement: legacyCollection.placement,
      name: legacyCollection.name, revision: legacyCollection.revision, created_at: legacyCollection.created_at,
      updated_at: legacyCollection.updated_at, properties: legacyCollection.properties ?? {},
    }, type);
    if (collection.type === 'work_documents') throw new Error('不支持的集合文件格式或版本');
    const legacyKeys = collection.type === 'table' ? ['schema_version', 'table', 'records'] : ['schema_version', 'view', 'records'];
    const legacyConfig = value.payload[collection.type === 'table' ? 'table' : 'view'];
    const legacyRecords = value.payload.records;
    if (!hasOnlyKeys(value.payload, legacyKeys) || !isRecord(legacyConfig) || !isRecord(legacyRecords)
      || !hasOnlyKeys(legacyRecords, collection.type === 'table' ? ['data', 'auto_collect'] : ['data'])
      || !Array.isArray(legacyRecords.data)) throw new Error('旧集合业务数据格式无效');
    const payload = migrateLegacyPayload(collection, legacyCollection, value.payload);
    const document = { format: 'flowix.collection' as const, schema_version: 2 as const, collection,
      payload: payload as CollectionDocumentV2['payload'] };
    const validated = validateV2Envelope({ collection: { ...collection }, payload });
    return { ...document, payload: validated.payload as CollectionDocumentV2['payload'] };
  }
  if (value.schema_version === 3 && value.payload.schema_version === 3) {
    // v3 hybrid：按请求类型投影出对应数据域的 v2 视图。写回必须走
    // serializeProjectedCollectionDocument（按域合并），不得直接 v2 序列化。
    const hybrid = validateHybridEnvelope(value);
    const domain = type ? RUNTIME_TYPE_DOMAINS[type]
      : (COLLECTION_DOMAINS.find((candidate) => candidate in hybrid.payload.domains) ?? null);
    const dataset = domain === null ? undefined : hybrid.payload.domains[domain];
    if (domain === null || !dataset) throw new Error('集合不包含该数据域');
    const items = hybrid.payload.views.items
      .filter((view) => view.domain === domain)
      .map(({ domain: _domain, ...rest }) => rest);
    const collection = { ...hybrid.collection, type: DOMAIN_RUNTIME_TYPES[domain] };
    const payload = {
      schema_version: 2 as const,
      dataset,
      views: { default_id: hybrid.payload.views.default_by_domain[domain], items },
    };
    const validated = validateV2Envelope({ collection, payload });
    return { format: 'flowix.collection' as const, schema_version: 2 as const, collection,
      payload: validated.payload as CollectionDocumentV2['payload'] };
  }
  if (value.schema_version === 2 && value.payload.schema_version === 2) {
    // v2 集合文件不存 name：后端 `CollectionMetadata.name` 是标注了
    // "Deprecated compatibility field" 的 `skip_serializing` 字段，名字一律从
    // 集合路径派生（见 collectionDisplayName）。
    //
    // 解析时必须丢掉它：序列化器本来就不写 name，如果解析保留、序列化丢弃，
    // "解析 → 序列化 → 再解析"就会悄悄把它抹掉，往返不再稳定。
    const v2Source = isRecord(value.collection) ? value.collection : {};
    const { name: _legacyName, ...v2Metadata } = v2Source;
    const collection = validateCollectionMetadata(v2Metadata, type);
    const document = { format: 'flowix.collection' as const, schema_version: 2 as const, collection,
      payload: value.payload as CollectionDocumentV2['payload'] };
    const validated = validateV2Envelope({ collection: { ...collection }, payload: value.payload });
    return { ...document, payload: validated.payload as CollectionDocumentV2['payload'] };
  }
  throw new Error('不支持的集合文件格式或版本');
}

export function isLegacyCollectionSource(source: string): boolean {
  const value: unknown = YAML.parse(source);
  return isRecord(value) && value.format === 'flowix.collection' && value.schema_version === 1;
}

function tableFilterFromLegacyRuntime(condition: unknown): { all: Record<string, unknown>[]; any: Record<string, unknown>[] } | null {
  if (!isRecord(condition)) return null;
  const file = isRecord(condition.file_condition) ? condition.file_condition : {};
  const criteria: Record<string, unknown>[] = [];
  if (typeof file.file_name_contains === 'string' && file.file_name_contains) criteria.push({ field: 'file_name', op: 'contains', value: file.file_name_contains });
  if (file.file_type === 'markdown') criteria.push({ field: 'kind', op: 'eq', value: 'note' });
  const pathRules = typeof file.path_contains === 'string' && file.path_contains
    ? [{ field: 'path', op: 'contains', value: file.path_contains }]
    : [];
  const properties = Array.isArray(condition.property_conditions) ? condition.property_conditions.filter(isRecord).map((property) => ({
    field: typeof property.field_id === 'string' ? property.field_id.trim() : property.field_id,
    op: property.operator === 'contains' || property.operator === 'gt' || property.operator === 'lt'
      ? property.operator
      : 'eq',
    value: typeof property.value === 'string' ? property.value.trim() : property.value,
  })) : [];
  if (!properties.length && !criteria.length && !pathRules.length) return null;
  if (condition.property_match === 'intersection' && properties.length) {
    if (criteria.length) return { all: pathRules, any: [{ all: properties, any: [] }, ...criteria] };
    return { all: [...pathRules, ...properties], any: [] };
  }
  return { all: pathRules, any: [...properties, ...criteria] };
}

function mediaFilterFromLegacyRuntime(condition: unknown): { all: Record<string, unknown>[]; any: Record<string, unknown>[] } {
  if (!isRecord(condition)) return { all: [], any: [] };
  const file = isRecord(condition.file_condition) ? condition.file_condition : condition;
  const criteria: Record<string, unknown>[] = [];
  if (typeof file.file_name_contains === 'string' && file.file_name_contains) criteria.push({ field: 'file_name', op: 'contains', value: file.file_name_contains });
  if (typeof file.file_type === 'string' && file.file_type) criteria.push({ field: 'kind', op: 'eq', value: file.file_type });
  if (typeof file.path_contains === 'string' && file.path_contains) criteria.push({ field: 'path', op: 'contains', value: file.path_contains });
  return { all: criteria, any: [] };
}

/** Convert legacy v1 business data to the v2 dataset and views model. */
function migrateLegacyPayload(collection: CollectionMetadata, legacy: Record<string, unknown>, payload: Record<string, unknown>): Record<string, unknown> {
  const source = isRecord(legacy.source) ? legacy.source : collection.placement === 'folder'
    ? { scope: 'containing_folder' }
    : { scope: 'notebook' };
  const oldViewSettings = isRecord(legacy.viewSettings) ? legacy.viewSettings : {};
  const viewSetting = (id: unknown): { name?: string; filter?: Record<string, unknown>; sort?: unknown[]; config?: Record<string, unknown> } => {
    const entry = typeof id === 'string' ? oldViewSettings[id] : undefined;
    if (!isRecord(entry)) return {};
    return {
      ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
      ...(isRecord(entry.filter) ? { filter: entry.filter } : {}),
      ...(Array.isArray(entry.sort) ? { sort: entry.sort } : {}),
      ...(isRecord(entry.config) ? { config: entry.config } : {}),
    };
  };
  const oldExcludes = Array.isArray(legacy.datasetExcludeRecords)
    ? legacy.datasetExcludeRecords.filter(isRecord)
    : [];
  if (collection.type === 'table') {
    const table = isRecord(payload.table) ? payload.table : {};
    const records = isRecord(payload.records) ? payload.records : {};
    const data = Array.isArray(records.data) ? records.data as Record<string, unknown>[] : [];
    const auto = isRecord(records.auto_collect) ? records.auto_collect : null;
    const tableViews = Array.isArray(table.views) ? table.views.filter(isRecord) : [];
    const excluded = [
      ...oldExcludes.map((record) => record.note_path),
      ...(Array.isArray(auto?.excluded_note_paths) ? auto.excluded_note_paths : []),
    ].filter((path): path is string => typeof path === 'string' && Boolean(path));
    return {
      schema_version: 2,
      dataset: {
        source,
        schema: { primary_field_id: table.primary_field_id, fields: table.fields ?? [] },
        records: {
          include: data.map(({ id, updated_at, note_path }) => ({ id, updated_at, note_path })),
          exclude: [...new Set(excluded)].map((note_path) => ({ note_path })),
        },
        filter: legacy.datasetActive === false ? null
          : isRecord(legacy.datasetFilter) ? legacy.datasetFilter
            : auto ? tableFilterFromLegacyRuntime(auto.condition) : null,
      },
      views: {
        default_id: tableViews.some((view) => view.id === legacy.defaultViewId) ? legacy.defaultViewId : tableViews[0]?.id,
        items: tableViews.map((view) => ({
          id: view.id, name: view.name, layout: view.type,
          filter: viewSetting(view.id).filter ?? { all: [], any: [] },
          sort: viewSetting(view.id).sort ?? [{ field: 'modified_at', direction: 'desc' }],
          config: view.config ?? {},
        })),
      },
    };
  }
  const view = isRecord(payload.view) ? payload.view : {};
  const records = isRecord(payload.records) ? payload.records : {};
  const data = Array.isArray(records.data) ? records.data as Record<string, unknown>[] : [];
  const legacyMediaFilter = mediaFilterFromLegacyRuntime(view.condition);
  return {
    schema_version: 2,
    dataset: {
      source,
      schema: { fields: [] },
      records: {
        include: data.map(({ id, updated_at, resource_id, note_path }) => ({ id, updated_at, resource_id: resource_id ?? `path:${note_path}`, relative_path: note_path })),
        exclude: oldExcludes,
      },
      filter: isRecord(legacy.datasetFilter) ? legacy.datasetFilter
        : (legacyMediaFilter.all.length ? legacyMediaFilter : null),
    },
    views: {
      default_id: typeof legacy.defaultViewId === 'string' ? legacy.defaultViewId : view.id,
      items: [{
        id: view.id,
        name: viewSetting(view.id).name ?? '图墙',
        layout: view.layout,
        filter: viewSetting(view.id).filter ?? legacyMediaFilter,
        sort: viewSetting(view.id).sort ?? [view.sort ?? { field: 'created_at', direction: 'desc' }],
        config: viewSetting(view.id).config ?? {},
      }, ...(Array.isArray(legacy.nonActiveViews) ? legacy.nonActiveViews.filter(isRecord) : [])],
    },
  };
}

export function serializeCollectionDocumentV2(document: CollectionDocumentV2): string {
  if (document.format !== 'flowix.collection' || document.schema_version !== 2) throw new Error('集合文件版本无效');
  const validated = validateV2Envelope({ collection: { ...document.collection }, payload: document.payload });
  const checked = validateCollectionMetadata(document.collection);
  const wireCollection = {
    id: checked.id,
    type: checked.type === 'table' ? 'notes' : checked.type === 'media_library' ? 'media' : 'work_documents',
    placement: checked.placement,
    revision: checked.revision,
    created_at: checked.created_at,
    updated_at: checked.updated_at,
    properties: checked.properties,
  };
  return YAML.stringify({ format: 'flowix.collection', schema_version: 2, collection: wireCollection, payload: validated.payload }, { lineWidth: 0, indent: 2 });
}
export function reviseCollection(collection: CollectionMetadata): CollectionMetadata {
  return { ...collection, revision: collection.revision + 1, updated_at: new Date().toISOString() };
}
