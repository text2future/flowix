'use client';

import { Check } from 'lucide-react';
import {
  CopyIcon,
  LinkSimpleIcon,
  PushPin,
  StackSimpleIcon,
  TrashSimpleIcon,
} from '@phosphor-icons/react';
import { useContext } from 'react';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { memos as memosClient } from '@platform/tauri/client';
import { useI18n, translate, type AppLanguage, type I18nKey } from '@features/i18n';
import {
  ContextMenuContext,
} from '@shared/ui/context-menu';
import {
  DropdownMenuContext,
} from '@shared/ui/dropdown-menu';
import {
  MEMO_COLORS,
  MEMO_COLOR_HEX,
  useMemoStore,
  type MemoItem,
  type MemoColor,
} from '@features/memo';
import { openMemoSession } from '@features/memo';
import { resolveMemoSessionPath } from '@features/memo/components/open-memo-session';

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

interface MemoCardActionsProps {
  memo: MemoItem;
  onFavoriteToggle: (memo: MemoItem) => void;
  onDelete: (memo: MemoItem) => void;
  onColorsChange?: (memo: MemoItem, colors: MemoColor[]) => void;
  Item: MenuItemComponent;
}

const ITEM_BASE =
  "flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]";

// Inline color grid that lives at the top of the memo card right-click menu.
// Visually matches the popup above the document titlebar (same swatch order,
// same transparent "no color" cell, same 28px height and 6px gap, same check
// overlay for the active color). Like the titlebar picker, the row is width
// constrained by the menu so swatches shrink horizontally instead of overflowing.
// Clicking any swatch
// (including the no-color cell) calls `onChange` and closes the surrounding
// menu — the picker is single-shot, not a sticky submenu.
const COLOR_LABEL_KEYS: Record<MemoColor, I18nKey> = {
  red: 'document.color.red',
  orange: 'document.color.orange',
  yellow: 'document.color.yellow',
  green: 'document.color.green',
  cyan: 'document.color.cyan',
  blue: 'document.color.blue',
  gray: 'document.color.gray',
};

function getColorLabel(color: MemoColor, language: AppLanguage): string {
  return translate(language, COLOR_LABEL_KEYS[color]);
}

// Close-on-select helper used by the inline color row. The row is rendered
// inside either a `ContextMenuContent` or `DropdownMenuContent`; both expose
// a `setOpen` setter on their context. Picking whichever is active keeps the
// component menu-agnostic — callers don't need to wire a close callback.
function useCloseActiveMenu(): () => void {
  const ctxMenu = useContext(ContextMenuContext);
  const dropMenu = useContext(DropdownMenuContext);
  return () => {
    if (ctxMenu) ctxMenu.setOpen(false);
    else if (dropMenu) dropMenu.setOpen(false);
  };
}

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

interface MemoCardColorRowProps {
  colors: MemoColor[];
  onChange: (next: MemoColor[]) => void;
}

function MemoCardColorRow({ colors, onChange }: MemoCardColorRowProps) {
  const { t, language } = useI18n();
  const closeActiveMenu = useCloseActiveMenu();
  const selected = new Set(colors);

  const apply = (next: Set<MemoColor>) => {
    onChange(MEMO_COLORS.filter((c) => next.has(c)));
    closeActiveMenu();
  };

  const toggle = (c: MemoColor) => {
    const next = new Set(selected);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    apply(next);
  };

  const clear = () => apply(new Set());

  return (
    <div
      role="group"
      aria-label={t('document.color.button')}
      className="flex w-full items-center gap-1.5 px-2.5 pb-1.5 pt-1"
    >
      <button
        type="button"
        aria-label={t('document.color.noColorTooltip')}
        aria-pressed={colors.length === 0}
        title={t('document.color.clear')}
        onClick={clear}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        className={cn(
          'relative h-4 w-7 rounded-md border bg-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]',
          colors.length === 0
            ? 'border-[var(--muted-foreground)]'
            : 'border-[var(--border)] hover:border-[var(--muted-foreground)]',
        )}
      />
      {MEMO_COLORS.map((c) => {
        const isSelected = selected.has(c);
        return (
          <button
            key={c}
            type="button"
            aria-label={getColorLabel(c, language)}
            aria-pressed={isSelected}
            onClick={() => toggle(c)}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            className="relative h-4 w-7 rounded-md transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
            style={{ backgroundColor: MEMO_COLOR_HEX[c] }}
          >
            {isSelected && (
              <Check
                aria-hidden="true"
                strokeWidth={3}
                className="pointer-events-none absolute inset-0 m-auto h-2.5 w-2.5 text-white opacity-70"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

export function MemoCardActions({
  memo,
  onFavoriteToggle,
  onDelete,
  onColorsChange,
  Item,
}: MemoCardActionsProps) {
  const { t } = useI18n();

  // Resolve the on-disk path the same way `openMemoSession` does, so the
  // memo-card menu's "copy link" / "copy full text" target the same file
  // the titlebar's commands would when the memo is actively open.
  const resolvePath = () => {
    const notebook = useMemoStore.getState().selectedNotebook;
    return resolveMemoSessionPath(memo, notebook);
  };

  const handleCopyLink = async () => {
    const path = resolvePath();
    if (!path) return;
    try {
      await writeClipboardText(path);
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
      const content = await memosClient.readDocument(path);
      await writeClipboardText(content ?? '');
      toast.success(t('document.command.copySuccess'));
    } catch (error) {
      console.warn('[MemoCardActions] copy full text failed', error);
      toast.error(t('document.command.copyFailed'));
    }
  };

  // Properties are rendered by `DocumentContainer` for the currently-active
  // memo, so open the session first (synchronously marked-selected, then the
  // document settles in the background) before dispatching the open event.
  const handleOpenProperties = () => {
    const notebook = useMemoStore.getState().selectedNotebook;
    void openMemoSession(memo, notebook).then(() => {
      window.dispatchEvent(
        new CustomEvent('flowix:open-note-properties', {
          detail: { memoId: memo.id },
        }),
      );
    });
  };

  return (
    <>
      <Item onClick={handleCopyLink} className={ITEM_BASE}>
        <LinkSimpleIcon className="w-4 h-4 mr-2" /> {t('document.action.copyLink')}
      </Item>
      <Item onClick={handleCopyFullText} className={ITEM_BASE}>
        <CopyIcon className="w-4 h-4 mr-2" /> {t('document.action.copyFullText')}
      </Item>
      <Item onClick={handleOpenProperties} className={ITEM_BASE}>
        <StackSimpleIcon className="w-4 h-4 mr-2" /> {t('document.action.properties')}
      </Item>
      <hr className="mx-2 border-t border-[var(--border)] opacity-50" />
      {onColorsChange && (
        <MemoCardColorRow
          colors={memo.colors}
          onChange={(next) => onColorsChange(memo, next)}
        />
      )}
      <Item onClick={() => onFavoriteToggle(memo)} className={ITEM_BASE}>
        {memo.favorited ? (
          <>
            <PushPin weight="fill" className="w-4 h-4 mr-2" /> {t('memo.action.unpin')}
          </>
        ) : (
          <>
            <PushPin className="w-4 h-4 mr-2" /> {t('memo.action.pin')}
          </>
        )}
      </Item>
      <hr className="mx-2 border-t border-[var(--border)] opacity-50" />
      <Item
        onClick={() => onDelete(memo)}
        className={cn(ITEM_BASE, 'hover:text-[var(--destructive)]')}
      >
        <TrashSimpleIcon className="w-4 h-4 mr-2" /> {t('memo.action.delete')}
      </Item>
    </>
  );
}
