import type { CollectionDomain } from './model';

type Dataset = Record<string, unknown>;
type Domains = Partial<Record<CollectionDomain, Dataset>>;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Location is shared; each domain retains its own secondary conditions. */
export function datasetLocation(dataset: Dataset): string | null {
  const filter = dataset.filter;
  if (!record(filter)) return null;
  if (typeof filter.path === 'string') return filter.path;
  const pathRule = Array.isArray(filter.all) ? filter.all.find((rule) => record(rule) && rule.field === 'path' && rule.op === 'contains') : undefined;
  return record(pathRule) && typeof pathRule.value === 'string' ? pathRule.value : null;
}

export function withDatasetLocation(dataset: Dataset, path: string | null, source: unknown = dataset.source): Dataset {
  const filter = record(dataset.filter) ? dataset.filter : {};
  let nextFilter: Record<string, unknown>;
  if (Array.isArray(filter.conditions)) nextFilter = { ...filter, path };
  else {
    const all = Array.isArray(filter.all) ? filter.all.filter((rule) => !record(rule) || rule.field !== 'path') : [];
    const any = Array.isArray(filter.any) ? filter.any : [];
    if (any.length || [...all, ...any].some((rule) => record(rule) && ('all' in rule || 'any' in rule))) {
      // Preserve legacy boolean groups rather than flattening their meaning.
      nextFilter = { all: [...all, ...(path !== null ? [{ field: 'path', op: 'contains', value: path }] : [])], any };
    } else nextFilter = { path, match: any.length ? 'any' : 'all', conditions: any.length ? any : all };
  }
  return { ...dataset, source, filter: nextFilter };
}

export function shareDatasetLocation(domains: Domains, owner: Dataset): Domains {
  return Object.fromEntries(Object.entries(domains).map(([domain, dataset]) =>
    [domain, withDatasetLocation(dataset, datasetLocation(owner), owner.source)]));
}
