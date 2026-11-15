import YAML from 'yaml';

import { collections, externalDocuments, files, memos, notebooks, notes, system, tags } from '@platform/tauri/client';
import type { CollectionIndexItem, DocumentPage, DocumentPageItem, NoteEntry, NotebookBackgroundStatus } from '@platform/tauri/client';
import { assetConditionFromFilter, assetKindsForUniverse, matchesAssetCollectionFilter, WORK_ASSET_KINDS } from '@features/collection/public/asset-filter-api';
import { resolveCollectionLocationScope } from '@features/collection/public/folder-api';
import { COLLECTION_DOMAINS, collectionDomainType, type CollectionDomain } from '@features/collection/public/hybrid-api';
import { parseTableDocument, type MultidimensionalTableDocument } from '@features/multidimensional-table/public/create-api';
import { collectionDatasetRecords, collectionViewRecords } from '@features/multidimensional-table/public/records-api';
import { parseWorkDocumentsCollection, type WorkDocumentsDocument } from '@features/collection/public/work-documents-model-api';
import { HTML_EMBED_MAX_VIEW_ROWS, HtmlEmbedError, type HtmlDataKind, type HtmlEmbedFieldType } from '@/lib/html-embed-api';
import { createLogger } from '@/lib/logger';
import { canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { resolveDocumentRelativeHref } from '@/lib/document-relative-path';

export { HTML_DATA_KINDS } from '@/lib/html-embed-api';
export type { HtmlDataKind };

const logger = createLogger('html-data-bridge');

/**
 * Data bridge between embedded local HTML previews and the notebook.
 *
 * Sandboxed preview iframes (opaque origin) cannot invoke Tauri commands, so
 * they ask the host through `flowix:local-html-data-request` postMessages.
 * The host resolves whitelisted kinds here and answers with plain JSON
 * aggregates only — no absolute paths, no raw YAML, no file access grants.
 *
 * The published capability list, protocol version and error codes live in
 * `@/lib/html-embed-api`; this file only resolves payloads. The contract that
 * pages and agents read is `docs/EMBEDDED-HTML-API.md`.
 *
 * Layout: shared plumbing (cache, path/href/row helpers) → collection readers →
 * one resolver per collection type → the `view-data` entry point. Split this
 * file when a third collection type lands or it passes ~900 lines — the three
 * readers below share row construction, so they belong together until then.
 *
 * `view-data`'s `total` has one meaning per row source (a table counts what the
 * view shows, a paged query cannot count at all). Keeping that arithmetic next
 * to the query that knows it beats threading a `kind` through one shared
 * helper, so the per-type table in the doc is the place they are compared.
 *
 * Cost: a table read is filter → sort → slice → map, i.e. one pass over the
 * notebook's notes plus a sort of the rows the view keeps. At 5 000 notes with
 * a filter matching all of them that measures ~25 ms per request, and the note
 * list itself (one cached `notes.list`) dominates. Do not "optimise" the sort
 * away by truncating early: `total` must stay exact. If this ever hurts, the
 * answer is a cursor, not a cheaper sort.
 */

export interface HtmlDataContext {
  /**
   * Owning notebook, or `null` when the page was opened outside every notebook.
   * Host-level kinds (the palette) still answer; notebook reads refuse with
   * `E_SCOPE` so the page can tell the difference.
   */
  notebookId: string | null;
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
  databaseCount: number;
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
  /**
   * `flowix://open` link that reopens this collection, or `''` when the path is
   * not a collection file. Pages put it straight into `<a href>`; without it a
   * collection card can only be rendered as inert text.
   */
  href: string;
  inViews: boolean;
  identityConflict: boolean;
  viewsAvailable: boolean;
  defaultViewId: string | null;
  views: HtmlDataCollectionView[];
  /**
   * Rows the collection declares inline, or `null` when they cannot be known
   * without running a query (filter-driven and folder collections). Pages pick
   * a card to show from this instead of probing every collection with a
   * one-row `view-data` request.
   */
  rowCount: number | null;
}

export interface HtmlDataViews {
  collections: HtmlDataCollection[];
  truncated: boolean;
  nextCursor: string | null;
}

const MAX_COLLECTIONS = 50;
const MAX_TOP_TAGS = 20;

const CACHE_TTL_MS = 2_000;

interface CacheEntry {
  at: number;
  value: unknown;
}

/** Keys are `collection:<root>/<relativePath>` or `notes:<notebookId>`. */
const resolvedCache = new Map<string, CacheEntry>();
const inflightLoads = new Map<string, Promise<unknown>>();

/**
 * Dashboard pages fire several requests at once. Without this, each request
 * re-reads collection YAML and re-lists every note in the notebook, turning a
 * four-card page into four full index scans. The TTL only has to span one
 * page's first paint: pages cannot subscribe to changes, so a cached read
 * cannot be more stale than the page already is.
 */
function cachedLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = resolvedCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.value as T);
  const running = inflightLoads.get(key);
  if (running) return running as Promise<T>;
  const pending = load()
    .then((value) => {
      resolvedCache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => { inflightLoads.delete(key); });
  inflightLoads.set(key, pending);
  return pending;
}

