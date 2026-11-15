/**
 * `window.flowix` —— 笔记本内嵌入页面（协议 `flowix.embed` v1）的类型声明。
 *
 * 页面跑在 `sandbox="allow-scripts"` 的 iframe 里（不透明源），拿不到 Tauri 命令、
 * cookie、localStorage / IndexedDB：这里是读取产品数据的唯一通道。
 * 完整契约见仓库的 `docs/EMBEDDED-HTML-API.md`。
 *
 * 用法：把本文件放进页面工程（或 `/// <reference path="flowix-embed.d.ts" />`），
 * 之后 `window.flowix.request(...)` 就有补全与类型检查。
 */

/** 可请求的能力名。 */
export type FlowixDataKind =
  | 'capabilities'
  | 'notes-list'
  | 'dismiss-html-notice'
  | 'create-note'
  | 'select-note-images'
  | 'upload-note-image'
  | 'notebook-folders'
  | 'notebook-stats'
  | 'notebook-views'
  | 'notebook-custom-views'
  | 'view-data'
  | 'product-theme';

/**
 * `view-data.fields[].type` 的词表。产品内部用 `Tag` / `MultiSelect` / `URL`
 * 这类大小写，桥在出口统一小写，页面只会见到这一组。
 */
export type FlowixFieldType =
  | 'primary'
  | 'tag'
  | 'select'
  | 'multi-select'
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'url'
  | 'icon'
  | 'color'
  | 'image';

export type FlowixPropertyValue = string | number | boolean | string[];

export interface FlowixTagCount {
  name: string;
  count: number;
  /** 现成 CSS 宽度（相对最大标签的占比），如 `"62%"`。 */
  barWidth: string;
}

export interface FlowixNotebookStats {
  notebookId: string;
  totalMemos: number;
  databaseCount: number;
  todoMemos: number;
  /** 索引未就绪时为 null。 */
  memoCount: number | null;
  topTags: FlowixTagCount[];
}

export interface FlowixCollectionViewSummary {
  id: string;
  name: string;
  /** `table` / `kanban` / `calendar` / `gallery` / `waterfall`。 */
  layout: string;
}

export interface FlowixCollectionSummary {
  name: string;
  /** `table` / `media_library` / `work_documents` / `hybrid` / 文件夹集合。 */
  type: string;
  /** 笔记本内相对路径，可直接作为 `view-data` 的 `relativePath`。 */
  relativePath: string;
  /**
   * 可直接放进 `<a href>` 的 `flowix://open` 深链，点了打开这个集合。
   * 路径不是集合文件时为空字符串——别自己拼地址补上。
   */
  href: string;
  inViews: boolean;
  identityConflict: boolean;
  viewsAvailable: boolean;
  defaultViewId: string | null;
  views: FlowixCollectionViewSummary[];
  /**
   * 集合文件里内联登记的行数。筛选驱动的集合与文件夹集合只有跑查询才知道，
   * 因此是 null——当作"未知"，不要当作 0。
   */
  rowCount: number | null;
}

export interface FlowixNotebookViews {
  collections: FlowixCollectionSummary[];
  truncated: boolean;
  nextCursor: string | null;
}

export interface FlowixViewDataParams {
  /** 集合文件的笔记本内相对路径，如 `项目/.index.yaml`。 */
  relativePath: string;
  /** 视图 id；只在单个集合文件内唯一。省略时用集合的默认视图。 */
  viewId?: string;
  /** 返回行数上限，默认 50，范围 1–200。 */
  limit?: number;
  cursor?: string;
}

export interface FlowixViewDataField {
  id: string;
  /** 显示名；schema 没有 label 时回退为 `propertyKey`，不会为空。 */
  name: string;
  type: FlowixFieldType;
  /** `properties` 的键名。 */
  propertyKey: string | null;
}

export interface FlowixViewDataRow {
  id: string;
  /** 正斜杠、相对笔记本根。不一定在笔记索引里。 */
  notePath: string;
  /** 显示标题；索引里没有这条笔记时回退为文件名。 */
  title: string;
  updatedAt: number | null;
  tags: string[];
  properties: Record<string, FlowixPropertyValue>;
  /** 笔记索引是否认识这个路径。文件行（工作文档 / 媒体库 / 文件夹）恒为 false。 */
  resolved: boolean;
  /** 可直接放进 `<a href>` 的链接；非 `.md` 行为空字符串。 */
  href: string;
}

