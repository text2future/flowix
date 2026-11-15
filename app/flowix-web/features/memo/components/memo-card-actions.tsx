'use client';

import { Columns2, Copy, FolderOpen, Link, Pencil, Pin, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { product } from '@platform/tauri/client';
import { memoDocumentOperations } from '@features/document/public/file-operations-api';
import { useI18n } from '@/lib/i18n';
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator';
import { useNoteStore } from '@features/memo/store/note-store';
import {
  noteListItemRelativePath,
  type NoteListItem,
} from '@/types/note-item';
import { buildNoteOpenLinkFromPath } from '@platform/open-target/path-link';
import { joinNotebookMemoPath } from '@/lib/path';

// Minimal contract every shadcn-style item primitive in this app satisfies:
// it accepts an onClick, a className, and renders children. Both
// `DropdownMenuItem` and `ContextMenuItem` match this, so we can render the
// same actions inside either menu without forking the JSX.
export interface MenuItemComponent {
  (props: {
    onClick?: () => void;
    className?: string;
    children: React.ReactNode;
  }): React.ReactElement | null;
}

interface MemoCardActionsProps<T extends NoteListItem> {
  memo: T;
  /** Use the tree item's authoritative path when this menu is rendered there. */
  filePath?: string;
  /** The notebook tree renders its copy actions in a submenu. */
  hideCopyActions?: boolean;
  /** Tree-specific copy submenu, placed directly before reveal. */
  copyMenuBeforeReveal?: React.ReactNode;
  onFavoriteToggle: (memo: T) => void;
  onRename?: (memo: T) => void;
  onDelete: (memo: T) => void;
  /**
   * Opens the memo in the browser column. Optional because the menu is also
   * rendered where a split target makes no sense; the item hides when absent.
   */
  onOpenInSplit?: (memo: T) => void;
  Item: MenuItemComponent;
}

const ITEM_BASE =
  "h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--hover-bg)]";

// Clipboard helper. Mirrors `useDocumentCommands::writeClipboardText` so the
// "copy link" / "copy full text" actions behave identically when invoked
// from the memo card right-click menu vs. the document titlebar menu.
async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

export function MemoCardActions<T extends NoteListItem>({
  memo,
  filePath,
  onFavoriteToggle,
  onRename,
  onDelete,
  onOpenInSplit,
  hideCopyActions = false,
  copyMenuBeforeReveal,
  Item,
}: MemoCardActionsProps<T>) {
  const { t } = useI18n();

  // Resolve the note's on-disk path from its notebook-relative path, so the
  // memo-card menu's "copy link" / "copy full text" target the same file
  // the titlebar's commands would when the memo is actively open.
  const resolvePath = () => {
    const notebook = useNoteStore.getState().selectedNotebook;
    const relativePath = noteListItemRelativePath(memo);
    return notebook?.path
      ? joinNotebookMemoPath(notebook.path, relativePath)
      : relativePath;
  };

  const handleCopyLink = async () => {
    const path = resolvePath();
    if (!path) return;
    try {
      const link = buildNoteOpenLinkFromPath(path, useNoteStore.getState().notebooks);
      if (!link) throw new Error('Cannot create an unambiguous notebook link');
      await writeClipboardText(link);
      toast.success(t('document.command.copySuccess'));
    } catch (error) {
      console.warn('[MemoCardActions] copy link failed', error);
      toast.error(t('document.command.copyFailed'));
    }
  };

  const handleCopyFullText = async () => {
    const path = resolvePath();
    if (!path) return;
    try {
      const content = await memoDocumentOperations.read({ path, scopePath: null });
      await writeClipboardText(content ?? '');
      toast.success(t('document.command.copySuccess'));
    } catch (error) {
      console.warn('[MemoCardActions] copy full text failed', error);
      toast.error(t('document.command.copyFailed'));
    }
  };

  const handleRevealInFileManager = () => {
    const path = filePath ?? resolvePath();
    if (!path) return;
    void product.revealInFileManager(path).catch((error) => {
      console.warn('[MemoCardActions] reveal in file manager failed', error);
      toast.error(t('memo.fileTree.openFailed'));
    });
  };

  return (
    <>
      {onOpenInSplit && (
        <>
          <Item onClick={() => onOpenInSplit(memo)} className={ITEM_BASE}>
            <Columns2 className="w-4 h-4 mr-2" /> {t('memo.action.openInSplit')}
          </Item>
        </>
      )}
      {onRename && (
        <Item onClick={() => onRename(memo)} className={ITEM_BASE}>
          <Pencil className="mr-2 h-4 w-4" /> {t('memo.fileTree.rename')}
        </Item>
      )}
      <Item onClick={() => onFavoriteToggle(memo)} className={ITEM_BASE}>
        {memo.favorited ? (
          <>
            <Pin className="w-4 h-4 mr-2 fill-current" /> {t('memo.action.unpin')}
          </>
        ) : (
          <>
            <Pin className="w-4 h-4 mr-2" /> {t('memo.action.pin')}
          </>
        )}
      </Item>
      {!hideCopyActions && (
        <>
          <Item onClick={handleCopyLink} className={ITEM_BASE}>
            <Link className="w-4 h-4 mr-2" /> {t('document.action.copyLink')}
          </Item>
          <Item onClick={handleCopyFullText} className={ITEM_BASE}>
            <Copy className="w-4 h-4 mr-2" /> {t('document.action.copyFullText')}
          </Item>
        </>
      )}
      {copyMenuBeforeReveal}
      <Item onClick={handleRevealInFileManager} className={ITEM_BASE}>
        <FolderOpen className="w-4 h-4 mr-2" /> {t('memo.fileTree.reveal')}
      </Item>
      <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
      <Item
        onClick={() => onDelete(memo)}
        className={cn(ITEM_BASE, 'hover:bg-[var(--hover-bg)] hover:text-[var(--destructive)]')}
      >
        <Trash2 className="w-4 h-4 mr-2" /> {t('memo.action.delete')}
      </Item>
    </>
  );
}
