'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PopupSurface } from '@shared/ui/popup-scroll-area';
import {
  ArrowDownUp,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  DatabasePlus,
  Download,
  EyeOff,
  FilePlusCorner,
  FolderPlus,
  ListOrdered,
  MoreHorizontal,
  PanelsTopLeft,
  Share2,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import type { FolderTreeSort } from './use-folder-tree';
import type { TableViewType } from '@features/multidimensional-table/public/create-api';
import { MEMO_CREATE_VIEW_OPTIONS } from './memo-create-view-options';
import { NoteShareControl } from '@features/document/public/header-api';

const noDocumentToFlush = async () => true;

export function getPopupOriginRect(target: HTMLElement): DOMRect {
  const rect = (target.closest('[role="menu"]') ?? target).getBoundingClientRect();
  return new DOMRect(rect.left, rect.top, 0, 0);
}

/** Portal the submenu outside the parent menu's scrolling viewport. */
function SectionSubmenu({ label, icon, trailing, children }: {
  label: ReactNode; icon: ReactNode; trailing?: ReactNode; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const focusFirst = useRef(false);
  const cancelClose = () => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; };
  const scheduleClose = () => { cancelClose(); timer.current = window.setTimeout(() => { setOpen(false); timer.current = null; }, 160); };
  useEffect(() => () => cancelClose(), []);
  const align = useCallback(() => {
    if (!trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = Math.min(176, Math.max(0, window.innerWidth - 8));
    const height = Math.min(popup.current?.scrollHeight ?? 220, Math.max(0, window.innerHeight - 8));
    const left = window.innerWidth - rect.right < width + 4
      ? Math.max(4, rect.left - width) : Math.min(rect.right, window.innerWidth - width - 4);
    const top = Math.max(4, Math.min(rect.top, window.innerHeight - height - 4));
    setPosition((old) => old?.left === left && old.top === top ? old : { left, top });
  }, []);
  const show = () => { cancelClose(); align(); setOpen(true); };
  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const started = performance.now();
    const update = (now: number) => {
      align();
      if (now - started < 250) frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    window.addEventListener('resize', align);
    window.addEventListener('scroll', align, true);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', align); window.removeEventListener('scroll', align, true); };
  }, [align, open]);
  useLayoutEffect(() => {
    if (!open || !focusFirst.current) return;
    focusFirst.current = false;
    popup.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [open]);
  return <div className="relative" onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
    <button type="button" ref={trigger} aria-haspopup="menu" aria-expanded={open}
      className="group flex h-7 w-full items-center justify-between rounded-lg px-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)]"
      onMouseEnter={show} onClick={show} onMouseDown={(event) => event.preventDefault()}
      onKeyDown={(event) => { if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); focusFirst.current = true; show(); if (open) popup.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true }); } }}>
      <span className="flex min-w-0 items-center gap-2">{icon}{label}</span>
      <span className="flex items-center gap-1 text-xs text-[var(--muted-foreground)]">{trailing}<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /></span>
    </button>
    {open && position && createPortal(<PopupSurface scrollable scrollerClassName="space-y-0.5" ref={popup}
      data-flowix-menu-child="" role="menu" onMouseEnter={cancelClose} onMouseLeave={scheduleClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'ArrowLeft') {
          event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus({ preventScroll: true });
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const items = [...(popup.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
          if (!items.length) return;
          event.preventDefault(); event.stopPropagation();
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index <= 0 ? items.length - 1 : index - 1);
          items[next]?.focus({ preventScroll: true });
        }
      }}
      className="fixed z-[151] w-[176px] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
      style={{ ...position, maxWidth: 'calc(100vw - 8px)', maxHeight: 'calc(100vh - 8px)' }}>{children}</PopupSurface>, document.body)}
  </div>;
}

export interface NotebookTreeSectionMenuProps {
  onHideSection?: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onCreateFolder?: () => void;
  onCreateNote?: () => void;
  onCreateTable?: (viewType?: TableViewType) => void;
  onCreateMediaLibrary?: () => void;
  onCreateWorkDocuments?: () => void;
  onImportFiles?: () => void;
  onImportFolder?: () => void;
  sort?: FolderTreeSort;
  onSort?: (sort: FolderTreeSort) => void;
  onCustomizeDisplay?: (anchorRect: DOMRect) => void;
  onConfigureAgentConversationCount?: () => void;
  sharePath?: string;
}