export interface FlowixViewData {
  collection: { name: string; type: string; relativePath: string };
  /** 实际生效的视图 id（未传 `viewId` 时是默认视图）。 */
  viewId: string | null;
  fields: FlowixViewDataField[];
  rows: FlowixViewDataRow[];
  /** 截断前的总行数；分页类集合还有下一页时为 null。 */
  total: number | null;
  /** 本页之外还有行——正常结果，不是错误。 */
  truncated: boolean;
  nextCursor: string | null;
}

export interface FlowixProductTheme {
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

export interface FlowixNotebookFolders {
  folders: { name: string; relativePath: string; depth: number; isDefault: boolean }[];
  defaultRelativePath: string;
  defaultAvailable: boolean;
  truncated: boolean;
}

export interface FlowixNotebookCustomViews {
  filters: unknown[];
}

/** `request` 失败时 reject 的错误：`error.code` 是稳定值。 */
export interface FlowixRequestError extends Error {
  code: 'E_UNSUPPORTED' | 'E_SCOPE' | 'E_BUSY' | 'E_INVALID' | 'E_TIMEOUT' | 'E_INTERNAL';
}

export interface FlowixInvalidateEvent {
  /** 变化涉及的能力；null 表示宿主没指明范围（视为全部）。 */
  kinds: FlowixDataKind[] | null;
}

export interface FlowixEmbedApi {
  readonly protocol: 'flowix.embed';
  readonly version: 1;

  request(kind: 'capabilities'): Promise<{ protocol: 'flowix.embed'; version: number; kinds: { kind: FlowixDataKind; intent: string; whenToUse: string; summary: string; params: string | null; returns: string; notes?: readonly string[]; metaKey: string | null }[]; scope: 'notebook' | 'external'; authorization: 'open-page' }>;
  request(kind: 'dismiss-html-notice', params: { id: string }): Promise<{ dismissed: true }>;

  request(kind: 'notes-list', params?: { limit?: number; sortBy?: 'createdAt' | 'updatedAt' | 'title'; order?: 'asc' | 'desc'; cursor?: string; includeImages?: boolean }): Promise<{
    notes: { relativePath: string; title: string; preview: string; createdAt: number; updatedAt: number; href: string; imagePreview?: string | null }[];
    truncated: boolean;
    nextCursor: string | null;
  }>;

  request(kind: 'upload-note-image', params: { file: File }): Promise<{ relativePath: string }>;
  request(kind: 'select-note-images'): Promise<{ images: string[] }>;
  request(kind: 'create-note', params: { parentRelativePath: string; content: string; clientRequestId: string; images?: string[] }): Promise<{ relativePath: string; href: string }>;

  request(kind: 'notebook-folders'): Promise<FlowixNotebookFolders>;
  request(kind: 'notebook-stats'): Promise<FlowixNotebookStats>;
  request(kind: 'notebook-views', params?: { cursor?: string }): Promise<FlowixNotebookViews>;
  request(kind: 'notebook-custom-views'): Promise<FlowixNotebookCustomViews>;
  request(kind: 'view-data', params: FlowixViewDataParams): Promise<FlowixViewData>;
  request(kind: 'product-theme'): Promise<FlowixProductTheme>;

  /** 手动渲染：把 `data-fx-*` 绑定到给定数据根（默认用最近一次自动拉取的结果）。 */
  render(data?: Record<string, unknown>): void;

  /** 订阅自动拉取（`<meta name="flowix-data">`）的结果，返回取消订阅函数。 */
  onData(listener: (data: Record<string, unknown>) => void): () => void;

  /**
   * 底层笔记本数据变了。声明过的 kind 会自己重拉；用 `request('view-data')`
   * 取的行不会，需要在这个回调里自己重新请求。
   */
  onInvalidate(listener: (event: FlowixInvalidateEvent) => void): () => void;

  /** 最近一次自动拉取合并出的数据根；尚未拉取时为 null。 */
  readonly data: Record<string, unknown> | null;

  /** 产品内部（技能市场页面用），普通工作台页面不需要。 */
  installTemplate(templateId: string): Promise<unknown>;
  /** 产品内部（技能市场页面用），普通工作台页面不需要。 */
  openSkillMarketView(view: 'templates'): Promise<boolean>;
}

declare global {
  interface Window {
    /** 只在笔记本内的嵌入页面里存在；普通网页没有这个对象。 */
    flowix: FlowixEmbedApi;
  }
}
