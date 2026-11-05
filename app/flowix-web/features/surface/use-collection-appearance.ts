import { useCallback, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import { toast } from '@/lib/toast';
import { resolveCollectionScope, updateCollectionProperties, ensureFolderCollection,
  type CollectionProperty, type FolderCollectionSummary } from '@features/collection/public/folder-api';

export function useCollectionAppearance({ existing, indexPath, notebookPath, notebookId,
  isFolderCollection, currentFolderPath, folderName, editable, setSummary }: {
  existing: FolderCollectionSummary | null; indexPath: string; notebookPath: string | null;
  notebookId: string | null; isFolderCollection: boolean; currentFolderPath: string | null;
  folderName: string; editable: boolean; setSummary: (summary: FolderCollectionSummary) => void;
}) {
  const { t } = useI18n();
  /**
   * 顶部图片导览的取值范围：只认集合自己的**媒体域**（与媒体库面板同一个换算）。
   * 该范围仅用于用户主动选择图片，不决定头图是否显示。
   */
  const bannerScope = useMemo(() => {
    if (!notebookPath) return undefined;
    // 头图是文件夹集合的外观属性，即使尚未添加图墙域，也允许从集合目录选图。
    // 首次打开且还没有集合文件时，按新建文件夹集合的默认媒体范围（含子目录）取图。
    const source = existing?.domains.includes('media')
      ? existing.sources?.media
      : isFolderCollection ? { scope: 'containing_folder' as const } : undefined;
    if (!source) return undefined;
    return resolveCollectionScope(source, indexPath, notebookPath);
  }, [existing, indexPath, isFolderCollection, notebookPath]);

  // 缺省隐藏；只有用户明确开启（banner_hidden=false）才显示。
  const bannerHidden = existing?.properties?.banner_hidden?.value !== false;
  const selectedImage = typeof existing?.properties?.banner_image?.value === 'string'
    ? existing.properties.banner_image.value
    : undefined;

  /** 局部更新集合属性并就地刷新 summary（避免重读整页）。 */
  const [bannerBusy, setBannerBusy] = useState(false);
  /** 并发闸用 ref：同一同步任务里连着的两次调用（如外点兜底 + 失焦）state 来不及更新。 */
  const bannerBusyRef = useRef(false);
  const updateBannerProperties = useCallback(async (properties: Record<string, CollectionProperty | null>) => {
    if (!editable || !notebookId || !notebookPath || bannerBusyRef.current) return;
    if (!existing && (!isFolderCollection || !currentFolderPath)) return;
    bannerBusyRef.current = true;
    setBannerBusy(true);
    try {
      // 文件夹集合可以先以默认文件树打开；只有用户实际修改外观时才创建索引。
      // notes 是文件夹集合的默认域，沿用其他首次创建入口的集合结构。
      const target = existing ?? await ensureFolderCollection(currentFolderPath!, notebookPath, folderName, 'notes');
      if (!existing) setSummary(target);
      const result = await updateCollectionProperties({
        notebookId, notebookPath, collectionId: target.collectionId,
        expectedRevision: target.revision, properties,
      });
      setSummary(result);
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'collection.openFailed'));
    } finally {
      bannerBusyRef.current = false;
      setBannerBusy(false);
    }
  }, [currentFolderPath, existing, folderName, isFolderCollection, notebookId, notebookPath, t, editable, setSummary]);

  /** 「···」→「显示头图 / 隐藏头图」：显式写入 `banner_hidden`。 */
  const toggleBannerHidden = useCallback(() => {
    void updateBannerProperties({ banner_hidden: { type: 'Boolean', value: !bannerHidden } });
  }, [bannerHidden, updateBannerProperties]);

  /** 头图悬浮工具条「切换图片」：选定 / 清空 `banner_image`。 */
  const selectBannerImage = useCallback((relativePath: string | null) => {
    void updateBannerProperties({ banner_image: relativePath ? { type: 'Text', value: relativePath } : null });
  }, [updateBannerProperties]);

  /** 副标题：读集合属性 `subtitle`（Text），空值时属性不存在。 */
  const subtitleValue = typeof existing?.properties?.subtitle?.value === 'string'
    ? (existing.properties.subtitle.value as string)
    : '';
  const saveSubtitle = useCallback((value: string) => {
    void updateBannerProperties({ subtitle: value ? { type: 'Text', value } : null });
  }, [updateBannerProperties]);

  /** 集合图标：读集合属性 `icon`（Text），存的是属性图标 value（如 `dog-face`）；
   * 空值 = 按首个视图使用默认集合图标。点击头图处的图标打开 picker 改它（见外壳 bannerNode）。 */
  const iconValue = typeof existing?.properties?.icon?.value === 'string'
    ? (existing.properties.icon.value as string)
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
