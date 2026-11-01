/**
 * 集合标题的公开入口。
 *
 * 两种标题形态，按外壳场景二选一（一个集合只出现一处名字）：
 *   - `CollectionTitle`：嵌在 tab 条左侧的**小标题**（表格自身 nav）；
 *   - `CollectionNameHeader`：**直接打开的集合**（文件夹 / 集合文件）顶部的大标题头。
 *
 * `CollectionDisplayMenu` 是名字与头图的显隐入口（Work 列 header 的「···」），
 * 与「显示标题」同一条偏好、与「显示头图」同一个集合属性，所以和标题放在一起导出。
 *
 * 两者共用同一份名称编辑实现（`EditableCollectionName` + `useCollectionNameEdit`）：
 * 双击改名、Enter / 失焦保存、Esc 退出不保存、hover 底色 + 圆角，一条交互规则。
 *
 * 它们属于 collection 的展示层，调用方不该 import `features/collection/collection-title`
 * 这类私有路径（会触犯跨模块 public 边界门禁）。
 */
export { CollectionTitle } from '@features/collection/collection-title';
export { CollectionNameHeader, CollectionHeaderIcon, collectionHeaderTitle, type CollectionHeaderTitle, type CollectionHeaderSubtitle } from '@features/collection/collection-name-header';
export { CollectionDisplayMenu } from '@features/collection/collection-display-menu';
export { CollectionDisplayMenuItems } from '@features/collection/collection-display-menu';
export { useCollectionNameEdit } from '@features/collection/use-collection-name-edit';
export type { CollectionNameEditControls } from '@features/collection/editable-collection-name';
