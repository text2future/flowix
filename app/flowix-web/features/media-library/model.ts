import { createCollectionMetadata, createUuidV7, parseCollectionDocumentV2, serializeCollectionDocumentV2, type CollectionMetadata, type CollectionSource } from '@features/collection/model';
import { createUniqueNotebookFile } from '@features/collection/create-unique-notebook-file';
export { createUuidV7 } from '@features/collection/model';
import { sanitizeFileName } from '@/lib/export-utils';
import { ASSET_KINDS, matchesAssetCollectionFilter, type AssetKind } from '@features/collection/public/asset-filter-api';
import { resolveDatasetFilterForLocation } from '@features/collection/dataset-filter-location';
import { normalizeCollectionLocation } from '@features/collection/public/dataset-filter-api';

export type MediaLibraryKind = 'image' | 'video';
export interface MediaLibraryFileCondition {
  file_name_contains?: string;
  /** 旧数据的单选类型条件；新写入统一用 `file_types`。 */
  file_type?: MediaLibraryKind;
  /** 多选类型条件：空/缺省 = 面板类目内全部（图+视频）。落盘为 kind 的 `in` 规则。 */
  file_types?: MediaLibraryKind[];
  path_contains?: string;
  path_scope?: 'all';
}

export interface MediaLibraryRecord {
  id: string;
  updated_at: string;
  resource_id: string;
  /** Notebook-relative path to an explicitly linked media file. */
  relative_path: string;
}

/** Empty filter containers do not opt a standalone media library into notebook-wide browsing. */
export function hasMediaDatasetFilter(filter: Record<string, unknown> | null | undefined): boolean {
  if (!filter) return false;
  if (Array.isArray(filter.conditions) && (filter.match === 'all' || filter.match === 'any')) {
    return typeof filter.path === 'string' || filter.conditions.length > 0;
  }
  const all = Array.isArray(filter.all) ? filter.all : [];
  const any = Array.isArray(filter.any) ? filter.any : [];
  return all.length > 0 || any.length > 0;
}

export function normalizeMediaLibraryFileCondition(condition?: MediaLibraryFileCondition | null): MediaLibraryFileCondition {
  const fileTypes = (condition?.file_types ?? (condition?.file_type ? [condition.file_type] : []))
    .filter((kind): kind is MediaLibraryKind => kind === 'image' || kind === 'video');
  // 去重 + 保持类目顺序，选满两类时等价于全部 → 不写条件。
  const ordered = [...new Set(fileTypes)].sort((left, right) => (left === 'image' ? -1 : 1) - (right === 'image' ? -1 : 1));
  const normalized = {
    file_name_contains: condition?.file_name_contains?.trim() ?? '',
    file_types: ordered.length && ordered.length < 2 ? ordered : undefined,
    path_contains: condition?.path_contains?.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') ?? '',
    path_scope: condition?.path_scope === 'all' ? 'all' : '',
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value)) as MediaLibraryFileCondition;
}

export function mediaCollectionFilterFromCondition(condition?: MediaLibraryFileCondition | null): Record<string, unknown> {
  const normalized = normalizeMediaLibraryFileCondition(condition);
  const conditions: Record<string, unknown>[] = [];
  if (normalized.file_name_contains) conditions.push({ field: 'file_name', op: 'contains', value: normalized.file_name_contains });
  if (normalized.file_types?.length) conditions.push({ field: 'kind', op: 'in', value: normalized.file_types });
  else if (normalized.file_type) conditions.push({ field: 'kind', op: 'eq', value: normalized.file_type });
  return {
    path: normalized.path_scope === 'all' ? '' : normalized.path_contains || null,
    match: 'all',
    conditions,
  };
}

export function matchesMediaCollectionFilter(relativePath: string, kind: MediaLibraryKind, filter?: Record<string, unknown> | null): boolean {
  return matchesAssetCollectionFilter(relativePath, kind, filter);
}

