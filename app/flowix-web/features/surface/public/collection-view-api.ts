/**
 * 列表集合视图的对外入口。
 *
 * 编辑器里的「资料列表引用」节点要把这张列表**内嵌**进正文，和集合表面渲染的
 * 是同一个组件。节点必须懒加载它（`import()`），所以这里只做转发，不额外引入
 * 任何模块——真正的代码分割仍发生在调用方的动态 import 上。
 */
export { WorkDocumentsCollectionView } from '../work-documents-collection-view';
