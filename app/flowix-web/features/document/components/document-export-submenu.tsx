import { useEffect, useRef, useState } from 'react';
import { ChevronRight, SquareArrowRightExit } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { DropdownMenuItem } from '@shared/ui/dropdown-menu';
import { Popover, PopoverContent } from '@shared/ui/popover';

export function DocumentExportSubmenu({ onExportMarkdown, onExportWord, onExportPdf }: {
  onExportMarkdown: () => void;
  onExportWord: () => void;
  onExportPdf: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const focusFirst = useRef(false);
  const cancelClose = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const keepOpen = () => { cancelClose(); setOpen(true); };
  const scheduleClose = () => {
    cancelClose();
    timer.current = setTimeout(() => { timer.current = null; setOpen(false); }, 160);
  };
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (open && focusFirst.current) {
      focusFirst.current = false;
      content.current?.querySelector<HTMLButtonElement>('button')?.focus();
    }
  }, [open]);
  const itemClass = 'group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)]';

  return <Popover open={open} onOpenChange={setOpen} anchorElement={anchor}>
    <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open}
      className={`flex w-full text-sm text-[var(--foreground)] ${itemClass}`}
      onMouseEnter={(event) => { setAnchor(event.currentTarget); keepOpen(); }}
      onMouseLeave={scheduleClose}
      onClick={(event) => { event.stopPropagation(); setAnchor(event.currentTarget); keepOpen(); }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowRight') return;
        event.preventDefault();
        event.stopPropagation();
        focusFirst.current = true;
        setAnchor(event.currentTarget);
        if (open) content.current?.querySelector<HTMLButtonElement>('button')?.focus();
        keepOpen();
      }}
    >
      <SquareArrowRightExit className="h-4 w-4 -rotate-90" aria-hidden="true" />
      <span className="flex-1">{t('document.action.exportAs')}</span>
      <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
    </button>
    <PopoverContent side="left" align="start" sideOffset={0} fitViewport keepParentMenuOpen
      className="w-[176px] rounded-xl p-1 !z-[151]" onMouseEnter={keepOpen} onMouseLeave={scheduleClose}>
      <div ref={content} role="menu" aria-label={t('document.action.exportAs')}
        onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === 'ArrowLeft') {
            event.preventDefault();
            event.stopPropagation();
            cancelClose();
            setOpen(false);
            anchor?.focus();
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
            const next = items.indexOf(document.activeElement as HTMLButtonElement) + (event.key === 'ArrowDown' ? 1 : -1);
            items[(next + items.length) % items.length]?.focus();
          }
        }}>
        <DropdownMenuItem onClick={onExportMarkdown} className={itemClass}>Markdown</DropdownMenuItem>
        <DropdownMenuItem onClick={onExportWord} className={itemClass}>Word</DropdownMenuItem>
        <DropdownMenuItem onClick={onExportPdf} className={itemClass}>PDF</DropdownMenuItem>
      </div>
    </PopoverContent>
  </Popover>;
}
