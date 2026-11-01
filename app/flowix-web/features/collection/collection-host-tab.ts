/**
 * 集合导航项的**唯一形状**与**唯一列表组装**。
 *
 * 外壳（`features/surface`）同时渲染文件树、笔记视图与资料视图三类 tab，它们的键
 * 语法只在 `lib/collection-tab-key.ts` 定义一次；本文件只回答两件事：
 *   - 一个 tab 长什么样（`CollectionHostTab`）；
 *   - 「宿主 tab + 笔记视图」怎么排成 tab 条上的三段（`collectionTabList`）。
 *
 * tab 条与「管理视图」弹窗必须用同一份排列，否则两侧的顺序与可删条件会各说各话。
 */
import { FILES_TAB_KEY, noteTabKey, type AssetDomain } from '@/lib/collection-tab-key';

export type { AssetDomain };

export interface CollectionHostTab {
  key: string;
  label: string;
  /** 插在内置视图 tab 之前（文件树）还是之后（笔记视图 / 资料视图）。 */
  placement: 'before' | 'after';
  /** 「管理视图」里是否可移除；文件树是外壳自身的 tab，不可移除。 */
  removable?: boolean;
  deleteDisabled?: boolean;
  /** 视图型 tab 的数据域；文件树与笔记视图没有（它们不对应资料域）。 */
  domain?: AssetDomain;
  /** 视图型 tab 对应的 hybrid 视图 id（改名 / 删除按它定位）；文件树没有。 */
  viewId?: string;
}

/** tab 条上的三段（顺序即渲染顺序）。 */
export interface CollectionTabSections {
  /** 文件树（外壳自身，只属于文件夹类型的集合）。 */
  before: CollectionHostTab[];
  /** 笔记视图：建在表格数据上，与资料视图平行。 */
  notes: CollectionHostTab[];
  /** 资料视图（图墙 / 列表）：按视图实例平铺。 */
  after: CollectionHostTab[];
  /** 三段按 tab 条顺序拼好的全集（「管理视图」按它列行）。 */
  all: CollectionHostTab[];
}

/** 文件树 tab：键固定 `files`，插在最前，外壳自身所有 —— 不可改名、不可移除。 */
export function filesHostTab(label: string): CollectionHostTab {
  return { key: FILES_TAB_KEY, label, placement: 'before' };
}

/**
 * 宿主 tab + 笔记视图 → tab 条的三段与全集。
 *
 * 笔记视图的 tab 键（`notes:<viewId>`）在这里才第一次生成：数据来自集合 summary 的
 * `views`，键来自语法表 —— 两处都不该自己拼字符串。
 *
 * `deleteDisabled` 的口径是「别把集合删空」：笔记视图看**笔记视图个数**（删掉最后一个
 * 笔记视图会让表格没有视图），资料视图看**全部视图个数**（删掉最后一个视图会让集合
 * 变成没有视图的空壳）。
 */
export function collectionTabList(
  hostTabs: readonly CollectionHostTab[],
  noteViews: readonly { id: string; name: string }[],
): CollectionTabSections {
  const before = hostTabs.filter((tab) => tab.placement === 'before');
  const after = hostTabs.filter((tab) => tab.placement !== 'before');
  const notes = noteViews.map<CollectionHostTab>((view) => ({
    key: noteTabKey(view.id),
    label: view.name,
    placement: 'after',
    removable: true,
    deleteDisabled: noteViews.length <= 1,
    viewId: view.id,
  }));
  return { before, notes, after, all: [...before, ...notes, ...after] };
}

/** 宿主 tab 与表格视图 tab 共用一条 tab 条上的就地改名输入框，靠这个前缀区分走哪条提交。 */
export const HOST_TAB_ID_PREFIX = 'host:';

export function hostTabEditId(key: string): string {
  return `${HOST_TAB_ID_PREFIX}${key}`;
}

/** 「管理视图」弹窗把宿主 tab 也列成一行，按前缀判断它其实是外壳的视图。 */
export function isHostTabEditId(id: string): boolean {
  return id.startsWith(HOST_TAB_ID_PREFIX);
}

export function hostTabKeyFromEditId(id: string): string {
  return id.slice(HOST_TAB_ID_PREFIX.length);
}
