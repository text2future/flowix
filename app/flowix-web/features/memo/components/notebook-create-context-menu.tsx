import { FileIcon, FolderSimplePlusIcon, PlusIcon } from '@phosphor-icons/react';
import { GalleryHorizontalEnd, Table2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSubmenu } from '@shared/ui/context-menu';

const MENU_ITEM_CLASS =
  'h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';

export function NotebookCreateContextMenuItems({
  onCreateNote,
  onCreateFolder,
  onCreateTable,
  onCreateMediaLibrary,
}: {
  onCreateNote: () => void;
  onCreateFolder: () => void;
  onCreateTable: () => void;
  onCreateMediaLibrary: () => void;
}) {
  const { t } = useI18n();

  return (
    <>
      <ContextMenuItem onClick={onCreateNote} className={MENU_ITEM_CLASS}>
        <FileIcon className="mr-2 h-4 w-4" aria-hidden="true" />
        {t('memo.fileTree.newNote')}
      </ContextMenuItem>
      <ContextMenuItem onClick={onCreateFolder} className={MENU_ITEM_CLASS}>
        <FolderSimplePlusIcon className="mr-2 h-4 w-4" aria-hidden="true" />
        {t('memo.fileTree.newFolder')}
      </ContextMenuItem>
      <ContextMenuSubmenu label={t('memo.create.more')} icon={<PlusIcon className="h-4 w-4" aria-hidden="true" />}>
        <ContextMenuItem onClick={onCreateTable} className={MENU_ITEM_CLASS}>
          <Table2 className="mr-2 h-4 w-4" aria-hidden="true" />
          {t('memo.create.table')}
        </ContextMenuItem>
        <ContextMenuItem onClick={onCreateMediaLibrary} className={MENU_ITEM_CLASS}>
          <GalleryHorizontalEnd className="mr-2 h-4 w-4" aria-hidden="true" />
          {t('memo.create.mediaLibraryTitle')}
        </ContextMenuItem>
      </ContextMenuSubmenu>
      <ContextMenuSeparator />
    </>
  );
}