/** Drops cached reads. Wire to a file-change boundary when one exists. */
export function invalidateHtmlDataCache(): void {
  resolvedCache.clear();
  inflightLoads.clear();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;

/** Notebook-dependent kinds answer `E_SCOPE` rather than reading someone else's data. */
function requireNotebook(ctx: HtmlDataContext): string {
  if (!ctx.notebookId) throw new HtmlEmbedError('E_SCOPE', 'notebook unavailable');
  return ctx.notebookId;
}

/** Notebook-wide memo/tag aggregates for dashboards inside HTML previews. */
async function resolveNotebookStats(ctx: HtmlDataContext): Promise<HtmlDataStats> {
  const notebookId = requireNotebook(ctx);
  const [usage, statuses, tagList, collectionEntries] = await Promise.all([
    memos.getUsedTagIds(notebookId),
    notebooks.getBackgroundStatus(),
    tags.getAll(notebookId).catch(() => ({ tags: [] as { id: string; name: string }[] })),
    listCollections(notebookId),
  ]);
  const names = new Map(tagList.tags.map((tag: { id: string; name: string }) => [tag.id, tag.name]));
  const sorted = [...usage.tagCounts].sort((a, b) => b.count - a.count).slice(0, MAX_TOP_TAGS);
  const maxCount = sorted[0]?.count ?? 0;
  const topTags = sorted.map((entry) => ({
    name: names.get(entry.tagId) ?? entry.tagId,
    count: entry.count,
    barWidth: maxCount > 0 ? `${Math.max(2, Math.round((entry.count / maxCount) * 100))}%` : '0%',
  }));
  const status = statuses.find((item: NotebookBackgroundStatus) => item.notebookId === notebookId);
  return {
    notebookId,
    totalMemos: usage.totalMemoCount,
    databaseCount: collectionEntries.filter((entry) => entry.collectionId !== null).length,
    todoMemos: usage.todoMemoCount,
    memoCount: typeof status?.memoCount === 'number' ? status.memoCount : null,
    topTags,
  };
}

/**
 * Raw collection file text. Both the document reader and the row resolvers need
 * it — rows are parsed by the same parsers the surfaces use, so the bridge
 * cannot answer from the loose YAML map alone.
 */
function readCollectionSource(root: string, relativePath: string): Promise<string> {
  return cachedLoad(`collection:${root}/${relativePath}`, () =>
    externalDocuments.read(`${root}/${relativePath}`, root));
}

/** Parsed collection document, shared by the collection list and row resolvers. */
async function readCollectionDocument(root: string, relativePath: string): Promise<unknown> {
  return YAML.parse(await readCollectionSource(root, relativePath)) as unknown;
}

/**
 * Collection index of a notebook. Names and types live only in the index, not
 * in the collection file, so both the list kind and single-view reads need it;
 * a workbench asks for both within one paint.
 */
function listCollections(notebookId: string): Promise<CollectionIndexItem[]> {
  return cachedLoad(`collections:${notebookId}`, () => collections.list(notebookId));
}

const normalizeRelativePath = (value: string): string => value.replace(/\\/g, '/');

/**
 * Rows a collection file pins inline. Filter-driven collections (work documents,
 * rule-filtered tables) and folder/hybrid collections pin none — their row
 * count is only knowable by running the query, so this answers `null` rather
 * than a misleading zero.
 */
function declaredRowCount(parsed: unknown): number | null {
  if (!isRecord(parsed) || !isRecord(parsed.payload)) return null;
  const dataset = isRecord(parsed.payload.dataset) ? parsed.payload.dataset : null;
  const include = dataset && isRecord(dataset.records) && Array.isArray(dataset.records.include)
    ? dataset.records.include
    : null;
  return include && include.length > 0 ? include.length : null;
}

/** Collection entries of the notebook with their declarative view summaries. */
async function resolveNotebookViews(ctx: HtmlDataContext, params: Record<string, unknown> | null): Promise<HtmlDataViews> {
  const notebookId = requireNotebook(ctx);
  const all = (await listCollections(notebookId)).filter((entry) => entry.collectionId !== null);
  const cursor = params?.cursor;
  if (cursor != null && (typeof cursor !== 'string' || !/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) throw new HtmlEmbedError('E_INVALID', 'invalid cursor');
  const offset = cursor == null ? 0 : Number(cursor);
  const entries = all.slice(offset, offset + MAX_COLLECTIONS);
  const root = ctx.scopePath?.replace(/[\\/]+$/, '') ?? '';
  const list = await Promise.all(entries.map(async (entry): Promise<HtmlDataCollection> => {
    const base: HtmlDataCollection = {
      name: entry.name,
      type: entry.collectionType,
      relativePath: entry.relativePath,
      href: collectionHref(notebookId, entry.relativePath),
      inViews: entry.inViews,
      identityConflict: entry.identityConflict,
      viewsAvailable: false,
      defaultViewId: null,
      views: [],
      rowCount: null,
    };
    if (!root) return base;
    try {
      const parsed = await readCollectionDocument(root, entry.relativePath);
      const viewsBlock = isRecord(parsed) && isRecord(parsed.payload) && isRecord(parsed.payload.views)
        ? parsed.payload.views
        : null;
      const items = Array.isArray(viewsBlock?.items) ? viewsBlock.items : [];
      const views = items.filter(isRecord)
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
        rowCount: declaredRowCount(parsed),
      };
    } catch {
      // Unreadable or invalid collection files degrade to an empty view list.
      return base;
    }
  }));
  const next = offset + entries.length;
  return { collections: list, truncated: next < all.length, nextCursor: next < all.length ? String(next) : null };
}

/** Notebook custom view filters (`<notebook>/.flowix/system.json`). */
async function resolveNotebookCustomViews(ctx: HtmlDataContext): Promise<unknown> {
  const data = await system.getCustomViews(requireNotebook(ctx));
  return { filters: Array.isArray(data.filters) ? data.filters : [] };
}

export interface HtmlViewDataField {
  id: string;
  name: string;
  /**
   * Lowercased column type from `HTML_EMBED_FIELD_TYPES`. The collection schema
   * stores `Tag` / `MultiSelect` / `URL`; publishing that casing forced every
   * page to rediscover the vocabulary, so the bridge converges it here.
   */
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
  /**
   * Whether the note index knows this path. `false` means the row is a record
   * without indexed note metadata (internal `.flowix/` records, records whose
   * file is gone) — `title` then falls back to the file name.
   */
  resolved: boolean;
  /** Ready-to-use `flowix://` link that opens the note; empty for non-notes. */
  href: string;
}

export interface HtmlViewData {
  collection: { name: string; type: string; relativePath: string };
  viewId: string | null;
  /** Column definitions for dataset collections; empty for folder listings. */
  fields: HtmlViewDataField[];
  rows: HtmlViewDataRow[];
  /**
   * Rows the view has in total, before `limit`. `null` when the count needs
   * paging (folder collections with more pages) — pages should say "还有更多"
   * rather than invent a denominator.
   */
  total: number | null;
  truncated: boolean;
  nextCursor: string | null;
}

/**
 * Rows a single `view-data` answers. Published to page authors in the
 * capability catalog, so it is declared in the contract rather than here: a
 * number the doc, the catalog and the resolver each keep separately drifts,
 * and the page then asks for a limit it cannot get.
 */
const MAX_VIEW_ROWS = HTML_EMBED_MAX_VIEW_ROWS;

/** Schema literals → published vocabulary. Unknown types pass through lowercased. */
const FIELD_TYPE_ALIASES: Record<string, HtmlEmbedFieldType> = {
  tag: 'tag',
  multiselect: 'multi-select',
  url: 'url',
};

function normalizeFieldType(raw: string): string {
  const lower = raw.trim().toLowerCase();
  return FIELD_TYPE_ALIASES[lower] ?? lower;
}

/**
 * A `flowix://open` deep link, or `''` when the path is not safely addressable.
 *
 * The link bridge already resolves these inside HTML previews, so a row can
 * carry a ready link instead of making every page rebuild the URL (and
 * re-derive notebook scoping) by hand.
 */
function notebookOpenHref(notebookId: string, path: string): string {
  // Paths come from collection files, which a page author controls. Never hand
  // back a link that resolves outside the notebook.
  const normalized = normalizeRelativePath(path);
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return '';
  if (normalized.split('/').some((segment) => segment === '..' || segment === '.')) return '';
  return `flowix://open?notebookId=${encodeURIComponent(notebookId)}&f=${encodeURIComponent(normalized)}`;
}

/**
 * Notes only. The deep link lands on the generic external surface, where a
 * picture or a PDF opens in a text document that cannot show it — media rows
 * are opened from the product UI, not from a page link.
 */
function noteHref(notebookId: string, notePath: string): string {
  if (!/\.(md|markdown)$/i.test(notePath)) return '';
  return notebookOpenHref(notebookId, notePath);
}

/**
 * Collections open by their own file: the external-surface dispatcher routes
 * these four suffixes to their collection surfaces, so the path alone is
 * enough. Keep in sync with the suffix checks in
 * `features/workspace/use-cases/workspace-navigation.ts::openExternalTarget`
 * — it accepts `.index.yaml` only, so `.index.yml` is deliberately excluded
 * here too (that file would open as a plain document, not as a collection).
 *
 * A collection *id* would not help: a page has no way to address one, and the
 * id is not what the caller who clicks a card wants — the surface is.
 */
const COLLECTION_FILE = /\.(?:table|workdocs|lib)\.ya?ml$|\.index\.yaml$/i;

function collectionHref(notebookId: string, relativePath: string): string {
  return COLLECTION_FILE.test(relativePath) ? notebookOpenHref(notebookId, relativePath) : '';
}

/** Title for records the note index does not cover (e.g. `.flowix/` records). */
function fileNameTitle(notePath: string): string {
  const name = notePath.split('/').pop() ?? '';
  return name.replace(/\.(md|markdown)$/i, '');
}

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
 * Name and type of the collection a relative path points at. The collection
 * file carries neither — only the notebook index does — so pages that title a
 * card with the collection name read it here instead of re-deriving the join.
 */
async function describeCollection(
  ctx: HtmlDataContext,
  relativePath: string,
): Promise<{ name: string; type: string; relativePath: string }> {
  const entries = await listCollections(requireNotebook(ctx)).catch(() => [] as CollectionIndexItem[]);
  const target = normalizeRelativePath(relativePath);
  const entry = entries.find((item) => normalizeRelativePath(item.relativePath) === target);
  return { name: entry?.name ?? '', type: entry?.collectionType ?? '', relativePath };
}

const VIEW_DATA_FIELD_LIMIT = 32;

/** One `view-data` request, as every reader below needs it. */
interface ViewDataRequest {
  ctx: HtmlDataContext;
  root: string;
  relativePath: string;
  /** Raw file text: rows are parsed by the same parser the surface uses. */
  text: string;
  viewId: string | null;
  limit: number;
  cursor: { offset: number; native: string | null; skip: number };
  collection: { name: string; type: string; relativePath: string };
}

function htmlField(field: unknown): HtmlViewDataField | null {
  if (!isRecord(field)) return null;
  return {
    id: asText(field.id) ?? '',
    // Schema v2/v3 store the column label only in `property_key`; there is no
    // separate `name`, so a page reading `name` would render blank headers.
    // Publish the label under both keys.
    name: asText(field.name) ?? asText(field.property_key) ?? '',
    type: normalizeFieldType(asText(field.type) ?? ''),
    propertyKey: asText(field.property_key),
  };
}

/** Column definitions a dataset collection declares, for callers without a parsed document. */
function declaredFields(payload: Record<string, unknown>): HtmlViewDataField[] {
  const dataset = isRecord(payload.dataset) ? payload.dataset : null;
  const raw = dataset && isRecord(dataset.schema) && Array.isArray(dataset.schema.fields)
    ? dataset.schema.fields
    : [];
  return raw.slice(0, VIEW_DATA_FIELD_LIMIT)
    .map(htmlField)
    .filter((field): field is HtmlViewDataField => field !== null);
}

const recordPathOf = (record: Record<string, unknown>): string =>
  // Media records carry `relative_path`, table records `note_path`. Emit forward
  // slashes on every platform: pages compare these with `notebook-views` paths.
  normalizeRelativePath(asText(record.note_path) ?? asText(record.relative_path) ?? '');

function noteRow(
  source: { id: string; notePath: string },
  noteIndex: Map<string, NoteEntry>,
  notebookId: string,
): HtmlViewDataRow {
  const entry = noteIndex.get(source.notePath);
  return {
    id: source.id,
    notePath: source.notePath,
    title: entry?.title || fileNameTitle(source.notePath),
    updatedAt: typeof entry?.updatedAt === 'number' ? entry.updatedAt : null,
    tags: Array.isArray(entry?.tags)
      ? entry.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 12)
      : [],
    properties: sanitizeProperties(entry?.properties),
    resolved: entry !== undefined,
    href: noteHref(notebookId, source.notePath),
  };
}

