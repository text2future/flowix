import { datasetLocation, shareDatasetLocation, withDatasetLocation } from './shared-dataset-location';
import { createTableDocument, serializeTableDocument } from '@features/multidimensional-table/public/create-api';
import { createMediaLibrary, parseMediaLibrary, serializeMediaLibrary } from '@features/media-library/model';
import { createWorkDocumentsCollection, parseWorkDocumentsCollection } from '@features/work-documents/public/model-api';
import {
  COLLECTION_DOMAINS,
  collectionTypeDomain,
  createCollectionMetadata,
  isHybridCollectionSource,
  isRecord,
  parseCollectionDocumentV2,
  parseHybridCollection,
  reviseCollection,
  serializeHybridCollectionDocument,
  serializeProjectedCollectionDocument,
  type CollectionDomain,
  type CollectionMetadata,
  type CollectionProperty,
  type CollectionSource,
  type HybridCollectionDocument,
  type HybridCollectionView,
  type ProjectedCollectionDocument,
} from './model';
import { externalDocuments, files } from '@platform/tauri/client';
import { canonicalPath, notebookRelativeDirectoryPath } from '@/lib/path';
import { assetFilterFromCondition, type AssetFilterCondition, type AssetFilterSaveOptions } from './asset-filter';
import type { CollectionType } from './model';

type FolderCollectionKind = 'notes' | 'media';

/** 新建集合默认隐藏头图，开启后使用色块背景。 */
export function initializeFolderCollectionBanner(properties: Record<string, CollectionProperty>): void {
  properties.banner_hidden = { type: 'Boolean', value: true };
}

export function createFolderCollectionContent(kind: FolderCollectionKind, folderName: string, folderPath: string | null = null): string {
  if (kind === 'notes') {
    const document = createTableDocument('table', folderName, 'folder');
    // 文件夹首页（folder-home）的口径是「仅第一层」：新集合默认不深度遍历，
    // 旧 .index.yaml 里已落盘的 descendants 保持原样，不做迁移。
    document.dataset.source = { scope: 'containing_folder', depth: 'direct_children' };
    document.dataset.filter = {
      path: folderPath,
      match: 'all',
      conditions: [{ field: 'kind', op: 'eq', value: 'note' }],
    };
    initializeFolderCollectionBanner(document.collection.properties);
    return serializeTableDocument(document);
  }

  const document = createMediaLibrary(folderName);
  document.collection.placement = 'folder';
  document.dataset.source = { scope: 'containing_folder', depth: 'direct_children' };
  document.dataset.filter = { path: folderPath, match: 'all', conditions: [] };
  initializeFolderCollectionBanner(document.collection.properties);
  return serializeMediaLibrary(document);
}

function directChildrenSource() {
  return { scope: 'containing_folder' as const, depth: 'direct_children' as const };
}

function folderFilter(relativeFolder: string | null) {
  return { path: relativeFolder, match: 'all' as const, conditions: [] };
}

/** 单个数据域的模板：dataset + 默认视图（未打 domain 标签）。 */
function buildDomainTemplate(domain: CollectionDomain, relativeFolder: string | null, placement: CollectionMetadata['placement'] = 'folder'): { dataset: Record<string, unknown>; view: Record<string, unknown> } {
  if (domain === 'notes') {
    const document = createTableDocument('table', 'folder', placement);
    document.dataset.source = placement === 'folder' ? directChildrenSource() : { scope: 'notebook', depth: 'descendants' };
    document.dataset.filter = placement === 'folder' ? {
      path: relativeFolder,
      match: 'all',
      conditions: [{ field: 'kind', op: 'eq', value: 'note' }],
    } : null;
    const view = document.views.items[0];
    return { dataset: document.dataset as unknown as Record<string, unknown>, view: view as unknown as Record<string, unknown> };
  }
  if (domain === 'media') {
    const document = createMediaLibrary('folder');
    document.collection.placement = placement;
    document.dataset.source = placement === 'folder' ? directChildrenSource() : { scope: 'notebook', depth: 'descendants' };
    document.dataset.filter = placement === 'folder' ? folderFilter(relativeFolder) : { all: [], any: [] };
    return { dataset: document.dataset as unknown as Record<string, unknown>, view: document.views.items[0] as unknown as Record<string, unknown> };
  }
  const document = createWorkDocumentsCollection('folder');
  document.collection.placement = placement;
  document.dataset.source = placement === 'folder' ? directChildrenSource() : { scope: 'notebook', depth: 'descendants' };
  document.dataset.filter = placement === 'folder' ? folderFilter(relativeFolder) : { all: [], any: [] };
  return { dataset: document.dataset as unknown as Record<string, unknown>, view: document.views.items[0] as unknown as Record<string, unknown> };
}

