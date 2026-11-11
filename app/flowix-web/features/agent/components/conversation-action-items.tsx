import { ArchiveIcon, PencilSimpleIcon, SquareSplitHorizontalIcon, StarIcon, TrashSimpleIcon } from '@phosphor-icons/react';
import { DropdownMenuItem, DropdownMenuSeparator } from '@shared/ui/dropdown-menu';
import { ContextMenuItem } from '@shared/ui/context-menu';
import { useI18n } from '@/lib/i18n';

export function ConversationActionItems({ context = false, archiveSeparator = false, openHost = 'column-2', favorite, onOpen, onFavorite, onRename, onArchive, onDelete }: {
  context?: boolean;
  archiveSeparator?: boolean;
  /**
   * The host this menu item opens the conversation into; the label follows it
   * (the row's default click lands on the other host).
   */
  openHost?: 'column-2' | 'column-1';
  favorite: boolean;
  onOpen: () => void;
  onFavorite: () => void;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const Item = context ? ContextMenuItem : DropdownMenuItem;
  return (
    <>
      <Item onClick={onOpen} className="group h-7 items-center justify-start rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]">
        <SquareSplitHorizontalIcon className="mr-2 h-4 w-4" /> {t(openHost === 'column-1'
          ? 'tabWindow.context.openInWorkColumn'
          : 'memo.fileTree.openInRight')}
      </Item>
      <Item onClick={onFavorite} className="group h-7 items-center gap-2 rounded-lg px-2 py-0 hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]">
        <StarIcon className="h-4 w-4" weight={favorite ? 'fill' : 'regular'} />
        {favorite ? t('agent.chat.conversation.unfavorite') : t('agent.chat.conversation.favorite')}
      </Item>
      <Item onClick={onRename} className="group h-7 items-center gap-2 rounded-lg px-2 py-0 hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]">
        <PencilSimpleIcon className="h-4 w-4" /> {t('agent.chat.conversation.rename')}
      </Item>
      {archiveSeparator && <DropdownMenuSeparator />}
      <Item onClick={onArchive} className="group h-7 items-center gap-2 rounded-lg px-2 py-0 hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]">
        <ArchiveIcon className="h-4 w-4" /> {t('document.agent.archiveConversation')}
      </Item>
      <Item onClick={onDelete} className="group h-7 items-center gap-2 rounded-lg px-2 py-0 hover:bg-transparent hover:text-[var(--destructive)]">
        <TrashSimpleIcon className="h-4 w-4" /> {t('document.agent.deleteConversation')}
      </Item>
    </>
  );
}