/** Notebook-relative path of a file listing entry. */
function relativePathOf(item: DocumentPageItem, prefix: string): string {
  const fullPath = normalizeRelativePath(item.fullPath);
  return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : item.name;
}

/**
 * A row for a file the collection holds. File rows come from the file tree or
 * the asset catalog, not the note index: there is no frontmatter to read, but
 * the file itself does exist.
 */
function fileRow(item: DocumentPageItem, notebookId: string, prefix: string): HtmlViewDataRow {
  const notePath = relativePathOf(item, prefix);
  return {
    id: '',
    notePath,
    title: item.name,
    updatedAt: item.modifiedMs,
    tags: [],
    properties: {},
    resolved: false,
    href: noteHref(notebookId, notePath),
  };
}

async function loadNoteIndex(notebookId: string): Promise<{
  entries: NoteEntry[];
  byPath: Map<string, NoteEntry>;
}> {
  const entries: NoteEntry[] = await cachedLoad(`notes:${notebookId}`, () => notes.list(notebookId))
    .catch(() => []);
  return { entries, byPath: new Map(entries.map((entry) => [normalizeRelativePath(entry.relativePath), entry])) };
}

/** The view a request reads: the asked-for one, else the remembered default. */
function activeViewOf<T extends { id: string }>(
  views: readonly T[],
  viewId: string | null,
  defaultId: string,
): T | undefined {
  if (viewId) return views.find((view) => view.id === viewId);
  return views.find((view) => view.id === defaultId) ?? views[0];
}