/** 文件夹集合的 hybrid 模板：三个数据域 + 文件树标记，一次建齐。 */
export function createFolderHybridCollectionContent(folderName: string, relativeFolder: string | null, enabledDomains: readonly CollectionDomain[] = COLLECTION_DOMAINS): string {
  const domains = {} as HybridCollectionDocument['payload']['domains'];
  const defaultByDomain = {} as HybridCollectionDocument['payload']['views']['default_by_domain'];
  const items: HybridCollectionView[] = [];
  for (const domain of enabledDomains) {
    const { dataset, view } = buildDomainTemplate(domain, relativeFolder);
    domains[domain] = dataset;
    defaultByDomain[domain] = String(view.id);
    items.push({ ...(view as unknown as HybridCollectionView), domain });
  }
  const collection = createCollectionMetadata('hybrid', folderName, 'folder');
  initializeFolderCollectionBanner(collection.properties);
  return serializeHybridCollectionDocument({
    collection,
    payload: { schema_version: 3, file_tree: true, domains, views: { default_by_domain: defaultByDomain, items } },
  });
}

/** 顶层视图 tab 的一个条目（文件夹首页按视图实例平铺）。 */
export interface FolderCollectionViewSummary {
  id: string;
  name: string;
  domain: CollectionDomain;
}

export interface FolderCollectionSummary {
  source: string;
  /** 文件格式版本：v1/v2 单类型集合记 2，v3 hybrid 记 3。 */
  formatVersion: 2 | 3;
  fileTree: boolean;
  domains: CollectionDomain[];
  /** 全部视图（含各域）。notes 域视图逐个成为顶层 tab；media/work_documents
   *  面板只渲染 default 视图，顶层 tab 由调用方按 default 过滤。 */
  views: FolderCollectionViewSummary[];
  defaultByDomain: Partial<Record<CollectionDomain, string>>;
  /** 各数据域的取值范围（`dataset.source`）：图墙导览图等要按它取内容。 */
  sources: Partial<Record<CollectionDomain, CollectionSource>>;
  collectionId: string;
  revision: number;
  /** 集合自有属性（头图隐藏 / 头图指定图源等显示偏好都落在这里）。 */
  properties: Record<string, CollectionProperty>;
}

/**
 * 文件夹集合的集合体地址：`<folder>/.index.yaml`（去掉目录尾部斜杠）。
 *
 * 全仓唯一拼法：外壳、Work header 的「···」、集合改名与建域都按它定位同一个
 * 集合文件。别在调用点再写一遍模板字符串 —— 尾斜杠 / 分隔符迟早会对不上。
 */
export function collectionIndexPathForFolder(folderPath: string): string {
  return `${folderPath.replace(/[\\/]+$/, '')}/.index.yaml`;
}

/** 读取并归纳文件夹的 .index.yaml。文件不存在返回 null；
 *  v1/v2 单类型集合按其唯一域归纳（file_tree 视为 true，保持旧行为）。 */
export async function readFolderCollectionSummary(folderPath: string, notebookPath: string): Promise<FolderCollectionSummary | null> {
  return readCollectionSummary(collectionIndexPathForFolder(folderPath), notebookPath);
}