export interface MediaLibraryDocument {
  collection: CollectionMetadata;
  dataset: {
    source: CollectionSource;
    schema: { fields: [] };
    records: { include: MediaLibraryRecord[]; exclude: Array<{ relative_path: string }> };
    filter: Record<string, unknown> | null;
  };
  views: {
    default_id: string;
    items: Array<{
      id: string;
      name: string;
      layout: 'waterfall';
      filter: Record<string, unknown>;
      sort: Array<{ field: 'created_at'; direction: 'desc' }>;
      config: Record<string, unknown>;
    }>;
  };
}

export function mediaLibraryDefaultView(document: MediaLibraryDocument) {
  return document.views.items.find((view) => view.id === document.views.default_id)!;
}

export function mediaLibraryFileCondition(document: MediaLibraryDocument): MediaLibraryFileCondition {
  const filter = document.dataset.filter;
  if (!filter) return {};
  const condition: MediaLibraryFileCondition = {};
  let rules: unknown[];
  if (Array.isArray(filter.conditions) && (filter.match === 'all' || filter.match === 'any')) {
    rules = filter.conditions;
    if (filter.path === '') condition.path_scope = 'all';
    else if (typeof filter.path === 'string') condition.path_contains = filter.path;
  } else if (Array.isArray(filter.all) && Array.isArray(filter.any)) {
    const anyNonPath = filter.any.filter((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry) || entry.field !== 'path');
    if (anyNonPath.length) return {};
    rules = [...filter.all, ...filter.any];
  } else {
    return {};
  }
  const pathRules = rules.filter((entry) => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)
    && (entry as Record<string, unknown>).field === 'path')) as Record<string, unknown>[];
  if (pathRules.length) {
    const nonEmptyPaths = pathRules.map((rule) => typeof rule.value === 'string' ? rule.value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : '').filter(Boolean);
    condition.path_scope = nonEmptyPaths.length ? undefined : 'all';
    if (nonEmptyPaths.length) condition.path_contains = nonEmptyPaths.sort((left, right) => right.length - left.length)[0];
  }
  for (const entry of rules) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rule = entry as Record<string, unknown>;
    if (rule.field === 'file_name' && rule.op === 'contains' && typeof rule.value === 'string') condition.file_name_contains = rule.value;
    if (rule.field === 'kind' && rule.op === 'eq' && (rule.value === 'image' || rule.value === 'video')) condition.file_type = rule.value;
    if (rule.field === 'kind' && rule.op === 'in' && Array.isArray(rule.value)) {
      const kinds = rule.value.filter((value): value is MediaLibraryKind => value === 'image' || value === 'video');
      if (kinds.length === 1) condition.file_type = kinds[0];
      else if (kinds.length === 2) condition.file_types = kinds;
    }
  }
  return condition;
}

export function canEditMediaLibraryFilter(document: MediaLibraryDocument): boolean {
  const filter = document.dataset.filter;
  if (!filter) return true;
  if (Array.isArray(filter.conditions) && filter.match === 'all') {
    const conditions = filter.conditions as Record<string, unknown>[];
    const fields = conditions.map((rule) => rule.field);
    return new Set(fields).size === fields.length && conditions.every((rule) => (
      (rule.field === 'file_name' && rule.op === 'contains' && typeof rule.value === 'string')
      || (rule.field === 'kind' && rule.op === 'eq' && (rule.value === 'image' || rule.value === 'video'))
      || (rule.field === 'kind' && rule.op === 'in' && Array.isArray(rule.value)
        && rule.value.length > 0
        && rule.value.every((value) => ASSET_KINDS.includes(value as AssetKind)))
    ));
  }
  const all = Array.isArray(filter.all) ? filter.all as Record<string, unknown>[] : null;
  const any = Array.isArray(filter.any) ? filter.any as Record<string, unknown>[] : null;
  // The compact media editor represents conjunctions and one value per field.
  // OR branches or duplicate scalar rules cannot be written back losslessly.
  if (!all || !any || any.length > 0) return false;
  const rules = all;
  const pathRules = rules.filter((rule) => rule.field === 'path');
  const scalarRules = rules.filter((rule) => rule.field !== 'path');
  if (new Set(scalarRules.map((rule) => rule.field)).size !== scalarRules.length) return false;
  const paths = [...new Set(pathRules.map((rule) => typeof rule.value === 'string'
    ? rule.value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : null))];
  if (pathRules.some((rule) => rule.op !== 'contains' || typeof rule.value !== 'string')
    || paths.includes(null)) return false;
  const nonEmptyPaths = paths.filter((path): path is string => Boolean(path));
  if (nonEmptyPaths.some((path) => nonEmptyPaths.some((other) => path !== other
    && !path.startsWith(`${other}/`) && !other.startsWith(`${path}/`)))) return false;
  return rules.every((rule) => (
    (rule.field === 'path' && rule.op === 'contains' && typeof rule.value === 'string')
    || (rule.field === 'file_name' && rule.op === 'contains' && typeof rule.value === 'string')
    || (rule.field === 'kind' && rule.op === 'eq' && (rule.value === 'image' || rule.value === 'video'))
    || (rule.field === 'kind' && rule.op === 'in' && Array.isArray(rule.value)
      && rule.value.length === 2 && rule.value.includes('image') && rule.value.includes('video'))
  ));
}

