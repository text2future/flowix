export {
  addCollectionDomain,
  addCollectionView,
  addFolderCollectionDomain,
  collectionIndexPathForFolder,
  createFolderCollectionContent,
  createFolderHybridCollectionContent,
  ensureFolderCollection,
  readCollectionSummary,
  readFolderCollectionSummary,
  reorderCollectionViews,
  removeCollectionDomain,
  removeCollectionView,
  removeFolderCollectionDomain,
  renameCollectionView,
  setCollectionAssetFilter,
  switchFolderCollectionType,
  summarizeFolderCollectionSource,
  type AddCollectionViewResult,
  type FolderCollectionViewSummary,
} from '../folder-collection';
export { ASSET_KINDS, MEDIA_ASSET_KINDS, WORK_ASSET_KINDS, assetConditionFromFilter, assetKindsForUniverse, normalizeAssetFilterCondition, type AssetFilterCondition, type AssetFilterSaveOptions, type AssetKind } from '../asset-filter';
export type { FolderCollectionSummary } from '../folder-collection';
export { parseCollectionDocumentV2, reviseCollection } from '../model';
export { FolderCollectionSwitchConfirmDialog } from '../folder-collection-switch-confirm-dialog';
export { resolveCollectionLocationScope, pathInCollectionScope, resolveCollectionScope, type CollectionScope } from '../collection-scope';
/** 集合的保存目录：新建笔记 / 导入文件 / 媒体上传的唯一落点策略。 */
export { resolveCollectionSaveDirectory } from '../save-location';
export { ONLINE_BANNER_IMAGES, onlineBannerBase, onlineBannerCropUrl, onlineBannerThumbUrl } from '../online-banner-images';
export type { CollectionType, CollectionDomain, CollectionProperty } from '../model';

import { mutateCollectionFile } from '../mutations';
import { summarizeFolderCollectionSource } from '../folder-collection';
import type { FolderCollectionSummary } from '../folder-collection';
import type { CollectionProperty } from '../model';

/**
 * 局部更新集合自有属性（如头图隐藏 / 头图指定图源）并回读最新归纳。
 *
 * `collections.mutate` 对 `properties` 是**合并**语义：只写入/删除本次提供的键，
 * 其余属性（图标、颜色等）原样保留。返回重算的 summary，便于外壳就地刷新状态。
 */
export async function updateCollectionProperties(options: {
  notebookId: string;
  notebookPath: string;
  collectionId: string;
  expectedRevision: number;
  properties: Record<string, CollectionProperty | null>;
}): Promise<FolderCollectionSummary> {
  const result = await mutateCollectionFile(options);
  return summarizeFolderCollectionSource(result.content);
}

export { addCollectionNoteView } from '../note-view-mutations';