/** 读取任意集合文件的归纳（独立打开的 .index.yaml 与文件夹集合走同一套口径）。 */
export async function readCollectionSummary(indexPath: string, notebookPath: string): Promise<FolderCollectionSummary | null> {
  const source = await files.read(indexPath, notebookPath);
  if (source === null) return null;
  return summarizeFolderCollectionSource(source);
}

export function summarizeFolderCollectionSource(source: string): FolderCollectionSummary {
  if (isHybridSource(source)) {
    const parsed = parseHybridCollection(source);
    return {
      source,
      formatVersion: 3,
      fileTree: parsed.payload.file_tree,
      domains: COLLECTION_DOMAINS.filter((domain) => domain in parsed.payload.domains),
      views: parsed.payload.views.items.map((view) => ({ id: view.id, name: view.name, domain: view.domain })),
      defaultByDomain: { ...parsed.payload.views.default_by_domain },
      sources: domainSources(parsed.payload.domains),
      collectionId: parsed.collection.id,
      revision: parsed.collection.revision,
      properties: parsed.collection.properties,
    };
  }
  const document = parseCollectionDocumentV2(source);
  const domain = collectionTypeDomain(document.collection.type as CollectionType);
  const rawViews = document.payload.views as { default_id: string; items: Array<{ id: unknown; name: unknown }> };
  return {
    source,
    formatVersion: 2,
    fileTree: true,
    domains: [domain],
    views: rawViews.items.map((view) => ({ id: String(view.id), name: String(view.name), domain })),
    defaultByDomain: { [domain]: rawViews.default_id },
    sources: domainSources({ [domain]: document.payload.dataset }),
    collectionId: document.collection.id,
    revision: document.collection.revision,
    properties: document.collection.properties,
  };
}

/** 各数据域的 `dataset.source`（hybrid 的 domains 是未类型化的 YAML 片段）。 */
function domainSources(domains: Partial<Record<CollectionDomain, Record<string, unknown>>>): Partial<Record<CollectionDomain, CollectionSource>> {
  const sources: Partial<Record<CollectionDomain, CollectionSource>> = {};
  for (const domain of COLLECTION_DOMAINS) {
    const raw = domains[domain]?.source;
    if (!isRecord(raw) || !['containing_folder', 'notebook', 'folder'].includes(String(raw.scope))) continue;
    sources[domain] = {
      scope: raw.scope as CollectionSource['scope'],
      depth: raw.depth === 'descendants' ? 'descendants' : 'direct_children',
      ...(typeof raw.path === 'string' ? { path: raw.path } : {}),
    };
  }
  return sources;
}

function isHybridSource(source: string): boolean {
  return isHybridCollectionSource(source);
}

/** 确保文件夹有 .index.yaml：缺失则创建 hybrid 模板（并发冲突兜底重读）。 */
export async function ensureFolderCollection(folderPath: string, notebookPath: string, folderName: string, initialDomain: CollectionDomain = 'notes'): Promise<FolderCollectionSummary> {
  const existing = await readFolderCollectionSummary(folderPath, notebookPath);
  const indexPath = collectionIndexPathForFolder(folderPath);
  if (existing) return existing.domains.includes(initialDomain)
    ? existing : addCollectionDomain(indexPath, notebookPath, initialDomain);
  const relativeFolder = notebookRelativeDirectoryPath(notebookPath, folderPath);
  const content = createFolderHybridCollectionContent(folderName, relativeFolder, [initialDomain]);
  try {
    await files.create(indexPath, content, notebookPath);
    return summarizeFolderCollectionSource(content);
  } catch {
    // 并发兜底：另一个入口可能刚好建好了同名索引。
    const raced = await readFolderCollectionSummary(folderPath, notebookPath);
    if (raced) return raced.domains.includes(initialDomain)
      ? raced : addCollectionDomain(indexPath, notebookPath, initialDomain);
    throw new Error('集合文件创建失败');
  }
}

/** 为文件夹集合追加缺失的数据域（v2 单类型集合借此一次性迁移为 v3 hybrid，
 *  保留原有集合 id、属性与视图，不再翻转类型）。 */
