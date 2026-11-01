'use client';

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import {
  ArrowDownUp,
  Check,
  ChevronRight,
  GalleryHorizontalEnd,
  ListOrdered,
  MoreHorizontal,
  Plus,
  Table2,
} from 'lucide-react';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EyeSlashIcon,
  DownloadSimpleIcon,
  FileIcon,
  FolderSimplePlusIcon,
  SquaresFourIcon,
} from '@phosphor-icons/react';

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

export function getPopupOriginRect(target: HTMLElement): DOMRect {
  const rect = (target.closest('[role="menu"]') ?? target).getBoundingClientRect();
  return new DOMRect(rect.left, rect.top, 0, 0);
}

function useViewportSubmenuPosition(open: boolean) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>({ left: '100%', top: 0 });

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const content = contentRef.current;
      if (!trigger || !content) return;
      const triggerRect = trigger.getBoundingClientRect();
      const width = content.offsetWidth || 176;
      const height = content.scrollHeight;
      const opensLeft = window.innerWidth - triggerRect.right < width + 8;
      const top = Math.max(4, Math.min(triggerRect.top, window.innerHeight - height - 4));
      setStyle({
        left: opensLeft ? undefined : '100%',
        right: opensLeft ? '100%' : undefined,
        top: top - triggerRect.top,
      });
    };
    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    const observer = typeof ResizeObserver === 'undefined' || !contentRef.current
      ? null
      : new ResizeObserver(updatePosition);
    if (observer && contentRef.current) observer.observe(contentRef.current);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  return { triggerRef, contentRef, style };
}

