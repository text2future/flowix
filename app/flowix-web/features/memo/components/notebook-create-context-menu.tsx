import { DatabasePlus, Download, FilePlusCorner, FolderPlus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSubmenu } from '@shared/ui/context-menu';
import type { TableViewType } from '@features/multidimensional-table/public/create-api';
import { MEMO_CREATE_VIEW_OPTIONS } from './memo-create-view-options';

const MENU_ITEM_CLASS =
  'group h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--hover-bg)]';
const VIEW_MENU_ITEM_CLASS =
  'memo-navigation-submenu-item memo-navigation-submenu-item--neutral-hover mention-note-item !grid !grid-cols-[minmax(0,1fr)_auto] !gap-3 !h-7 !min-h-7 !rounded-lg !py-0 !pl-[6px] !pr-2 hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)] focus-visible:outline-none';

export function NotebookCreateContextMenuItems({
  onCreateNote,
  onCreateFolder,
  onCreateTable,
  onCreateMediaLibrary,
  onCreateWorkDocuments,
  onImportFiles,
  onImportFolder,
  contentCreationBlocked = false,
}: {
  onCreateNote: () => void;
  onCreateFolder: () => void;
  onCreateTable: (viewType?: TableViewType) => void;
  onCreateMediaLibrary: () => void;
  onCreateWorkDocuments?: () => void;
  onImportFiles?: () => void;
  onImportFolder?: () => void;
  /**
   * Folder is skipped by every index, so notes and views created here would
   * never appear in any list. Entries stay visible to explain why. Folder
   * creation and file import stay enabled: those are not indexed content.
   */
  contentCreationBlocked?: boolean;
}) {
  const { t } = useI18n();
  const blockedHint = contentCreationBlocked ? t('memo.fileTree.contentCreationBlocked') : undefined;

  return (
    <>
      <ContextMenuItem
        onClick={onCreateNote}
        disabled={contentCreationBlocked}
        title={blockedHint}
        className={MENU_ITEM_CLASS}
      >
        <FilePlusCorner className="mr-2 h-4 w-4" aria-hidden="true" />
        {t('memo.fileTree.newNote')}
      </ContextMenuItem>
      <ContextMenuItem onClick={onCreateFolder} className={MENU_ITEM_CLASS}>
        <FolderPlus className="mr-2 h-4 w-4" aria-hidden="true" />
        {t('memo.fileTree.newFolder')}
      </ContextMenuItem>
      <ContextMenuSubmenu
        label={t('memo.create.newView')}
        icon={<DatabasePlus className="h-4 w-4" aria-hidden="true" />}
        disabled={contentCreationBlocked}
        title={blockedHint}
      >
        {MEMO_CREATE_VIEW_OPTIONS.map(({ type, labelKey }) => (
          <ContextMenuItem key={type} onClick={() => onCreateTable(type)} className={VIEW_MENU_ITEM_CLASS}>
            <span className="mention-note-title">{t(labelKey)}</span>
            <span className="mention-note-notebook justify-self-end text-right opacity-50">{t('memo.create.note')}</span>
          </ContextMenuItem>
        ))}
        <ContextMenuItem onClick={onCreateMediaLibrary} className={VIEW_MENU_ITEM_CLASS}>
          <span className="mention-note-title">{t('memo.create.mediaLibraryMenuLabel')}</span>
          <span className="mention-note-notebook justify-self-end text-right opacity-50">{t('memo.create.assetShort')}</span>
        </ContextMenuItem>
        {onCreateWorkDocuments && <ContextMenuItem onClick={onCreateWorkDocuments} className={VIEW_MENU_ITEM_CLASS}>
          <span className="mention-note-title">{t('memo.create.workDocumentsMenuLabel')}</span>
          <span className="mention-note-notebook justify-self-end text-right opacity-50">{t('memo.create.assetShort')}</span>
        </ContextMenuItem>}
      </ContextMenuSubmenu>
      {(onImportFiles || onImportFolder) && <ContextMenuSubmenu label={t('memo.fileTree.import')} icon={<Download className="h-4 w-4" aria-hidden="true" />}>
        {onImportFiles && <ContextMenuItem onClick={onImportFiles} className={MENU_ITEM_CLASS}>{t('memo.fileTree.importFiles')}</ContextMenuItem>}
        {onImportFolder && <ContextMenuItem onClick={onImportFolder} className={MENU_ITEM_CLASS}>{t('memo.fileTree.importFolder')}</ContextMenuItem>}
      </ContextMenuSubmenu>}
      <ContextMenuSeparator />
    </>
  );
}
