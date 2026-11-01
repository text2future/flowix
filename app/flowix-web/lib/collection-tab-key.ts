/**
 * 集合 tab 键的**唯一语法**（基础层：纯函数、无 React、无 IO，可被 lib / features 共同引用）。
 *
 * 一条集合 tab 条上只有三类 tab，键的写法就是它们的身份：
 *
 *   `files`                 文件树（外壳自身的 tab，只属于文件夹类型的集合）
 *   `notes:<viewId>`        笔记视图（表格 / 画廊 / 看板 / 日历，建在表格数据上）
 *   `<domain>:<viewId>`     资料视图（`media` 图墙 / `work_documents` 列表）
 *
 * 「当前 tab」的本地偏好（`lib/collection-host-tab.ts`）在这三种之外多一个
 * `notes`：表示**表格视图自身**，等价于外壳里的 `activeHostTab === null`。
 * 旧版本还写过域级键（`media` / `work_documents`），读取时按该域的默认视图回落。
 *
 * 解析一律走这里 —— 任何 `slice(6)` / `indexOf(':')` 都是这份语法的重复实现。
 */

/** 文件树 tab 的键（外壳自身，不可改名、不可删除）。 */
export const FILES_TAB_KEY = 'files';

/** 偏好里的「表格视图自身」，与外壳的 `activeHostTab === null` 同义。 */
export const NOTES_TAB_KEY = 'notes';

/** 笔记视图键的前缀（`notes:<viewId>`）。 */
export const NOTE_TAB_PREFIX = 'notes:';

/** 资料域：可按视图实例平铺成多个 tab 的两个域（顺序即 tab 条的默认顺序）。 */
export const ASSET_DOMAINS = ['media', 'work_documents'] as const;

export type AssetDomain = (typeof ASSET_DOMAINS)[number];
export type NoteTabKey = `${typeof NOTE_TAB_PREFIX}${string}`;
export type AssetTabKey = `${AssetDomain}:${string}`;
/** 宿主 tab（外壳自己的 tab）：文件树或某个资料视图。 */
export type HostTabKey = typeof FILES_TAB_KEY | AssetTabKey;

/** 「当前 tab」的偏好值：三类 tab 键 + 表格视图自身 + 旧域级键。 */
export type CollectionTabPreference =
  | typeof NOTES_TAB_KEY
  | typeof FILES_TAB_KEY
  | AssetDomain
  | NoteTabKey
  | AssetTabKey;

export function isAssetDomain(value: string): value is AssetDomain {
  return (ASSET_DOMAINS as readonly string[]).includes(value);
}

/** 笔记视图 tab 键。 */
export function noteTabKey(viewId: string): NoteTabKey {
  return `${NOTE_TAB_PREFIX}${viewId}`;
}

export function isNoteTabKey(key: string): key is NoteTabKey {
  return key.startsWith(NOTE_TAB_PREFIX);
}

/** `notes:<viewId>` → `viewId`；不是笔记视图键或 id 为空时返回 null。 */
export function noteViewIdFromTabKey(key: string): string | null {
  if (!isNoteTabKey(key)) return null;
  return key.slice(NOTE_TAB_PREFIX.length) || null;
}

/** 资料视图 tab 键。 */
export function assetTabKey(domain: AssetDomain, viewId: string): AssetTabKey {
  return `${domain}:${viewId}`;
}

/** `<domain>:<viewId>` → `{ domain, viewId }`；域不合法或 id 为空时返回 null。 */
export function parseAssetTabKey(key: string): { domain: AssetDomain; viewId: string } | null {
  const index = key.indexOf(':');
  if (index <= 0) return null;
  const domain = key.slice(0, index);
  const viewId = key.slice(index + 1);
  if (!viewId || !isAssetDomain(domain)) return null;
  return { domain, viewId };
}

/** 视图型 tab（笔记视图或资料视图）→ 视图 id；文件树 / 表格自身返回 null。 */
export function viewIdFromTabKey(key: string): string | null {
  return noteViewIdFromTabKey(key) ?? parseAssetTabKey(key)?.viewId ?? null;
}

/** 本地偏好里读出来的字符串是否是一个已知的 tab 键（用于校验 localStorage 内容）。 */
export function isCollectionTabPreference(value: string): value is CollectionTabPreference {
  if (value === NOTES_TAB_KEY || value === FILES_TAB_KEY) return true;
  if (isAssetDomain(value)) return true;
  return noteViewIdFromTabKey(value) !== null || parseAssetTabKey(value) !== null;
}
