import { Copy } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { ContextMenuItem } from '@shared/ui/context-menu';

const ITEM_CLASS =
  'h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--hover-bg)]';

export function NotebookCopyContextMenu({ path }: { path: string }) {
  const { t } = useI18n();

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      toast.success(t('memo.fileTree.pathCopied'));
    } catch (error) {
      console.warn('[NotebookCopyContextMenu] copy failed', error);
      toast.error(t('memo.fileTree.copyFailed'));
    }
  };

  return (
    <ContextMenuItem onClick={() => void copyPath()} className={ITEM_CLASS}>
      <Copy className="mr-2 h-4 w-4" aria-hidden="true" />
      {t('memo.fileTree.copyPath')}
    </ContextMenuItem>
  );
}