export async function addFolderCollectionDomain(
  folderPath: string,
  notebookPath: string,
  domain: CollectionDomain,
): Promise<FolderCollectionSummary> {
  return addCollectionDomain(collectionIndexPathForFolder(folderPath), notebookPath, domain);
}

/** 追加数据域（按集合文件路径）：文件夹集合与独立集合共用。 */
export async function addCollectionDomain(
  indexPath: string,
  notebookPath: string,
  domain: CollectionDomain,
): Promise<FolderCollectionSummary> {
  const folderPath = canonicalPath(indexPath).replace(/[\\/][^\\/]*$/, '');
  const source = await files.read(indexPath, notebookPath);
  if (source === null) throw new Error('集合文件不存在');
  const relativeFolder = notebookRelativeDirectoryPath(notebookPath, folderPath);
  const placement = parseCollectionDocumentV2(source).collection.placement;
  const template = buildDomainTemplate(domain, relativeFolder, placement);
  const view: HybridCollectionView = { ...(template.view as unknown as HybridCollectionView), domain };
  let next: HybridCollectionDocument;
  if (isHybridSource(source)) {
    const parsed = parseHybridCollection(source);
    if (parsed.payload.domains[domain]) return summarizeFolderCollectionSource(source);
    next = {
      format: 'flowix.collection',
      schema_version: 3,
      collection: reviseCollection(parsed.collection),
      payload: {
        schema_version: 3,
        file_tree: parsed.payload.file_tree,
        domains: { ...parsed.payload.domains, [domain]: template.dataset },
        views: {
          default_by_domain: { ...parsed.payload.views.default_by_domain, [domain]: view.id },
          items: [...parsed.payload.views.items, view],
        },
      },
    };
  } else {
    // v1/v2 → v3：现有域保留原 dataset 与 views，新域用模板，file_tree 保持 true。
    const document = parseCollectionDocumentV2(source);
    const existingDomain = collectionTypeDomain(document.collection.type as CollectionType);
    const existingViews = document.payload.views as { default_id: string; items: Record<string, unknown>[] };
    const items: HybridCollectionView[] = existingViews.items
      .map((item) => ({ ...(item as unknown as HybridCollectionView), domain: existingDomain }));
    if (domain === existingDomain) {
      return summarizeFolderCollectionSource(source);
    }
    const newTemplate = buildDomainTemplate(domain, relativeFolder, placement);
    const newView: HybridCollectionView = { ...(newTemplate.view as unknown as HybridCollectionView), domain };
    const domains: HybridCollectionDocument['payload']['domains'] = {
      [existingDomain]: document.payload.dataset,
      [domain]: newTemplate.dataset,
    };
    next = {
      format: 'flowix.collection',
      schema_version: 3,
      collection: {
        ...document.collection,
        type: 'hybrid',
        revision: document.collection.revision + 1,
        updated_at: new Date().toISOString(),
      },
      payload: {
        schema_version: 3,
        file_tree: placement === 'folder',
        domains,
        views: {
          default_by_domain: { [existingDomain]: existingViews.default_id, [domain]: newView.id },
          items: [...items, newView],
        },
      },
    };
  }
  const original = parseCollectionDocumentV2(source);
  const owner = isHybridSource(source)
    ? Object.values(parseHybridCollection(source).payload.domains)[0]!
    : original.payload.dataset;
  const newDataset = next.payload.domains[domain]!;
  const existingAssets = isHybridSource(source) ? parseHybridCollection(source).payload.domains : {};
  const assetOwner = existingAssets.media ?? existingAssets.work_documents;
  next.payload.domains[domain] = withDatasetLocation(
    domain !== 'notes' && assetOwner ? { ...newDataset, filter: assetOwner.filter } : newDataset,
    datasetLocation(owner), owner.source);
  const content = serializeHybridCollectionDocument(next);
  const result = await externalDocuments.write({
    filePath: indexPath, scopePath: notebookPath, expectedContent: source, content,
  });
  if (result.status !== 'saved') throw new Error('集合文件已变化，请重试');
  return summarizeFolderCollectionSource(result.content);
}

