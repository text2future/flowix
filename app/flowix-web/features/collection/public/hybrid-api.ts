/** 集合 v3 hybrid 的投影/合并 API：表格、媒体库、工作文档会话与文件夹首页
 *  通过这里把单类型文档写回 hybrid 来源（按域合并），避免交叉深引用。 */
export {
  collectionSourceDomain,
  collectionDomainType,
  collectionTypeDomain,
  collectionWriteContent,
  isHybridCollectionSource,
  parseHybridCollection,
  serializeHybridCollectionDocument,
  serializeProjectedCollectionDocument,
  COLLECTION_DOMAINS,
} from '../model';
export type {
  CollectionDomain,
  HybridCollectionPayload,
  HybridCollectionDocument,
  HybridCollectionView,
  ProjectedCollectionDocument,
} from '../model';
