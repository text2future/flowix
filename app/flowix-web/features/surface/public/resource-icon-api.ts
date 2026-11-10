/**
 * 资源树图标入口：侧边栏「访问空间」用的文件/文件夹图标，面包屑弹层的
 * 文件夹段复用其中的文件夹图标，保证两处视觉统一。
 *
 * 单独一个 public 文件而不是塞进 `shell-api`，因为这个包只被树组件用到，
 * 让需要它的 feature 不必顺着 surface 的运行时大 barrel 走一遍。
 */
export { ResourceFileIcon, ResourceFolderIcon } from '@features/surface/resource-file-icon';