/** 移除 hybrid 集合里的一个数据域（连同该域的视图）。
 *  「管理视图」里移除 图墙 / 列表 tab 走这里：tab 与数据域一一对应。 */
export async function removeFolderCollectionDomain(
  folderPath: string,
  notebookPath: string,
  domain: CollectionDomain,
): Promise<FolderCollectionSummary> {
  return removeCollectionDomain(collectionIndexPathForFolder(folderPath), notebookPath, domain);
}

export async function removeCollectionDomain(
  indexPath: string,
  notebookPath: string,
  domain: CollectionDomain,
): Promise<FolderCollectionSummary> {
  const source = await files.read(indexPath, notebookPath);
  if (source === null) throw new Error('集合文件不存在');
  if (!isHybridSource(source)) throw new Error('仅 v3 集合支持移除数据域');
  const parsed = parseHybridCollection(source);
  if (!parsed.payload.domains[domain]) return summarizeFolderCollectionSource(source);
  const domains = { ...parsed.payload.domains };
  delete domains[domain];
  const defaultByDomain = { ...parsed.payload.views.default_by_domain };
  delete defaultByDomain[domain];
  const next: HybridCollectionDocument = {
    format: 'flowix.collection',
    schema_version: 3,
    collection: reviseCollection(parsed.collection),
    payload: {
      schema_version: 3,
      file_tree: parsed.payload.file_tree,
      domains,
      views: {
        default_by_domain: defaultByDomain,
        items: parsed.payload.views.items.filter((view) => view.domain !== domain),
      },
    },
  };
  const content = serializeHybridCollectionDocument(next);
  const result = await externalDocuments.write({
    filePath: indexPath, scopePath: notebookPath, expectedContent: source, content,
  });
  if (result.status !== 'saved') throw new Error('集合文件已变化，请重试');
  return summarizeFolderCollectionSource(result.content);
}

/**
 * 共享「资料筛选」（数据层面）：图墙 / 列表两个资料视图同一份配置。
 * 把同一份 filter JSON 写进集合里**已存在的两个资料数据域**（media / work_documents），
 * 单次读改写保证原子性；各面板查询时按类目取自己的子集（图墙=图片视频、列表=文档类）。
 */
export async function setCollectionAssetFilter(
  indexPath: string,
  notebookPath: string,
  condition: AssetFilterCondition,
  options: AssetFilterSaveOptions = { updateLocation: true },
): Promise<FolderCollectionSummary> {
  const source = await files.read(indexPath, notebookPath);
  if (source === null) throw new Error('集合文件不存在');
  if (!isHybridSource(source)) throw new Error('仅集合文件支持共享资料筛选');
  const parsed = parseHybridCollection(source);
  const owner = parsed.payload.domains.notes ?? parsed.payload.domains.media ?? parsed.payload.domains.work_documents!;
  const requestedFilter = assetFilterFromCondition(condition);
  const filter = options.updateLocation ? requestedFilter
    : withDatasetLocation({ filter: requestedFilter }, datasetLocation(owner)).filter;
  const domains = { ...parsed.payload.domains };
  let changed = false;
  for (const domain of ['media', 'work_documents'] as const) {
    const dataset = domains[domain];
    if (!dataset || !isRecord(dataset)) continue;
    if (JSON.stringify(dataset.filter ?? null) === JSON.stringify(filter)) continue;
    domains[domain] = { ...dataset, filter };
    changed = true;
  }
  if (!changed && Object.values(domains).every((dataset) => datasetLocation(dataset) === datasetLocation({ filter }))) return summarizeFolderCollectionSource(source);
  const next: HybridCollectionDocument = {
    format: 'flowix.collection',
    schema_version: 3,
    collection: reviseCollection(parsed.collection),
    payload: {
      schema_version: 3,
      file_tree: parsed.payload.file_tree,
      domains: shareDatasetLocation(domains, { ...owner, filter }),
      views: parsed.payload.views,
    },
  };
  const content = serializeHybridCollectionDocument(next);
  const result = await externalDocuments.write({
    filePath: indexPath, scopePath: notebookPath, expectedContent: source, content,
  });
  if (result.status !== 'saved') throw new Error('集合文件已变化，请重试');
  return summarizeFolderCollectionSource(result.content);
}

