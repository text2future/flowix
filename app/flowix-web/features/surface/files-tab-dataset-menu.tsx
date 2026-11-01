'use client';

/**
 * 「文件树」tab 的数据集合按钮 ── nav 右侧操作槽里的一枚漏斗。
 *
 * 文件树的数据集就是**集合所在的文件夹**：位置固定、不可修改；文件树也不提供
 * 筛选（它展示的是目录本身的一层内容）。所以这个菜单只有一条**只读的位置行**，
 * 与笔记视图（笔记筛选）/ 资料视图（资料筛选）各自的数据集合菜单口径对齐：
 * 同一个按钮、同一套「位置行」视觉，筛选按 tab 类型各自取舍。
 */
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { CollectionDatasetMenu } from '@shared/ui/collection-dataset-menu';
import { MediaLibraryFilterPanel } from '@features/media-library/public/surface-api';

export function FilesTabDatasetMenu({ fixedFolderPath, notebookAvailable, busy = false }: {
  /** 固定的取值位置（笔记本相对路径，'' = 笔记本根目录）。 */
  fixedFolderPath: string;
  notebookAvailable: boolean;
  busy?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <CollectionDatasetMenu open={open} onOpenChange={setOpen} disabled={busy}
      title={t('collection.dataset.location')} label={t('collection.dataset.manage')}
      location={<MediaLibraryFilterPanel
          fileName=""
          fileTypes={[]}
          showTypeSelect={false}
          path=""
          fixedFolderPath={fixedFolderPath}
          folderPickerOpen={false}
          folderOptions={[]}
          folderOptionsLoading={false}
          notebookAvailable={notebookAvailable}
          busy={busy}
          locationOnly
          showLocationMenu={false}
          onFileNameChange={() => {}}
          onFileTypesChange={() => {}}
          onPathChange={() => {}}
          onFolderPickerOpenChange={() => {}}
          onReset={() => {}}
          onApply={() => {}}
        />} />
  );
}