interface NotebookTreeSectionMenuProps {
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
}: NotebookTreeSectionMenuProps) {
  const { t } = useI18n();
  const [sortSubmenuOpen, setSortSubmenuOpen] = useState(false);
  const [createSubmenuOpen, setCreateSubmenuOpen] = useState(false);
  const [importSubmenuOpen, setImportSubmenuOpen] = useState(false);
  const createSubmenuPosition = useViewportSubmenuPosition(createSubmenuOpen);
  const importSubmenuPosition = useViewportSubmenuPosition(importSubmenuOpen);
  const sortSubmenuPosition = useViewportSubmenuPosition(sortSubmenuOpen);
  const itemClassName = 'group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)] disabled:cursor-not-allowed disabled:opacity-40';
  const hasActionsAfterMovement = Boolean(
    onCreateNote || onCreateFolder || onCreateTable || onCreateMediaLibrary || onCreateWorkDocuments || onImportFiles || onImportFolder || (sort && onSort),
  );

  return (
    <DropdownMenu onOpenChange={(open) => {
      if (!open) {
        setCreateSubmenuOpen(false);
        setImportSubmenuOpen(false);
        setSortSubmenuOpen(false);
      }
    }}>
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
      <DropdownMenuContent align="end" className="w-[176px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <DropdownMenuItem disabled={!canMoveUp} onClick={onMoveUp} className={itemClassName}>
          <ArrowUpIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {t('memo.fileTree.moveSectionUp')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canMoveDown} onClick={onMoveDown} className={itemClassName}>
          <ArrowDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {t('memo.fileTree.moveSectionDown')}
        </DropdownMenuItem>
        {hasActionsAfterMovement && <DropdownMenuSeparator />}
        {onCreateNote && (
          <DropdownMenuItem onClick={onCreateNote} className={itemClassName}>
            <FileIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {t('memo.fileTree.newNote')}
          </DropdownMenuItem>
        )}
        {onCreateFolder && (
          <DropdownMenuItem onClick={onCreateFolder} className={itemClassName}>
            <FolderSimplePlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {t('memo.fileTree.newFolder')}
          </DropdownMenuItem>
        )}
        {(onCreateTable || onCreateMediaLibrary || onCreateWorkDocuments) && (
          <div
            className="relative"
            onMouseEnter={() => setCreateSubmenuOpen(true)}
            onMouseLeave={() => setCreateSubmenuOpen(false)}
          >
            <button
              type="button"
              ref={createSubmenuPosition.triggerRef}
              className={cn(itemClassName, 'flex w-full items-center justify-between text-sm')}
              onClick={() => setCreateSubmenuOpen((open) => !open)}
              onMouseDown={(event) => event.preventDefault()}
            >
              <span className="flex items-center gap-2">
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t('memo.create.newView')}
              </span>
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {createSubmenuOpen && (
              <div ref={createSubmenuPosition.contentRef} style={{ ...createSubmenuPosition.style, maxWidth: 'calc(100vw - 8px)', maxHeight: 'calc(100vh - 8px)', overflowY: 'auto' }} className="absolute w-[176px] space-y-0.5 rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                {onCreateTable && MEMO_CREATE_VIEW_OPTIONS.map(({ type, labelKey }) => (
                  <DropdownMenuItem key={type} onClick={() => onCreateTable(type)} className={itemClassName}>
                    {type === 'table' ? <Table2 className="h-3.5 w-3.5" aria-hidden="true" /> : <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                    {t(labelKey)}
                    <span className="ml-auto text-xs text-[var(--muted-foreground)] opacity-50 group-hover:text-[var(--primary-foreground)] group-focus-visible:text-[var(--primary-foreground)]">{t('memo.create.note')}</span>
                  </DropdownMenuItem>
                ))}
                {onCreateMediaLibrary && (
                  <DropdownMenuItem onClick={onCreateMediaLibrary} className={itemClassName}>
                    <GalleryHorizontalEnd className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{t('memo.create.mediaLibraryMenuLabel')}</span>
                    <span className="ml-auto text-xs text-[var(--muted-foreground)] opacity-50 group-hover:text-[var(--primary-foreground)] group-focus-visible:text-[var(--primary-foreground)]">
                      {t('memo.create.assetShort')}
                    </span>
                  </DropdownMenuItem>
                )}
                {onCreateWorkDocuments && (
                  <DropdownMenuItem onClick={onCreateWorkDocuments} className={itemClassName}>
                    <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{t('memo.create.workDocumentsMenuLabel')}</span>
                    <span className="ml-auto text-xs text-[var(--muted-foreground)] opacity-50 group-hover:text-[var(--primary-foreground)] group-focus-visible:text-[var(--primary-foreground)]">
                      {t('memo.create.assetShort')}
                    </span>
                  </DropdownMenuItem>
                )}
              </div>
            )}
          </div>
        )}
        {(onImportFiles || onImportFolder) && (
          <div className="relative" onMouseEnter={() => setImportSubmenuOpen(true)} onMouseLeave={() => setImportSubmenuOpen(false)}>
            <button
              type="button"
              ref={importSubmenuPosition.triggerRef}
              onClick={() => setImportSubmenuOpen((open) => !open)}
              onMouseDown={(event) => event.preventDefault()}
              className={cn(itemClassName, 'flex w-full items-center text-sm')}
            >
              <DownloadSimpleIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {t('memo.fileTree.import')}
              <ChevronRight className="ml-auto h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {importSubmenuOpen && (
              <div
                ref={importSubmenuPosition.contentRef}
                style={importSubmenuPosition.style}
                className="absolute z-50 w-[156px] space-y-0.5 rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
              >
                {onImportFiles && <DropdownMenuItem onClick={onImportFiles} className={itemClassName}>{t('memo.fileTree.importFiles')}</DropdownMenuItem>}
                {onImportFolder && <DropdownMenuItem onClick={onImportFolder} className={itemClassName}>{t('memo.fileTree.importFolder')}</DropdownMenuItem>}
              </div>
            )}
          </div>
        )}
        {sort && onSort && (
          <div
            className="relative"
            onMouseEnter={() => setSortSubmenuOpen(true)}
            onMouseLeave={() => setSortSubmenuOpen(false)}
          >
            <button
              type="button"
              ref={sortSubmenuPosition.triggerRef}
              className={cn(itemClassName, 'memo-navigation-submenu-trigger flex w-full items-center justify-between text-sm')}
              onClick={() => setSortSubmenuOpen(true)}
              onMouseDown={(event) => event.preventDefault()}
            >
              <span className="flex items-center gap-2">
                <ArrowDownUp className="h-3.5 w-3.5" aria-hidden="true" />
                {t('memo.list.sortLabel')}
              </span>
              <span className="flex items-center gap-1 text-xs text-[var(--muted-foreground)]">
                {t(sort === 'createdAt' ? 'memo.list.sortCreated' : sort === 'updatedAt' ? 'memo.list.sortUpdated' : sort === 'filenameAsc' ? 'memo.list.sortFilenameAsc' : 'memo.list.sortFilenameDesc')}
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
            </button>
            {sortSubmenuOpen && (
              <div ref={sortSubmenuPosition.contentRef} style={{ ...sortSubmenuPosition.style, maxWidth: 'calc(100vw - 8px)', maxHeight: 'calc(100vh - 8px)', overflowY: 'auto' }} className="absolute w-[176px] space-y-0.5 rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                {([
                  ['createdAt', 'memo.list.sortCreated'],
                  ['updatedAt', 'memo.list.sortUpdated'],
                  ['filenameAsc', 'memo.list.sortFilenameAsc'],
                  ['filenameDesc', 'memo.list.sortFilenameDesc'],
                ] as const).map(([value, label]) => (
                  <DropdownMenuItem
                    key={value}
                    onClick={() => onSort(value)}
                    className={cn(
                      'memo-navigation-submenu-item mention-note-item cursor-pointer hover:bg-[var(--brand)] focus-visible:bg-[var(--brand)] focus-visible:outline-none',
                      sort === value && 'is-selected',
                    )}
                  >
                    <span>{t(label)}</span>
                    {sort === value && <Check className="h-4 w-4 text-[var(--brand)]" aria-hidden="true" />}
                  </DropdownMenuItem>
                ))}
              </div>
            )}
          </div>
        )}
        {(hasActionsAfterMovement || onCustomizeDisplay || onHideSection || onConfigureAgentConversationCount) && <DropdownMenuSeparator />}
        {onConfigureAgentConversationCount && (
          <DropdownMenuItem onClick={onConfigureAgentConversationCount} className={itemClassName}>
            <ListOrdered className="h-3.5 w-3.5" aria-hidden="true" />
            {t('memo.fileTree.configureConversationCount')}
          </DropdownMenuItem>
        )}
        {onHideSection && (
          <DropdownMenuItem onClick={onHideSection} className={itemClassName}>
            <EyeSlashIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {t('memo.fileTree.hideSection')}
          </DropdownMenuItem>
        )}
        {onCustomizeDisplay && (
          <DropdownMenuItem keepOpenOnClick onClick={(event) => {
            onCustomizeDisplay(getPopupOriginRect(event.currentTarget));
          }} className={itemClassName}>
            <SquaresFourIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {t('memo.fileTree.customizeDisplay')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