/** 资料视图（图墙 / 列表）新增时的默认名：与笔记视图「表格/日历…」平行对齐。 */
const ASSET_VIEW_BASE_NAMES: Record<Exclude<CollectionDomain, 'notes'>, string> = {
  media: '图墙',
  work_documents: '列表',
};

export interface AddCollectionViewResult {
  summary: FolderCollectionSummary;
  /** 新建的视图 id（外壳用它拼 tab key 并直接选中）。 */
  viewId: string;
}

/** 资料域的单视图模板（图墙瀑布流 / 列表卡片），与 addFolderCollectionView 同构。 */
function buildAssetView(domain: Exclude<CollectionDomain, 'notes'>, existingNames: string[]): Record<string, unknown> {
  return {
    id: viewId(),
    name: uniqueViewName(existingNames, ASSET_VIEW_BASE_NAMES[domain]),
    layout: domain === 'media' ? 'waterfall' as const : 'gallery' as const,
    filter: { all: [], any: [] },
    sort: domain === 'media'
      ? [{ field: 'created_at' as const, direction: 'desc' as const }]
      : [{ field: 'modified_at' as const, direction: 'desc' as const }],
    config: {},
  };
}

/** 在数据域内新增一个视图（图墙 / 列表与笔记视图平行对齐的入口）：
 *  hybrid 域内直接追加；域缺失先补域（其默认视图即新建视图）；v2 同域按投影追加，
 *  异域先迁移为 hybrid 再补域。notes 域的视图仍由表格自身的添加视图流程负责。 */
export async function addCollectionView(
  indexPath: string,
  notebookPath: string,
  domain: CollectionDomain,
): Promise<AddCollectionViewResult> {
  if (domain === 'notes') throw new Error('笔记视图请使用表格自身的添加视图入口');
  const source = await files.read(indexPath, notebookPath);
  if (source === null) throw new Error('集合文件不存在');
  if (!isHybridSource(source)) {
    const document = parseCollectionDocumentV2(source);
    const existingDomain = collectionTypeDomain(document.collection.type as CollectionType);
    if (domain !== existingDomain) {
      const summary = await addCollectionDomain(indexPath, notebookPath, domain);
      return { summary, viewId: summary.defaultByDomain[domain] ?? '' };
    }
    const parsed = domain === 'media' ? parseMediaLibrary(source) : parseWorkDocumentsCollection(source);
    const view = buildAssetView(domain, parsed.views.items.map((item) => item.name));
    await writeProjection(indexPath, notebookPath, source, {
      collection: reviseCollection(document.collection),
      dataset: document.payload.dataset,
      views: { default_id: String(parsed.views.default_id), items: [...parsed.views.items, view] },
    }, null);
    const summary = await readCollectionSummary(indexPath, notebookPath);
    if (!summary) throw new Error('集合文件读取失败');
    return { summary, viewId: String(view.id) };
  }
  const parsed = parseHybridCollection(source);
  if (!parsed.payload.domains[domain]) {
    const summary = await addCollectionDomain(indexPath, notebookPath, domain);
    return { summary, viewId: summary.defaultByDomain[domain] ?? '' };
  }
  const view = buildAssetView(domain, parsed.payload.views.items
    .filter((item) => item.domain === domain)
    .map((item) => item.name));
  const next: HybridCollectionDocument = {
    format: 'flowix.collection',
    schema_version: 3,
    collection: reviseCollection(parsed.collection),
    payload: {
      schema_version: 3,
      file_tree: parsed.payload.file_tree,
      domains: parsed.payload.domains,
      views: {
        default_by_domain: parsed.payload.views.default_by_domain,
        items: [...parsed.payload.views.items, { ...(view as unknown as HybridCollectionView), domain }],
      },
    },
  };
  const content = serializeHybridCollectionDocument(next);
  const result = await externalDocuments.write({
    filePath: indexPath, scopePath: notebookPath, expectedContent: source, content,
  });
  if (result.status !== 'saved') throw new Error('集合文件已变化，请重试');
  return { summary: summarizeFolderCollectionSource(result.content), viewId: String(view.id) };
}

