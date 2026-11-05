/**
 * 集合文件内容广播的公开入口 ── 任何持有集合文件内存副本的 feature（表格、图墙、
 * 列表）都应订阅它，而不是自己找刷新时机。
 *
 * 写入侧（`document-gateway`）只给集合自身用，不从这里导出：别的 feature 要改集合，
 * 必须走集合 feature 的动作，避免再长出第二个写入口。
 */
export {
  isSameCollectionFile,
  publishCollectionContent,
  subscribeCollectionContent,
  type CollectionContentChange,
} from '../content-events';
