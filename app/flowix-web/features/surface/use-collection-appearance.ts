import { useCallback, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { notebookRelativeDirectoryPath } from '@/lib/path';
import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import { toast } from '@/lib/toast';
import { resolveCollectionScope, updateCollectionProperties,
  type CollectionProperty, type FolderCollectionSummary } from '@features/collection/public/folder-api';
import { saveFolderAppearance, useFolderAppearance } from '@features/collection/public/appearance-api';

/**
 * 表面的外观（头图 / 图标 / 副标题）。
 *
 * 两种来源，读写的落点不同但状态形状一致：
 *   - 集合表面：属性在集合文件的 `collection.properties` 里；
 *   - 文件夹表面（`folderOnly`）：属性在 `folder_index` 表里，键是目录的笔记本
 *     相对路径。文件夹不再为外观创建一个 `.index.yaml` 集合 —— 这是这次改造的
 *     全部意义，所以这里没有任何创建集合的兜底。
 */
export function useCollectionAppearance({ existing, indexPath, notebookPath, notebookId,
  isFolderCollection, currentFolderPath, editable, setSummary, folderOnly = false }: {
  existing: FolderCollectionSummary | null; indexPath: string; notebookPath: string | null;
  notebookId: string | null; isFolderCollection: boolean; currentFolderPath: string | null;
  editable: boolean; setSummary: (summary: FolderCollectionSummary) => void;
  folderOnly?: boolean;
}) {
  const { t } = useI18n();
  /** 文件表面 → 目录的笔记本相对路径（`''` = 根目录）；不属于该笔记本时 null。 */
  const relativeFolder = useMemo(() => {
    if (!notebookPath || !currentFolderPath) return null;
    return notebookRelativeDirectoryPath(notebookPath, currentFolderPath);
  }, [currentFolderPath, notebookPath]);
  // 只有文件夹表面才订阅这张表：集合表面不该为别人的图标多付一次整表查询。
  const folderProperties = useFolderAppearance(
    folderOnly ? notebookPath : null,
    folderOnly ? currentFolderPath : null,
    folderOnly ? notebookId : null,
  );
  const properties = folderOnly ? folderProperties : existing?.properties;
  /**
   * 顶部图片导览的取值范围：只认集合自己的**媒体域**（与媒体库面板同一个换算）。
   * 文件夹表面没有媒体域，直接按目录取图 —— 这也是用户选头图时唯一说得通的范围。
   */
  const bannerScope = useMemo(() => {
    if (!notebookPath) return undefined;
    if (folderOnly) return relativeFolder === null ? undefined : { relativePath: relativeFolder, depth: 'descendants' as const };
    // 头图是集合的外观属性，即使尚未添加图墙域，也允许从集合目录选图。
    const source = existing?.domains.includes('media')
      ? existing.sources?.media
      : isFolderCollection ? { scope: 'containing_folder' as const } : undefined;
    if (!source) return undefined;
    return resolveCollectionScope(source, indexPath, notebookPath);
  }, [existing, folderOnly, indexPath, isFolderCollection, notebookPath, relativeFolder]);

  // 缺省隐藏；只有用户明确开启（banner_hidden=false）才显示。
  const bannerHidden = properties?.banner_hidden?.value !== false;
  const selectedImage = typeof properties?.banner_image?.value === 'string'
    ? properties.banner_image.value
    : undefined;

  /** 局部更新外观属性并就地刷新（避免重读整页）。 */
  const [bannerBusy, setBannerBusy] = useState(false);
  /** 并发闸用 ref：同一同步任务里连着的两次调用（如外点兜底 + 失焦）state 来不及更新。 */
  const bannerBusyRef = useRef(false);
  const updateBannerProperties = useCallback(async (next: Record<string, CollectionProperty | null>) => {
    if (!editable || !notebookPath || bannerBusyRef.current) return;
    bannerBusyRef.current = true;
    setBannerBusy(true);
    try {
      if (folderOnly) {
        if (relativeFolder === null) return;
        // 文件夹外观写表；事件 `folder-index-changed` 会把新属性推回缓存，
        // 所以这里不维护第二份本地状态。
        await saveFolderAppearance(notebookPath, relativeFolder, next);
        return;
      }
      if (!notebookId || !existing) return;
      const result = await updateCollectionProperties({
        notebookId, notebookPath, collectionId: existing.collectionId,
        expectedRevision: existing.revision, properties: next,
      });
      setSummary(result);
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'collection.openFailed'));
    } finally {
      bannerBusyRef.current = false;
      setBannerBusy(false);
    }
  }, [existing, folderOnly, notebookId, notebookPath, relativeFolder, t, editable, setSummary]);

  /** 「···」→「显示头图 / 隐藏头图」：显式写入 `banner_hidden`。 */
  const toggleBannerHidden = useCallback(() => {
    void updateBannerProperties({ banner_hidden: { type: 'Boolean', value: !bannerHidden } });
  }, [bannerHidden, updateBannerProperties]);

  /** 头图悬浮工具条「切换图片」：选定 / 清空 `banner_image`。 */
  const selectBannerImage = useCallback((relativePath: string | null) => {
    void updateBannerProperties({ banner_image: relativePath ? { type: 'Text', value: relativePath } : null });
  }, [updateBannerProperties]);

  /** 副标题：读属性 `subtitle`（Text），空值时属性不存在。 */
  const subtitleValue = typeof properties?.subtitle?.value === 'string'
    ? (properties.subtitle.value as string)
    : '';
  const saveSubtitle = useCallback((value: string) => {
    void updateBannerProperties({ subtitle: value ? { type: 'Text', value } : null });
  }, [updateBannerProperties]);

  /** 集合图标：读属性 `icon`（Text），存的是属性图标 value（如 `dog-face`）；
   * 空值 = 使用默认图标。点击头图处的图标打开 picker 改它（见外壳 bannerNode）。 */
  const iconValue = typeof properties?.icon?.value === 'string'
    ? (properties.icon.value as string)
    : '';
  const saveIcon = useCallback((value: string) => {
    void updateBannerProperties({ icon: value ? { type: 'Text', value } : null });
  }, [updateBannerProperties]);

  return {
    banner: { visible: !bannerHidden, selectedImage, scope: bannerScope, busy: bannerBusy,
      toggleHidden: toggleBannerHidden, selectImage: selectBannerImage },
    subtitle: { value: subtitleValue, save: saveSubtitle },
    icon: { value: iconValue, save: saveIcon },
  };
}