/** 重命名一个视图（含图墙 / 列表的视图；notes 域视图通常仍走表格自身的改名）。
 *  空名与重名会被拒绝；hybrid 直接改 items，v2 按域投影改写。 */
export async function renameCollectionView(
  indexPath: string,
  notebookPath: string,
  viewId: string,
  rawName: string,
): Promise<FolderCollectionSummary> {
  const name = rawName.trim();
  if (!name) throw new Error('视图名称不能为空');
  const source = await files.read(indexPath, notebookPath);
  if (source === null) throw new Error('集合文件不存在');
  if (!isHybridSource(source)) {
    const document = parseCollectionDocumentV2(source);
    const views = document.payload.views as { default_id: unknown; items: Array<Record<string, unknown>> };
    if (!views.items.some((item) => String(item.id) === viewId)) return summarizeFolderCollectionSource(source);
    if (views.items.some((item) => String(item.id) !== viewId && String(item.name) === name)) throw new Error('视图名称已存在');
    await writeProjection(indexPath, notebookPath, source, {
      collection: reviseCollection(document.collection),
      dataset: document.payload.dataset,
      views: {
        default_id: String(views.default_id),
        items: views.items.map((item) => String(item.id) === viewId ? { ...item, name } : item),
      },
    }, null);
    const summary = await readCollectionSummary(indexPath, notebookPath);
    if (!summary) throw new Error('集合文件读取失败');
    return summary;
  }
  const parsed = parseHybridCollection(source);
  if (!parsed.payload.views.items.some((item) => item.id === viewId)) return summarizeFolderCollectionSource(source);
  if (parsed.payload.views.items.some((item) => item.id !== viewId && item.name === name)) throw new Error('视图名称已存在');
  const next: HybridCollectionDocument = {
    format: 'flowix.collection',
    schema_version: 3,
    collection: reviseCollection(parsed.collection),
    payload: {
      schema_version: 3,
      file_tree: parsed.payload.file_tree,
      domains: parsed.payload.domains,
      views: {
        default_by_domain: parsed.payload.views.default_by_domain,
        items: parsed.payload.views.items.map((item) => item.id === viewId ? { ...item, name } : item),
      },
    },
  };
  const content = serializeHybridCollectionDocument(next);
  const result = await externalDocuments.write({
    filePath: indexPath, scopePath: notebookPath, expectedContent: source, content,
  });
  if (result.status !== 'saved') throw new Error('集合文件已变化，请重试');
  return summarizeFolderCollectionSource(result.content);
}

/** 删除一个视图：若它是所在域的最后一个视图，连同数据域一起移除（与旧「移除
 *  数据域」语义一致）；notes 域至少保留一个视图（表格自身有同样护栏）。 */
