/**
 * 集合 tab 条的全部对外能力：tab 的数据形状与排列、单个 tab 的渲染、宿主 tab 的
 * 渲染，以及改名 / 删除动作与共用的就地编辑框。
 *
 * 表格外壳（`multidimensional-table`）只从这里拿——一条 tab 条的结构在集合这一侧，
 * 表格只决定「哪些 tab 插在哪一段」。
 *
 * 键的语法（`files` / `notes:<视图id>` / `<域>:<视图id>`）不在这里重新定义，
 * 统一来自 `lib/collection-tab-key.ts`；这里一并转出去，调用方不必再往下找一层。
 */
export type { CollectionHostTab, CollectionTabSections } from '../collection-host-tab';
export { HOST_TAB_ID_PREFIX, collectionTabList, filesHostTab, hostTabEditId, hostTabKeyFromEditId, isHostTabEditId } from '../collection-host-tab';
export { HostTabButtons } from '../host-tab-buttons';
export { TabStripItem } from '../tab-strip-item';
export { useHostTabActions } from '../use-host-tab-actions';
export { useTabInlineEdit, type TabInlineEdit } from '../use-tab-inline-edit';
export {
  ASSET_DOMAINS,
  FILES_TAB_KEY,
  NOTES_TAB_KEY,
  assetTabKey,
  isAssetDomain,
  isNoteTabKey,
  noteTabKey,
  noteViewIdFromTabKey,
  parseAssetTabKey,
  viewIdFromTabKey,
  type AssetDomain,
  type AssetTabKey,
  type HostTabKey,
  type NoteTabKey,
} from '@/lib/collection-tab-key';