export function NotebookTreeSectionMenu({
  onHideSection,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onCreateFolder,
  onCreateNote,
  onCreateTable,
  onCreateMediaLibrary,
  onCreateWorkDocuments,
  onImportFiles,
  onImportFolder,
  sort,
  onSort,
  onCustomizeDisplay,
  onConfigureAgentConversationCount,
  sharePath,
}: NotebookTreeSectionMenuProps) {
  const { t } = useI18n();
  const [shareRequest, setShareRequest] = useState(0);
  const itemClassName = 'group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-40';
  const hasActionsAfterMovement = Boolean(
    onCreateNote || onCreateFolder || onCreateTable || onCreateMediaLibrary || onCreateWorkDocuments || onImportFiles || onImportFolder || (sort && onSort),
  );

  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="notebook-file-tree__section-more-trigger flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] opacity-0 transition-[color,opacity] hover:text-[var(--foreground)] focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
          aria-label={t('memo.fileTree.moreSectionActions')}
          title={t('memo.fileTree.moreSectionActions')}
        >
          <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent scrollerClassName="space-y-0.5" align="end" className="w-[176px] rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <DropdownMenuItem disabled={!canMoveUp} onClick={onMoveUp} className={itemClassName}>
          <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
          {t('memo.fileTree.moveSectionUp')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canMoveDown} onClick={onMoveDown} className={itemClassName}>
          <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
          {t('memo.fileTree.moveSectionDown')}
        </DropdownMenuItem>
        {hasActionsAfterMovement && <DropdownMenuSeparator />}
        {onCreateNote && (
          <DropdownMenuItem onClick={onCreateNote} className={itemClassName}>
            <FilePlusCorner className="h-3.5 w-3.5" aria-hidden="true" />
            {t('memo.fileTree.newNote')}
          </DropdownMenuItem>
        )}
        {onCreateFolder && (
          <DropdownMenuItem onClick={onCreateFolder} className={itemClassName}>
            <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('memo.fileTree.newFolder')}
          </DropdownMenuItem>
        )}
        {(onCreateTable || onCreateMediaLibrary || onCreateWorkDocuments) && (
          <SectionSubmenu label={t('memo.create.newView')} icon={<DatabasePlus className="h-3.5 w-3.5" aria-hidden="true" />}>
            {onCreateTable && MEMO_CREATE_VIEW_OPTIONS.map(({ type, labelKey }) => (
              <DropdownMenuItem key={type} onClick={() => onCreateTable(type)} className={itemClassName}>
                {t(labelKey)}<span className="ml-auto text-xs text-[var(--muted-foreground)] opacity-50">{t('memo.create.note')}</span>
              </DropdownMenuItem>
            ))}
            {onCreateMediaLibrary && <DropdownMenuItem onClick={onCreateMediaLibrary} className={itemClassName}>{t('memo.create.mediaLibraryMenuLabel')}<span className="ml-auto text-xs text-[var(--muted-foreground)] opacity-50">{t('memo.create.assetShort')}</span></DropdownMenuItem>}
            {onCreateWorkDocuments && <DropdownMenuItem onClick={onCreateWorkDocuments} className={itemClassName}>{t('memo.create.workDocumentsMenuLabel')}<span className="ml-auto text-xs text-[var(--muted-foreground)] opacity-50">{t('memo.create.assetShort')}</span></DropdownMenuItem>}
          </SectionSubmenu>
        )}
        {(onImportFiles || onImportFolder) && (
          <SectionSubmenu label={t('memo.fileTree.import')} icon={<Download className="h-3.5 w-3.5" aria-hidden="true" />}>
            {onImportFiles && <DropdownMenuItem onClick={onImportFiles} className={itemClassName}>{t('memo.fileTree.importFiles')}</DropdownMenuItem>}
            {onImportFolder && <DropdownMenuItem onClick={onImportFolder} className={itemClassName}>{t('memo.fileTree.importFolder')}</DropdownMenuItem>}
          </SectionSubmenu>
        )}
        {sort && onSort && (
          <SectionSubmenu label={t('memo.list.sortLabel')} icon={<ArrowDownUp className="h-3.5 w-3.5" aria-hidden="true" />}
            trailing={t(sort === 'createdAt' ? 'memo.list.sortCreated' : sort === 'updatedAt' ? 'memo.list.sortUpdated' : sort === 'filenameAsc' ? 'memo.list.sortFilenameAsc' : 'memo.list.sortFilenameDesc')}>
            {([
              ['createdAt', 'memo.list.sortCreated'], ['updatedAt', 'memo.list.sortUpdated'],
              ['filenameAsc', 'memo.list.sortFilenameAsc'], ['filenameDesc', 'memo.list.sortFilenameDesc'],
            ] as const).map(([value, label]) => <DropdownMenuItem key={value} onClick={() => onSort(value)}
              className={cn('memo-navigation-submenu-item memo-navigation-submenu-item--neutral-hover mention-note-item !grid !grid-cols-[minmax(0,1fr)_auto] !gap-3 cursor-pointer hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)] focus-visible:outline-none', sort === value && 'is-selected')}>
              <span>{t(label)}</span>{sort === value && <Check className="h-4 w-4 text-[var(--brand)]" aria-hidden="true" />}
            </DropdownMenuItem>)}
          </SectionSubmenu>
        )}
        {sharePath && <DropdownMenuItem onClick={() => setShareRequest((value) => value + 1)} className={itemClassName}>
          <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t('document.share.menuAction')}
        </DropdownMenuItem>}
        {(hasActionsAfterMovement || onCustomizeDisplay || onHideSection || onConfigureAgentConversationCount) && <DropdownMenuSeparator />}
        {onConfigureAgentConversationCount && (
          <DropdownMenuItem onClick={onConfigureAgentConversationCount} className={itemClassName}>
            <ListOrdered className="h-3.5 w-3.5" aria-hidden="true" />
            {t('memo.fileTree.configureConversationCount')}
          </DropdownMenuItem>
        )}
        {onHideSection && (
          <DropdownMenuItem onClick={onHideSection} className={itemClassName}>
            <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
            {t('memo.fileTree.hideSection')}
          </DropdownMenuItem>
        )}
        {onCustomizeDisplay && (
          <DropdownMenuItem keepOpenOnClick onClick={(event) => {
            onCustomizeDisplay(getPopupOriginRect(event.currentTarget));
          }} className={itemClassName}>
            <PanelsTopLeft className="h-3.5 w-3.5" aria-hidden="true" />
            {t('memo.fileTree.customizeDisplay')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    {sharePath && <NoteShareControl key={sharePath} filePath={sharePath} kind="folder" flushDocument={noDocumentToFlush}
      iconButtonClass="" hideTrigger openRequest={shareRequest} />}
    </>
  );
}
