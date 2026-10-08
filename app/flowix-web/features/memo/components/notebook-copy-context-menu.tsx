import { CopyIcon, FileTextIcon, LinkIcon } from '@phosphor-icons/react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { memoDocumentOperations } from '@features/document/public/file-operations-api';
import { useNoteStore } from '@features/memo/store/note-store';
import { buildNoteOpenLinkFromPath } from '@platform/open-target/path-link';
import { ContextMenuItem, ContextMenuSubmenu } from '@shared/ui/context-menu';

const ITEM_CLASS =
  'h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';

export function NotebookCopyContextMenu({ path, isNote }: { path: string; isNote: boolean }) {
  const { t } = useI18n();

  const copy = async (getText: () => string | Promise<string>, successKey: 'memo.fileTree.pathCopied' | 'document.command.copySuccess') => {
    try {
      await navigator.clipboard.writeText(await getText());
      toast.success(t(successKey));
    } catch (error) {
      console.warn('[NotebookCopyContextMenu] copy failed', error);
      toast.error(t('memo.fileTree.copyFailed'));
    }
  };

  return (
    <ContextMenuSubmenu label={t('memo.fileTree.copyMore')} icon={<CopyIcon className="h-4 w-4" aria-hidden="true" />}>
      <ContextMenuItem onClick={() => void copy(() => path, 'memo.fileTree.pathCopied')} className={ITEM_CLASS}>
        <CopyIcon className="mr-2 h-4 w-4" aria-hidden="true" />
        {t('memo.fileTree.copyPath')}
      </ContextMenuItem>
      {isNote && (
        <>
          <ContextMenuItem onClick={() => void copy(() => {
            const link = buildNoteOpenLinkFromPath(path, useNoteStore.getState().notebooks);
            if (!link) throw new Error('Cannot create an unambiguous notebook link');
            return link;
          }, 'document.command.copySuccess')} className={ITEM_CLASS}>
            <LinkIcon className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('memo.fileTree.copyDeepLink')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void copy(async () => (await memoDocumentOperations.read({ path, scopePath: null })) ?? '', 'document.command.copySuccess')} className={ITEM_CLASS}>
            <FileTextIcon className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('document.action.copyFullText')}
          </ContextMenuItem>
        </>
      )}
    </ContextMenuSubmenu>
  );
}