export async function removeCollectionView(
  indexPath: string,
  notebookPath: string,
  viewId: string,
): Promise<FolderCollectionSummary> {
  const source = await files.read(indexPath, notebookPath);
  if (source === null) throw new Error('集合文件不存在');
  if (!isHybridSource(source)) {
    const document = parseCollectionDocumentV2(source);
    const views = document.payload.views as { default_id: unknown; items: Array<Record<string, unknown>> };
    if (!views.items.some((item) => String(item.id) === viewId)) return summarizeFolderCollectionSource(source);
    if (views.items.length <= 1) throw new Error('至少保留一个视图');
    const items = views.items.filter((item) => String(item.id) !== viewId);
    await writeProjection(indexPath, notebookPath, source, {
      collection: reviseCollection(document.collection),
      dataset: document.payload.dataset,
      views: {
        default_id: String(views.default_id) === viewId ? String(items[0].id) : String(views.default_id),
        items,
      },
    }, null);
    const summary = await readCollectionSummary(indexPath, notebookPath);
    if (!summary) throw new Error('集合文件读取失败');
    return summary;
  }
  const parsed = parseHybridCollection(source);
  const target = parsed.payload.views.items.find((item) => item.id === viewId);
  if (!target) return summarizeFolderCollectionSource(source);
  if (parsed.payload.views.items.length <= 1) throw new Error('至少保留一个视图');
  const remaining = parsed.payload.views.items.filter((item) => item.id !== viewId);
  const domainViews = remaining.filter((item) => item.domain === target.domain);
  const domains = { ...parsed.payload.domains };
  const defaultByDomain = { ...parsed.payload.views.default_by_domain };
  if (domainViews.length === 0) {
    if (target.domain === 'notes') throw new Error('表格至少保留一个视图');
    delete domains[target.domain];
    delete defaultByDomain[target.domain];
  } else if (defaultByDomain[target.domain] === viewId) {
    defaultByDomain[target.domain] = domainViews[0].id;
  }
  const next: HybridCollectionDocument = {
    format: 'flowix.collection',
    schema_version: 3,
    collection: reviseCollection(parsed.collection),
    payload: {
      schema_version: 3,
      file_tree: parsed.payload.file_tree,
      domains,
      views: { default_by_domain: defaultByDomain, items: remaining },
    },
  };
  const content = serializeHybridCollectionDocument(next);
  const result = await externalDocuments.write({
    filePath: indexPath, scopePath: notebookPath, expectedContent: source, content,
  });
  if (result.status !== 'saved') throw new Error('集合文件已变化，请重试');
  return summarizeFolderCollectionSource(result.content);
}

function uniqueViewName(existing: string[], base: string): string {
  let name = base;
  for (let suffix = 2; existing.includes(name); suffix += 1) name = `${base} ${suffix}`;
  return name;
}

function viewId(): string {
  return `view_${crypto.randomUUID().replace(/-/g, '')}`;
}

async function writeProjection(
  indexPath: string,
  notebookPath: string,
  source: string,
  document: ProjectedCollectionDocument,
  domain: CollectionDomain | null,
): Promise<void> {
  // v1/v2 单类型文件走通用 v2 序列化（domain 为 null 时由它自己处理）；hybrid 按域合并。
  const content = serializeProjectedCollectionDocument(source, document, domain);
  const result = await externalDocuments.write({
    filePath: indexPath, scopePath: notebookPath, expectedContent: source, content,
  });
  if (result.status !== 'saved') throw new Error('集合文件已变化，请重试');
}

/** 兼容旧「切换集合类型」入口。v3 hybrid 的类型不再互斥：这个动作的语义是
 *  「补齐对应数据域」（v1/v2 单类型文件借此一次性迁移为 hybrid，保留原视图），
 *  不再翻转类型、不再重置 views。 */
export async function switchFolderCollectionType(filePath: string, notebookPath: string, type: CollectionType): Promise<string> {
  if (!canonicalPath(filePath).endsWith('/.index.yaml')) {
    throw new Error('仅文件夹集合支持切换视图类型');
  }
  const source = await externalDocuments.read(filePath, notebookPath);
  if (source === null) throw new Error('集合文件不存在');
  if (isHybridSource(source)) {
    const parsed = parseHybridCollection(source);
    if (parsed.collection.placement !== 'folder') throw new Error('仅文件夹集合支持切换视图类型');
    const domain = collectionTypeDomain(type);
    if (parsed.payload.domains[domain]) return parsed.collection.id;
  }
  const folderPath = canonicalPath(filePath).replace(/[\\/][^\\/]*$/, '');
  const summary = await addFolderCollectionDomain(folderPath, notebookPath, collectionTypeDomain(type));
  return summary.collectionId;
}