/**
 * Which reader answers a request. A hybrid file (schema v3) has no single type:
 * the view's `domain` decides, exactly like the surface that projects the domain
 * into its own runtime document.
 */
function resolveReadType(
  payload: Record<string, unknown>,
  viewItems: unknown[],
  viewId: string | null,
  indexType: string,
): string {
  const domains = isRecord(payload.domains) ? payload.domains : null;
  if (domains) {
    const active = viewId ? viewItems.find((item) => isRecord(item) && item.id === viewId) : undefined;
    const declared = isRecord(active) && typeof active.domain === 'string' ? active.domain : null;
    const domain = declared && (COLLECTION_DOMAINS as readonly string[]).includes(declared) && declared in domains
      ? declared as CollectionDomain
      : COLLECTION_DOMAINS.find((candidate) => candidate in domains);
    if (domain) return collectionDomainType(domain);
  }
  if (indexType && indexType !== 'hybrid') return indexType;
  return sniffDatasetType(payload);
}

/** Type of a dataset file the notebook index does not know yet. */
function sniffDatasetType(payload: Record<string, unknown>): string {
  const dataset = isRecord(payload.dataset) ? payload.dataset : null;
  if (!dataset) return '';
  const schema = isRecord(dataset.schema) ? dataset.schema : null;
  if (Array.isArray(schema?.fields) && schema.fields.length > 0) return 'table';
  const records = isRecord(dataset.records) ? dataset.records : null;
  const include = Array.isArray(records?.include) ? records.include : [];
  if (include.some((record) => isRecord(record) && typeof record.relative_path === 'string')) return 'media_library';
  const views = isRecord(payload.views) ? payload.views : null;
  const first = Array.isArray(views?.items) ? views.items.find(isRecord) : undefined;
  if (first?.layout === 'waterfall') return 'media_library';
  // A dataset without fields and without note paths lists documents.
  return 'work_documents';
}

