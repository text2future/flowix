'use client';

/**
 * 集合各 tab 的右键菜单**条目定义**（唯一来源）。
 *
 * tab 类型 → 菜单项：
 *   files（文件树）      新建笔记 / 新建文件夹 / 导入文件… / 导入文件夹…
 *   notes（表格、画廊…）  新建笔记 / 导入笔记 .md
 *   assets（图墙、列表）  导入文件…
 *
 * 各 tab 只传「本 tab 真的能做的事」的回调，缺省的那一项就不出现；
 * 菜单长什么样由 `CollectionAreaMenu` 统一渲染。
 */
import { DownloadSimpleIcon, FileArrowDownIcon, FileIcon, FileMdIcon, FolderOpenIcon, FolderSimplePlusIcon } from '@phosphor-icons/react';
import type { CollectionAreaMenuItem } from '@shared/ui/collection-area-menu';
import type { I18nKey } from '@/lib/i18n';

type Translate = (key: I18nKey) => string;

const ICON_CLASS = 'h-4 w-4 shrink-0';

/** 丢掉「本 tab 不支持」的项（回调缺省即为 null）。 */
function compact(items: Array<CollectionAreaMenuItem | null>): CollectionAreaMenuItem[] {
  return items.filter((item): item is CollectionAreaMenuItem => item !== null);
}

/** 文件树 tab：笔记与文件夹都能建，文件和文件夹都能导入。 */
export function filesAreaMenuItems({ t, onCreateNote, onCreateFolder, onImportFiles, onImportFolder }: {
  t: Translate;
  onCreateNote?: () => void;
  onCreateFolder?: () => void;
  onImportFiles?: () => void;
  onImportFolder?: () => void;
}): CollectionAreaMenuItem[] {
  return compact([
    onCreateNote ? { key: 'new-note', label: t('memo.fileTree.newNote'), icon: <FileIcon className={ICON_CLASS} aria-hidden="true" />, onSelect: onCreateNote } : null,
    onCreateFolder ? { key: 'new-folder', label: t('memo.fileTree.newFolder'), icon: <FolderSimplePlusIcon className={ICON_CLASS} aria-hidden="true" />, onSelect: onCreateFolder } : null,
    onImportFiles ? { key: 'import-files', label: t('memo.fileTree.importFiles'), icon: <DownloadSimpleIcon className={ICON_CLASS} aria-hidden="true" />, onSelect: onImportFiles } : null,
    onImportFolder ? { key: 'import-folder', label: t('memo.fileTree.importFolder'), icon: <FolderOpenIcon className={ICON_CLASS} aria-hidden="true" />, onSelect: onImportFolder } : null,
  ]);
}

/** 笔记视图 tab（表格 / 画廊 / 看板 / 日历）：建一条笔记记录，或导入现成的 .md。 */
export function noteAreaMenuItems({ t, onCreateNote, onImportNotes }: {
  t: Translate;
  onCreateNote?: () => void;
  onImportNotes?: () => void;
}): CollectionAreaMenuItem[] {
  return compact([
    onCreateNote ? { key: 'new-note', label: t('memo.fileTree.newNote'), icon: <FileIcon className={ICON_CLASS} aria-hidden="true" />, onSelect: onCreateNote } : null,
    onImportNotes ? { key: 'import-notes', label: t('collection.areaMenu.importNotes'), icon: <FileMdIcon className={ICON_CLASS} aria-hidden="true" />, onSelect: onImportNotes } : null,
  ]);
}

/** 资料视图 tab（图墙 / 列表）：只能往集合里导入文件。 */
export function assetAreaMenuItems({ t, onImportFiles }: {
  t: Translate;
  onImportFiles?: () => void;
}): CollectionAreaMenuItem[] {
  return compact([
    onImportFiles ? { key: 'import-files', label: t('memo.fileTree.importFiles'), icon: <FileArrowDownIcon className={ICON_CLASS} aria-hidden="true" />, onSelect: onImportFiles } : null,
  ]);
}
