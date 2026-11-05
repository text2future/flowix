import YAML from 'yaml';

import { collections, externalDocuments, files, memos, notebooks, notes, system, tags } from '@platform/tauri/client';
import type { NotebookBackgroundStatus } from '@platform/tauri/client';

/**
 * Data bridge between embedded local HTML previews and the notebook.
 *
 * Sandboxed preview iframes (opaque origin) cannot invoke Tauri commands, so
 * they ask the host through `flowix:local-html-data-request` postMessages.
 * The host resolves whitelisted kinds here and answers with plain JSON
 * aggregates only — no absolute paths, no raw YAML, no file access grants.
 */

export type HtmlDataKind =
  | 'notebook-stats'
  | 'notebook-views'
  | 'notebook-custom-views'
  | 'view-data'
  | 'product-theme';

export const HTML_DATA_KINDS: readonly HtmlDataKind[] = [
  'notebook-stats',
  'notebook-views',
  'notebook-custom-views',
  'view-data',
  'product-theme',
];

export interface HtmlDataContext {
  notebookId: string;
  /** Notebook root used as the authorized read scope for collection files. */
  scopePath: string | null;
  /** Current app palette, captured by the preview host for this request. */
  productTheme?: HtmlProductTheme;
}

export interface HtmlProductTheme {
  id: string | null;
  tokens: {
    background: string;
    foreground: string;
    secondaryForeground: string;
    mutedForeground: string;
    border: string;
    brand: string;
    card: string;
  };
}

export interface HtmlDataTagCount {
  name: string;
  count: number;
  /** Ready-to-bind CSS width (share of the largest tag), e.g. "62%". */
  barWidth: string;
}

export interface HtmlDataStats {
  notebookId: string;
  totalMemos: number;
  agentMemos: number;
  todoMemos: number;
  /** Total notes from the notebook index; null while the index is unknown. */
  memoCount: number | null;
  topTags: HtmlDataTagCount[];
}

export interface HtmlDataCollectionView {
  id: string;
  name: string;
  layout: string;
}

export interface HtmlDataCollection {
  name: string;
  type: string;
  relativePath: string;
  inViews: boolean;
  identityConflict: boolean;
  viewsAvailable: boolean;
  defaultViewId: string | null;
  views: HtmlDataCollectionView[];
}

export interface HtmlDataViews {
  collections: HtmlDataCollection[];
}

const MAX_COLLECTIONS = 50;
const MAX_VIEWS_PER_COLLECTION = 20;
const MAX_TOP_TAGS = 20;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;

/** Notebook-wide memo/tag aggregates for dashboards inside HTML previews. */
async function resolveNotebookStats(ctx: HtmlDataContext): Promise<HtmlDataStats> {
  const [usage, statuses, tagList] = await Promise.all([
    memos.getUsedTagIds(ctx.notebookId),
    notebooks.getBackgroundStatus(),
    tags.getAll(ctx.notebookId).catch(() => ({ tags: [] as { id: string; name: string }[] })),
  ]);
  const names = new Map(tagList.tags.map((tag: { id: string; name: string }) => [tag.id, tag.name]));
  const sorted = [...usage.tagCounts].sort((a, b) => b.count - a.count).slice(0, MAX_TOP_TAGS);
  const maxCount = sorted[0]?.count ?? 0;
  const topTags = sorted.map((entry) => ({
    name: names.get(entry.tagId) ?? entry.tagId,
    count: entry.count,
    barWidth: maxCount > 0 ? `${Math.max(2, Math.round((entry.count / maxCount) * 100))}%` : '0%',
  }));
  const status = statuses.find((item: NotebookBackgroundStatus) => item.notebookId === ctx.notebookId);
  return {
    notebookId: ctx.notebookId,
    totalMemos: usage.totalMemoCount,
    agentMemos: usage.agentMemoCount,
    todoMemos: usage.todoMemoCount,
    memoCount: typeof status?.memoCount === 'number' ? status.memoCount : null,
    topTags,
  };
}