export function createMediaLibraryRecord(notebookId: string, relativePath: string, resourceId?: string, now = new Date().toISOString()): MediaLibraryRecord {
  const path = relativePath.replace(/\\/g, '/');
  return { id: `rec_${createUuidV7()}`, updated_at: now, resource_id: resourceId ?? `${notebookId}::${path}`, relative_path: path };
}

/** Called against each current document, including conflict retries. */
export function mediaCollectionFilterForSave(document: MediaLibraryDocument, condition: MediaLibraryFileCondition, filePath: string, notebookPath: string): Record<string, unknown> | null {
  if (!canEditMediaLibraryFilter(document)) throw new Error('当前媒体库包含编辑器不支持的筛选，已取消保存');
  const normalized = normalizeMediaLibraryFileCondition(condition);
  const filter = document.collection.placement === 'folder' || Object.keys(normalized).length
    ? mediaCollectionFilterFromCondition(normalized) : null;
  return resolveDatasetFilterForLocation(filter, document.collection.placement, filePath, notebookPath);
}

export function createMediaLibrary(name: string): MediaLibraryDocument {
  const viewId = `view_${createUuidV7()}`;
  return {
    collection: createCollectionMetadata('media_library', name),
    dataset: {
      source: { scope: 'notebook' },
      schema: { fields: [] }, records: { include: [], exclude: [] },
      filter: null,
    },
    views: { default_id: viewId, items: [{ id: viewId, name: '图墙', layout: 'waterfall',
      filter: { all: [], any: [] }, sort: [{ field: 'created_at', direction: 'desc' }], config: {} }] },
  };
}

export function serializeMediaLibrary(document: MediaLibraryDocument): string {
  return serializeCollectionDocumentV2({ format: 'flowix.collection', schema_version: 2,
    collection: document.collection, payload: { schema_version: 2, dataset: document.dataset, views: document.views } });
}

export function parseMediaLibrary(source: string): MediaLibraryDocument {
  const document = parseCollectionDocumentV2(source, 'media_library');
  return normalizeCollectionLocation({ collection: document.collection, dataset: document.payload.dataset as unknown as MediaLibraryDocument['dataset'],
    views: document.payload.views as unknown as MediaLibraryDocument['views'] });
}

export async function createMediaLibraryFile(
  notebookPath: string,
  relativeFolder: string | null | undefined,
  name: string,
): Promise<{ filePath: string; document: MediaLibraryDocument }> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('请输入媒体库名称');
  const stem = sanitizeFileName(trimmedName).replace(/(?:\.lib\.ya?ml|\.index\.yaml)$/i, '');
  if (!stem) throw new Error('媒体库名称无效');
  const document = createMediaLibrary(stem);
  const { filePath } = await createUniqueNotebookFile(
    notebookPath,
    relativeFolder,
    stem,
    '.index.yaml',
    serializeMediaLibrary(document),
  );
  return { filePath, document };
}