/**
 * Table rows, read through the table's own parser and record rules so the page
 * and the table surface cannot disagree: same parser, same record set, same
 * view filter and sort. `null` means "not a table document" — the caller falls
 * back to explicit records.
 */
async function resolveDatasetRows(request: ViewDataRequest): Promise<HtmlViewData | null> {
  let document: MultidimensionalTableDocument;
  try {
    document = parseTableDocument(request.text);
  } catch (reason) {
    // The notebook calls this a table but the table parser refuses it: that is
    // a data problem worth one line in the log, not a failed request. Answer
    // with whatever the file declares so the page still has something to show.
    logger.warn('table parse refused, answering declared records', {
      collection: request.collection.name,
      type: request.collection.type,
      reason: reason instanceof Error ? reason.message : String(reason),
    });
    return null;
  }
  const notebookId = requireNotebook(request.ctx);
  const { entries, byPath } = await loadNoteIndex(notebookId);
  const filterFields = document.dataset.schema.fields;
  const records = collectionDatasetRecords({
    document,
    notes: entries,
    filterFields,
    // Pages group rows by `id`; collected rows have no stored id, so derive one
    // that stays stable across requests.
    recordIdFor: (notePath) => `note:${notePath}`,
  });
  const activeView = activeViewOf(document.views.items, request.viewId, document.views.default_id);
  const visible = collectionViewRecords({ document, notes: entries, filterFields, records, view: activeView });
  const rows = visible.slice(request.cursor.offset, request.cursor.offset + request.limit).map((record) => noteRow({
    id: record.id,
    notePath: normalizeRelativePath(record.note_path),
  }, byPath, notebookId));
  return {
    collection: request.collection,
    viewId: activeView?.id ?? null,
    fields: document.dataset.schema.fields.slice(0, VIEW_DATA_FIELD_LIMIT)
      .map(htmlField)
      .filter((field): field is HtmlViewDataField => field !== null),
    rows,
    total: visible.length,
    truncated: visible.length > request.cursor.offset + rows.length,
    nextCursor: visible.length > request.cursor.offset + rows.length ? encodeViewCursor(request, { offset: request.cursor.offset + rows.length, native: null, skip: 0 }) : null,
  };
}

/**
 * Work documents are files, not notes, and the notebook can hold far more of
 * them than fit in one answer: rows come from the same paged catalog query the
 * list surface issues, with the collection's saved condition pushed down.
 */
