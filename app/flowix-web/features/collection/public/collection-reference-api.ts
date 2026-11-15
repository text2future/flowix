/**
 * 嵌入引用（表格 / 媒体库 / 资料列表节点）解析 collectionId → 文件身份与内容。
 *
 * 三个引用节点都要这一份解析，而它们分别住在自己的 subtype feature 里；把钩子
 * 收进 public 入口，别人就不用去摸 collection 的私有路径。
 */
export { useCollectionReference } from '../use-collection-reference';