/** Collection entries of the notebook with their declarative view summaries. */
async function resolveNotebookViews(ctx: HtmlDataContext): Promise<HtmlDataViews> {
  const entries = (await collections.list(ctx.notebookId))
    .filter((entry) => entry.collectionId !== null)
    .slice(0, MAX_COLLECTIONS);
  const root = ctx.scopePath?.replace(/[\\/]+$/, '') ?? '';
  const list = await Promise.all(entries.map(async (entry): Promise<HtmlDataCollection> => {
    const base: HtmlDataCollection = {
      name: entry.name,
      type: entry.collectionType,
      relativePath: entry.relativePath,
      inViews: entry.inViews,
      identityConflict: entry.identityConflict,
      viewsAvailable: false,
      defaultViewId: null,
      views: [],
    };
    if (!root) return base;
    try {
      const content = await externalDocuments.read(`${root}/${entry.relativePath}`, root);
      const parsed: unknown = YAML.parse(content);
      const viewsBlock = isRecord(parsed) && isRecord(parsed.payload) && isRecord(parsed.payload.views)
        ? parsed.payload.views
        : null;
      const items = Array.isArray(viewsBlock?.items) ? viewsBlock.items : [];
      const views = items.filter(isRecord).slice(0, MAX_VIEWS_PER_COLLECTION)
        .map((view): HtmlDataCollectionView => ({
          id: asText(view.id) ?? '',
          name: asText(view.name) ?? '',
          layout: asText(view.layout) ?? '',
        }));
      return {
        ...base,
        viewsAvailable: true,
        defaultViewId: asText(viewsBlock?.default_id),
        views,
      };
    } catch {
      // Unreadable or invalid collection files degrade to an empty view list.
      return base;
    }
  }));
  return { collections: list };
}

/** Notebook custom view filters (`<notebook>/.flowix/system.json`). */
async function resolveNotebookCustomViews(ctx: HtmlDataContext): Promise<unknown> {
  const data = await system.getCustomViews(ctx.notebookId);
  return { filters: Array.isArray(data.filters) ? data.filters : [] };
}

export interface HtmlViewDataParams {
  /** Notebook-relative collection file, e.g. "docs.index.yaml" or "计划表.table.yaml". */
  relativePath: string;
  /** Optional view id inside the collection; existence is validated. */
  viewId?: string;
  /** Row cap, 1..MAX_VIEW_ROWS, default 50. */
  limit?: number;
}

export interface HtmlViewDataField {
  id: string;
  name: string;
  type: string;
  /** Frontmatter property key backing this field (maps to row.properties). */
  propertyKey: string | null;
}

export interface HtmlViewDataRow {
  id: string;
  notePath: string;
  title: string;
  updatedAt: number | null;
  tags: string[];
  properties: Record<string, string | number | boolean | string[]>;
}

export interface HtmlViewData {
  collection: { name: string; type: string; relativePath: string };
  viewId: string | null;
  /** Column definitions for dataset collections; empty for folder listings. */
  fields: HtmlViewDataField[];
  rows: HtmlViewDataRow[];
  truncated: boolean;
}

const MAX_VIEW_ROWS = 200;

function sanitizeProperties(value: unknown): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  if (!isRecord(value)) return out;
  for (const [key, item] of Object.entries(value)) {
    if (Object.keys(out).length >= 32) break;
    if (typeof item === 'string') out[key] = item.slice(0, 256);
    else if (typeof item === 'number' || typeof item === 'boolean') out[key] = item;
    else if (Array.isArray(item) && item.every((entry) => typeof entry === 'string')) {
      out[key] = (item as string[]).slice(0, 16).map((entry) => entry.slice(0, 128));
    }
  }
  return out;
}

/**
 * Rows behind one collection view, addressed by the collection file (the
 * "unique info" of a view is collection file + view id — view ids alone are
 * only unique inside one file). Dataset collections (tables / media libraries)
 * resolve records against the note index, so rows carry titles, tags and the
 * frontmatter properties backing each field. Folder collections fall back to
 * the authorized document page of their directory.
 */
