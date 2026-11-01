import { matchesDatasetFilter, type DatasetFilter } from './rule-filter';
/**
 * 共享「资料筛选」（图墙 / 列表两个资料视图同一份配置，数据层面）：
 * 用户在全类目里多选类型（图片/视频/文档…），图墙取图片视频子集、列表取其余子集。
 * 两个数据域（media / work_documents）落**同一份** filter JSON，任一面板保存即双写。
 */export const ASSET_KINDS = ['image', 'video', 'document', 'spreadsheet', 'presentation', 'web', 'archive', 'database'] as const;
export type AssetKind = typeof ASSET_KINDS[number];
/** 图墙（媒体库域）可取用的类目。 */
export const MEDIA_ASSET_KINDS: readonly AssetKind[] = ['image', 'video'];
/** 列表（工作文档域）可取用的类目。 */
export const WORK_ASSET_KINDS: readonly AssetKind[] = ['document', 'spreadsheet', 'presentation', 'web', 'archive', 'database'];

/** Secondary condition saves preserve the latest shared location on disk. */
export interface AssetFilterSaveOptions {
  updateLocation: boolean;
}

export interface AssetFilterCondition {
  file_name_contains?: string;
  /** 多选类型：空/缺省 = 全类目；落盘为 kind 的 `in` 规则。 */
  file_types?: AssetKind[];
  path_contains?: string;
  path_scope?: 'all';
}

export function normalizeAssetFilterCondition(condition?: AssetFilterCondition | null): AssetFilterCondition {
  const fileTypes = [...new Set(condition?.file_types ?? [])]
    .filter((kind): kind is AssetKind => ASSET_KINDS.includes(kind as AssetKind))
    .sort((left, right) => ASSET_KINDS.indexOf(left) - ASSET_KINDS.indexOf(right));
  const normalized = {
    file_name_contains: condition?.file_name_contains?.trim() ?? '',
    file_types: fileTypes.length && fileTypes.length < ASSET_KINDS.length ? fileTypes : undefined,
    path_contains: condition?.path_contains?.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') ?? '',
    path_scope: condition?.path_scope === 'all' ? 'all' : '',
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value)) as AssetFilterCondition;
}

/** 共享条件 → dataset.filter（图墙 / 列表两个域落同一份 JSON）。 */
export function assetFilterFromCondition(condition?: AssetFilterCondition | null): Record<string, unknown> | null {
  const normalized = normalizeAssetFilterCondition(condition);
  const conditions: Record<string, unknown>[] = [];
  if (normalized.file_name_contains) conditions.push({ field: 'file_name', op: 'contains', value: normalized.file_name_contains });
  if (normalized.file_types?.length) conditions.push({ field: 'kind', op: 'in', value: normalized.file_types });
  const path = normalized.path_scope === 'all' ? '' : normalized.path_contains || null;
  if (path === null && conditions.length === 0) return null;
  return { path, match: 'all', conditions };
}

/** dataset.filter → 共享条件（兼容旧的单选 kind eq 规则与 v1/v2 的 all/any 形状）。 */
export function assetConditionFromFilter(filter?: Record<string, unknown> | null): AssetFilterCondition {
  if (!filter) return {};
  const result: AssetFilterCondition = {};
  let rules: unknown[] = [];
  if (Array.isArray(filter.conditions) && filter.match === 'all') {
    if (filter.path === '') result.path_scope = 'all';
    else if (typeof filter.path === 'string') result.path_contains = filter.path;
    rules = filter.conditions;
  } else if (Array.isArray(filter.all) && Array.isArray(filter.any)) {
    rules = [...filter.all, ...filter.any];
  } else {
    return {};
  }
  for (const entry of rules) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rule = entry as Record<string, unknown>;
    if (rule.field === 'file_name' && rule.op === 'contains' && typeof rule.value === 'string') result.file_name_contains = rule.value;
    if (rule.field === 'kind' && rule.op === 'eq' && ASSET_KINDS.includes(rule.value as AssetKind)) result.file_types = [rule.value as AssetKind];
    if (rule.field === 'kind' && rule.op === 'in' && Array.isArray(rule.value)) {
      const kinds = rule.value.filter((value): value is AssetKind => ASSET_KINDS.includes(value as AssetKind));
      if (kinds.length) result.file_types = kinds;
    }
  }
  return result;
}

/** 某个面板（类目 universe）从共享条件里取用的类型子集；空 = 该面板无内容可展示。 */
export function assetKindsForUniverse(condition: AssetFilterCondition, universe: readonly AssetKind[]): AssetKind[] {
  const selected = condition.file_types ?? [...ASSET_KINDS];
  return [...new Set(selected.filter((kind) => universe.includes(kind)))];
}

/** Match one asset against a view-level filter, independently of the shared dataset filter. */
export function matchesAssetCollectionFilter(relativePath: string, kind: string, filter?: Record<string, unknown> | null): boolean {
  if (!filter) return true;
  const path = relativePath.replace(/\\/g, '/');
  const name = path.split('/').pop() ?? path;
  const directory = path.split('/').slice(0, -1).join('/');
  return matchesDatasetFilter(filter as unknown as DatasetFilter, (rule) => {
    const actual = rule.field === 'file_name' ? name : rule.field === 'path' ? directory : rule.field === 'kind' ? kind : undefined;
    if (actual === undefined) return false;
    if (rule.op === 'in' && Array.isArray(rule.value)) return rule.value.some((value) => String(value).toLocaleLowerCase() === actual.toLocaleLowerCase());
    if ((rule.op === 'eq' || rule.op === 'equals') && rule.value != null) return actual.toLocaleLowerCase() === String(rule.value).toLocaleLowerCase();
    if (rule.op !== 'contains' || typeof rule.value !== 'string') return false;
    const expected = rule.value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase();
    const value = actual.toLocaleLowerCase();
    if (rule.field === 'path' && expected === '') return true;
    return rule.field === 'path' ? value === expected || value.startsWith(`${expected}/`) : value.includes(expected);
  });
}
