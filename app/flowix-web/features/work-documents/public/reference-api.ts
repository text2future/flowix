/**
 * `work-documents` 对外只有两样东西：编辑器要注册的引用节点，以及斜杠菜单要
 * 打开的引用选择器。文档模型（解析 / 序列化 / 建文件）已经下沉到
 * `@features/collection/public/work-documents-model-api`——那是集合协议的一层
 * 适配，不该绑在「编辑器里怎么显示」这个 feature 上。
 */
export { WorkDocumentsReference } from '../work-documents-reference-node';
export { openWorkDocumentsReferencePicker } from '../work-documents-reference-picker';