async function resolveViewData(
  ctx: HtmlDataContext,
  rawParams: Record<string, unknown> | null,
): Promise<HtmlViewData> {
  const relativePath = asText(rawParams?.relativePath);
  const segments = relativePath?.split(/[\\/]/) ?? [];
  if (!relativePath || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('invalid relativePath');
  }
  const root = ctx.scopePath?.replace(/[\\/]+$/, '');
  if (!root) throw new Error('notebook scope unavailable');
  const viewId = asText(rawParams?.viewId);
  const limitParam = Number(rawParams?.limit);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.trunc(limitParam), 1), MAX_VIEW_ROWS) : 50;

  const parsed: unknown = YAML.parse(await externalDocuments.read(`${root}/${relativePath}`, root));
  const payload = isRecord(parsed) && isRecord(parsed.payload) ? parsed.payload : null;
  if (!payload) throw new Error('invalid collection document');
  if (viewId) {
    const viewsBlock = isRecord(payload.views) ? payload.views : null;
    const items = Array.isArray(viewsBlock?.items) ? viewsBlock.items : [];
    if (!items.some((item) => isRecord(item) && item.id === viewId)) throw new Error('view not found');
  }
  const collection = { name: '', type: '', relativePath };
  const dataset = isRecord(payload.dataset) ? payload.dataset : null;
  const include = dataset && isRecord(dataset.records) && Array.isArray(dataset.records.include)
    ? dataset.records.include
    : null;

  if (include) {
    const rawFields = dataset && isRecord(dataset.schema) && Array.isArray(dataset.schema.fields)
      ? dataset.schema.fields
      : [];
    const fields: HtmlViewDataField[] = rawFields.filter(isRecord).slice(0, 32)
      .map((field) => ({
        id: asText(field.id) ?? '',
        name: asText(field.name) ?? '',
        type: asText(field.type) ?? '',
        propertyKey: asText(field.property_key),
      }));
    const entries = await notes.list(ctx.notebookId).catch(() => []);
    const byPath = new Map(entries.map((entry) => [entry.relativePath.replace(/\\/g, '/'), entry]));
    const records = include.filter(isRecord).slice(0, limit);
    const rows: HtmlViewDataRow[] = records.map((record) => {
      const notePath = asText(record.note_path) ?? '';
      const entry = byPath.get(notePath.replace(/\\/g, '/'));
      return {
        id: asText(record.id) ?? '',
        notePath,
        title: entry?.title ?? '',
        updatedAt: typeof entry?.updatedAt === 'number' ? entry.updatedAt : null,
        tags: Array.isArray(entry?.tags)
          ? entry.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 12)
          : [],
        properties: sanitizeProperties(entry?.properties),
      };
    });
    return { collection, viewId: viewId ?? null, fields, rows, truncated: include.length > records.length };
  }

  // Folder collection: the view data is the documents inside its directory.
  const directory = segments.slice(0, -1).join('/');
  const page = await files.listDocumentPage({
    notebookId: ctx.notebookId,
    folderPath: directory ? `${root}/${directory}` : root,
    cursor: null,
    limit,
  });
  const rows = [...page.folders, ...page.items].slice(0, limit).map((item) => ({
    id: '',
    notePath: item.fullPath.startsWith(`${root}/`) ? item.fullPath.slice(root.length + 1) : item.name,
    title: item.name,
    updatedAt: item.modifiedMs,
    tags: [] as string[],
    properties: {},
  }));
  return { collection, viewId: viewId ?? null, fields: [], rows, truncated: page.hasMore };
}

export function resolveHtmlDataRequest(
  kind: HtmlDataKind,
  ctx: HtmlDataContext,
  params: Record<string, unknown> | null = null,
): Promise<unknown> {
  switch (kind) {
    case 'notebook-stats': return resolveNotebookStats(ctx);
    case 'notebook-views': return resolveNotebookViews(ctx);
    case 'notebook-custom-views': return resolveNotebookCustomViews(ctx);
    case 'view-data': return resolveViewData(ctx, params);
    case 'product-theme':
      return ctx.productTheme
        ? Promise.resolve(ctx.productTheme)
        : Promise.reject(new Error('product theme unavailable'));
  }
}