async function resolveWorkDocumentRows(request: ViewDataRequest): Promise<HtmlViewData | null> {
  let document: WorkDocumentsDocument;
  try {
    document = parseWorkDocumentsCollection(request.text);
  } catch (reason) {
    // Same shape as the table reader: a refused document list is a data
    // problem, logged once and answered from the records the file declares.
    logger.warn('work documents parse refused, answering declared records', {
      collection: request.collection.name,
      type: request.collection.type,
      reason: reason instanceof Error ? reason.message : String(reason),
    });
    return null;
  }
  const notebookId = requireNotebook(request.ctx);
  const scope = resolveCollectionLocationScope(
    document,
    `${request.root}/${request.relativePath}`,
    request.root,
  );
  const condition = {
    ...assetConditionFromFilter(document.dataset.filter),
    // The location belongs to the collection, independently of secondary filter
    // syntax — the list surface composes it the same way.
    path_contains: scope?.relativePath || undefined,
    path_scope: scope?.relativePath === '' ? 'all' as const : undefined,
  };
  const kinds = assetKindsForUniverse(condition, WORK_ASSET_KINDS);
  const activeView = activeViewOf(document.views.items, request.viewId, document.views.default_id);
  // An empty kind list means "no category selected" in the panel, while the
  // command reads an empty list as "no filter" — answer the empty page here.
  const page: DocumentPage = kinds.length
    ? await files.listWorkDocumentsPage(notebookId, request.cursor.native, request.limit, {
      fileNameContains: condition.file_name_contains,
      resourceKinds: kinds,
      path: condition.path_scope === 'all' ? '' : condition.path_contains,
    })
    : { folders: [], items: [], nextCursor: null, hasMore: false };
  if (page.hasMore && !page.nextCursor) throw new HtmlEmbedError('E_INTERNAL', 'missing document cursor');
  const prefix = `${normalizeRelativePath(request.root)}/`;
  const rows = page.items
    // The view's own filter applies to the loaded page, as in the list surface.
    .filter((item) => matchesAssetCollectionFilter(
      relativePathOf(item, prefix), item.assetKind ?? '', activeView?.filter,
    ))
    .map((item) => fileRow(item, notebookId, prefix));
  return {
    collection: request.collection,
    viewId: activeView?.id ?? null,
    fields: [],
    rows,
    // A paged query cannot state a total; a page size reported as a whole would
    // make "还有 N 条" lie.
    total: request.cursor.native || page.hasMore ? null : rows.length,
    truncated: page.hasMore,
    nextCursor: page.hasMore && page.nextCursor ? encodeViewCursor(request, { offset: 0, native: page.nextCursor, skip: 0 }) : null,
  };
}

/**
 * Rows a collection pins explicitly. Media libraries answer from here (their
 * records name files), and so does any dataset file whose strict parser
 * refuses it — a page should see the declared rows rather than nothing.
 */
async function resolveExplicitRows(
  request: ViewDataRequest,
  payload: Record<string, unknown>,
): Promise<HtmlViewData | null> {
  const dataset = isRecord(payload.dataset) ? payload.dataset : null;
  const include = dataset && isRecord(dataset.records) && Array.isArray(dataset.records.include)
    ? dataset.records.include.filter(isRecord)
    : null;
  if (!include) return null;
  const notebookId = requireNotebook(request.ctx);
  const { byPath } = await loadNoteIndex(notebookId);
  const records = include.slice(request.cursor.offset, request.cursor.offset + request.limit);
  const rows = records.map((record) => noteRow(
    { id: asText(record.id) ?? '', notePath: recordPathOf(record) },
    byPath,
    notebookId,
  ));
  return {
    collection: request.collection,
    viewId: request.viewId,
    fields: declaredFields(payload),
    rows,
    total: include.length,
    truncated: include.length > request.cursor.offset + rows.length,
    nextCursor: include.length > request.cursor.offset + rows.length ? encodeViewCursor(request, { offset: request.cursor.offset + rows.length, native: null, skip: 0 }) : null,
  };
}

/** Folder collection: the view data is the documents inside its directory. */
async function resolveFolderRows(request: ViewDataRequest): Promise<HtmlViewData> {
  const notebookId = requireNotebook(request.ctx);
  const directory = request.relativePath.split(/[\\/]/).slice(0, -1).join('/');
  const page = await files.listDocumentPage({
    notebookId,
    folderPath: directory ? `${request.root}/${directory}` : request.root,
    cursor: request.cursor.native,
    limit: request.limit,
  });
  if (page.hasMore && !page.nextCursor) throw new HtmlEmbedError('E_INTERNAL', 'missing folder cursor');
  const prefix = `${normalizeRelativePath(request.root)}/`;
  const available = page.folders.length + page.items.length;
  const rows = [...page.folders, ...page.items]
    .slice(request.cursor.skip, request.cursor.skip + request.limit)
    .map((item) => fileRow(item, notebookId, prefix));
  return {
    collection: request.collection,
    viewId: request.viewId,
    fields: [],
    rows,
    // A paged listing cannot state a total; saying "50 of 未知" is better than
    // reporting the page size as if it were the whole collection.
    total: request.cursor.native || page.hasMore ? null : available,
    truncated: page.hasMore || available > request.cursor.skip + rows.length,
    nextCursor: available > request.cursor.skip + rows.length
      ? encodeViewCursor(request, { ...request.cursor, skip: request.cursor.skip + rows.length })
      : page.hasMore && page.nextCursor ? encodeViewCursor(request, { offset: 0, native: page.nextCursor, skip: 0 }) : null,
  };
}

function encodeViewCursor(request: ViewDataRequest, position: ViewDataRequest['cursor']): string {
  return encodeURIComponent(JSON.stringify({ path: request.relativePath, viewId: request.viewId, limit: request.limit, ...position }));
}

/**
 * Rows behind one collection view, addressed by the collection file (the
 * "unique info" of a view is collection file + view id — view ids alone are
 * only unique inside one file).
 *
 * Every collection type is read through its own parser and rules, not through
 * the raw YAML: a filter-driven table, a document list and a folder all answer
 * "which rows" differently, and re-deriving that here is how the page and the
 * app drift apart. Dataset rows resolve against the note index, so they carry
 * titles, tags and the frontmatter properties backing each field; file rows
 * only carry what the file listing knows.
 */
async function resolveViewData(
  ctx: HtmlDataContext,
  rawParams: Record<string, unknown> | null,
): Promise<HtmlViewData> {
  const relativePath = asText(rawParams?.relativePath);
  const segments = relativePath?.split(/[\\/]/) ?? [];
  if (!relativePath || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new HtmlEmbedError('E_SCOPE', 'invalid relativePath');
  }
  const root = ctx.scopePath?.replace(/[\\/]+$/, '');
  if (!root) throw new HtmlEmbedError('E_SCOPE', 'notebook scope unavailable');
  requireNotebook(ctx);
  const viewId = asText(rawParams?.viewId);
  const limitParam = Number(rawParams?.limit);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.trunc(limitParam), 1), MAX_VIEW_ROWS) : 50;

  let cursor: ViewDataRequest['cursor'] = { offset: 0, native: null, skip: 0 };
  if (rawParams?.cursor != null) {
    try {
      if (typeof rawParams.cursor !== 'string' || rawParams.cursor.length > 16384) throw new Error();
      const value = JSON.parse(decodeURIComponent(rawParams.cursor));
      if (!value || value.path !== relativePath || value.viewId !== viewId || value.limit !== limit || !Number.isSafeInteger(value.offset) || value.offset < 0 || !Number.isSafeInteger(value.skip) || value.skip < 0 || (value.native !== null && typeof value.native !== 'string')) throw new Error();
      cursor = { offset: value.offset, native: value.native, skip: value.skip };
    } catch { throw new HtmlEmbedError('E_INVALID', 'invalid cursor'); }
  }
  const text = await readCollectionSource(root, relativePath);
  const parsed = YAML.parse(text) as unknown;
  const payload = isRecord(parsed) && isRecord(parsed.payload) ? parsed.payload : null;
  if (!payload) throw new HtmlEmbedError('E_INTERNAL', 'invalid collection document');
  const viewsBlock = isRecord(payload.views) ? payload.views : null;
  const viewItems = Array.isArray(viewsBlock?.items) ? viewsBlock.items : [];
  if (viewId && !viewItems.some((item) => isRecord(item) && item.id === viewId)) {
    throw new HtmlEmbedError('E_SCOPE', 'view not found');
  }

  const collection = await describeCollection(ctx, relativePath);
  const request: ViewDataRequest = { ctx, root, relativePath, text, viewId, limit, cursor, collection };
  const readType = resolveReadType(payload, viewItems, viewId, collection.type);
  const resolved = readType === 'table' ? await resolveDatasetRows(request)
    : readType === 'work_documents' ? await resolveWorkDocumentRows(request)
    : null;
  if (resolved) return resolved;
  // Media libraries, and dataset files a strict parser refuses: whatever the
  // file pins explicitly. Collections without a dataset list their folder.
  return (await resolveExplicitRows(request, payload)) ?? resolveFolderRows(request);
}

/** Selectable folders and the configured default, scoped to the owning notebook. */
async function resolveNotebookFolders(ctx: HtmlDataContext) {
  requireNotebook(ctx);
  if (!ctx.scopePath) throw new HtmlEmbedError('E_SCOPE', 'notebook scope unavailable');
  const { folders: options, defaultRelativePath, truncated } = await cachedLoad(
    `html-folders:${ctx.notebookId}:${ctx.scopePath}`,
    () => files.getHtmlNotebookFolders(ctx.scopePath!),
  );
  const folders = [
    { name: '', relativePath: '', depth: 0, isDefault: defaultRelativePath === '' },
    ...options.map((option) => ({
      name: option.relativePath.split('/').pop() ?? option.relativePath,
      relativePath: option.relativePath,
      depth: option.depth,
      isDefault: option.relativePath === defaultRelativePath,
    })),
  ];
  return { folders, defaultRelativePath, defaultAvailable: folders.some((folder) => folder.isDefault), truncated };
}

async function resolveNotesList(ctx: HtmlDataContext, params: Record<string, unknown> | null) {
  const notebookId = requireNotebook(ctx);
  const rawLimit = params?.limit;
  const includeImages = params?.includeImages === true;
  const requestedLimit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(100, Math.trunc(rawLimit))) : 30;
  const limit = includeImages ? Math.min(requestedLimit, 10) : requestedLimit;
  const sortBy = params?.sortBy ?? 'createdAt';
  const order = params?.order ?? 'desc';
  if (sortBy !== 'createdAt' && sortBy !== 'updatedAt' && sortBy !== 'title') {
    throw new HtmlEmbedError('E_INVALID', 'unsupported sortBy');
  }
  if (order !== 'asc' && order !== 'desc') throw new HtmlEmbedError('E_INVALID', 'unsupported order');
  const entries = await cachedLoad(`notes:${notebookId}`, () => notes.list(notebookId));
  const direction = order === 'asc' ? 1 : -1;
  const sorted = [...entries].sort((a, b) => {
    const comparison = sortBy === 'title' ? a.title.localeCompare(b.title)
      : a[sortBy] - b[sortBy];
    return direction * comparison || a.relativePath.localeCompare(b.relativePath);
  });
  let start = 0;
  if (params?.cursor != null) {
    if (typeof params.cursor !== 'string' || params.cursor.length > 16384) throw new HtmlEmbedError('E_INVALID', 'invalid cursor');
    let cursor: { path?: unknown; sortBy?: unknown; order?: unknown };
    try { cursor = JSON.parse(decodeURIComponent(params.cursor)); } catch { throw new HtmlEmbedError('E_INVALID', 'invalid cursor'); }
    if (!cursor || typeof cursor.path !== 'string' || cursor.sortBy !== sortBy || cursor.order !== order) {
      throw new HtmlEmbedError('E_INVALID', 'invalid cursor');
    }
    const index = sorted.findIndex((entry) => entry.relativePath === cursor.path);
    if (index < 0) throw new HtmlEmbedError('E_INVALID', 'expired cursor');
    start = index + 1;
  }
  const page = sorted.slice(start, start + limit);
  const hasMore = start + page.length < sorted.length;
  const last = page[page.length - 1];
  return {
    notes: await Promise.all(page.map(async (entry) => {
      let imagePreview: string | null = null;
      if (includeImages && ctx.scopePath) {
        const root = canonicalPath(ctx.scopePath).replace(/\/+$/, '');
        const value = entry.properties?.images;
        const propertyImage = typeof value === 'string' ? value : Array.isArray(value) ? value.find((item): item is string => typeof item === 'string' && !!item) : null;
        const notePath = joinNotebookMemoPath(root, entry.relativePath);
        const candidate = propertyImage
          ? joinNotebookMemoPath(root, propertyImage)
          : notePath && entry.thumbnail ? resolveDocumentRelativeHref(entry.thumbnail, notePath)?.path : null;
        if (candidate && canonicalPath(candidate).startsWith(`${root}/`)) {
          imagePreview = await files.readImagePreview(candidate, root, 480).catch(() => null);
        }
      }
      return {
        relativePath: entry.relativePath,
        title: entry.title.slice(0, 256),
        preview: entry.preview.slice(0, 256),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        href: noteHref(notebookId, entry.relativePath),
        ...(includeImages ? { imagePreview } : {}),
      };
    })),
    truncated: hasMore,
    nextCursor: hasMore && last ? encodeURIComponent(JSON.stringify({ path: last.relativePath, sortBy, order })) : null,
  };
}

export function resolveHtmlDataRequest(
  kind: HtmlDataKind,
  ctx: HtmlDataContext,
  params: Record<string, unknown> | null = null,
): Promise<unknown> {
  switch (kind) {
    case 'notes-list': return resolveNotesList(ctx, params);
    case 'dismiss-html-notice':
    case 'upload-note-image':
    case 'select-note-images':
    case 'capabilities': return Promise.reject(new HtmlEmbedError('E_INTERNAL', 'capabilities must be handled by preview host'));
    case 'create-note': return Promise.reject(new HtmlEmbedError('E_INTERNAL', 'write must be handled by preview host'));
    case 'notebook-folders': return resolveNotebookFolders(ctx);
    case 'notebook-stats': return resolveNotebookStats(ctx);
    case 'notebook-views': return resolveNotebookViews(ctx, params);
    case 'notebook-custom-views': return resolveNotebookCustomViews(ctx);
    case 'view-data': return resolveViewData(ctx, params);
    case 'product-theme':
      return ctx.productTheme
        ? Promise.resolve(ctx.productTheme)
        : Promise.reject(new HtmlEmbedError('E_INTERNAL', 'product theme unavailable'));
  }
}
