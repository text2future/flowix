'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronsUpDown, Plus } from 'lucide-react';
import { PencilSimpleIcon, StarIcon, TrashSimpleIcon } from '@phosphor-icons/react';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { notebooks as notebooksClient } from '@platform/tauri/client';
import { NotebookIcon } from '@features/memo/components/notebook-icon';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { Button } from '@shared/ui/button';
import { useNoteStore, type Notebook } from '@features/memo/store/note-store';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';

export interface NotebookSelectorPopupProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notebooks: Notebook[];
  selectedNotebook: Notebook | null;
  onSelect: (notebook: Notebook) => void;
  onEdit: (notebook: Notebook) => void;
  onDelete: (notebook: Notebook) => void;
  onCreateNotebook: () => void;
  onRefresh: (notebooks: Notebook[]) => void;
  cloudSyncedNotebookIds?: ReadonlySet<string>;
  cloudSyncAvailable?: boolean;
  /** Optional alternate anchor, e.g. the current notebook card in the sidebar. */
  trigger?: React.ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  sideOffset?: number;
}

type DropPosition = 'before' | 'after';

interface DropTarget {
  id: string;
  position: DropPosition;
}

interface PointerState {
  sourceId: string;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
  ghostRect: DOMRect;
  pointerX: number;
  pointerY: number;
}

interface DragGeometry {
  itemRects: Map<string, DOMRect>;
  viewportRect: DOMRect | null;
}

const DRAG_THRESHOLD_PX = 4;
const NOTEBOOK_ITEM_CLASS = 'w-full shrink-0';

function reorderNotebookIds(
  notebooks: Notebook[],
  sourceId: string,
  target: DropTarget | null,
): string[] {
  const remainingIds = notebooks
    .map((notebook) => notebook.id)
    .filter((id) => id !== sourceId);
  if (!target) {
    const sourceIndex = notebooks.findIndex((notebook) => notebook.id === sourceId);
    remainingIds.splice(Math.max(0, sourceIndex), 0, sourceId);
    return remainingIds;
  }

  const targetIndex = remainingIds.indexOf(target.id);
  if (targetIndex < 0) return notebooks.map((notebook) => notebook.id);
  const insertAt = targetIndex + (target.position === 'after' ? 1 : 0);
  remainingIds.splice(insertAt, 0, sourceId);
  return remainingIds;
}

/**
 * Status-bar notebook selector. The popup deliberately owns the complete
 * interaction boundary so selecting or opening a notebook action always
 * closes the Popover before the parent starts another transition.
 */
export function NotebookSelectorPopup({
  open,
  onOpenChange,
  notebooks,
  selectedNotebook,
  onSelect,
  onEdit,
  onDelete,
  onCreateNotebook,
  onRefresh,
  cloudSyncedNotebookIds,
  cloudSyncAvailable = false,
  trigger,
  side = 'top',
  sideOffset = 6,
}: NotebookSelectorPopupProps) {
  const { t } = useI18n();
  const reorderNotebooks = useNoteStore((state) => state.reorderNotebooks);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const listViewportRef = useRef<HTMLDivElement>(null);
  const previousItemRectsRef = useRef(new Map<string, DOMRect>());
  const itemAnimationsRef = useRef(new Map<string, Animation>());
  const pointerRef = useRef<PointerState | null>(null);
  const dragGeometryRef = useRef<DragGeometry | null>(null);
  const refreshRequestRef = useRef(0);
  const pendingAfterCloseRef = useRef<(() => void) | null>(null);
  const searchComposingRef = useRef(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [ghost, setGhost] = useState<PointerState | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterQuery, setFilterQuery] = useState('');
  const normalizedSearchQuery = filterQuery.trim().toLocaleLowerCase();
  const notebooksById = useMemo(
    () => new Map(notebooks.map((notebook) => [notebook.id, notebook] as const)),
    [notebooks],
  );
  const previewNotebookIds = useMemo(
    () => {
      if (normalizedSearchQuery) {
        return notebooks
          .filter((notebook) => (
            notebook.name.toLocaleLowerCase().includes(normalizedSearchQuery) ||
            notebook.path.toLocaleLowerCase().includes(normalizedSearchQuery)
          ))
          .map((notebook) => notebook.id);
      }
      return draggingId
        ? reorderNotebookIds(notebooks, draggingId, dropTarget)
        : notebooks.map((notebook) => notebook.id);
    },
    [draggingId, dropTarget, notebooks, normalizedSearchQuery],
  );
  const groupedNotebookIds = useMemo(
    () => {
      const pinned: string[] = [];
      const others: string[] = [];
      for (const id of previewNotebookIds) {
        if (notebooksById.get(id)?.pinned) pinned.push(id);
        else others.push(id);
      }
      return { pinned, others };
    },
    [previewNotebookIds, notebooksById],
  );

  useLayoutEffect(() => {
    const nextRects = new Map<string, DOMRect>();
    for (const [id, item] of itemRefs.current) {
      const activeAnimation = itemAnimationsRef.current.get(id);
      const visualRect = activeAnimation ? item.getBoundingClientRect() : null;
      activeAnimation?.cancel();
      itemAnimationsRef.current.delete(id);
      const nextRect = item.getBoundingClientRect();
      nextRects.set(id, nextRect);
      const previousRect = visualRect ?? previousItemRectsRef.current.get(id);
      if (!previousRect || typeof item.animate !== 'function') continue;
      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue;
      const animation = item.animate(
        [
          { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
          { transform: 'translate3d(0, 0, 0)' },
        ],
        { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
      itemAnimationsRef.current.set(id, animation);
      animation.addEventListener('finish', () => {
        if (itemAnimationsRef.current.get(id) === animation) {
          itemAnimationsRef.current.delete(id);
        }
      }, { once: true });
    }
    previousItemRectsRef.current = nextRects;
  }, [previewNotebookIds]);

  useEffect(() => () => {
    for (const animation of itemAnimationsRef.current.values()) animation.cancel();
    itemAnimationsRef.current.clear();
  }, []);

  const refreshNotebooks = useCallback(async () => {
    const requestId = ++refreshRequestRef.current;
    try {
      const notebookList = await notebooksClient.getAll();
      if (requestId !== refreshRequestRef.current) return;
      onRefresh(notebookList ?? []);
    } catch {
      // The existing notebook list remains usable if refreshing fails.
    }
  }, [onRefresh]);

  const toggleNotebookPinned = useCallback(async (notebook: Notebook) => {
    const pinned = !notebook.pinned;
    try {
      const updated = await notebooksClient.setPinned(notebook.id, pinned);
      if (!updated) throw new Error('Notebook pin state was not updated');
      await refreshNotebooks();
    } catch {
      toast.error(t('memo.list.notebookMenu.pinFailed'));
    }
  }, [refreshNotebooks, t]);

  useEffect(() => () => {
    refreshRequestRef.current += 1;
  }, []);

  useEffect(() => {
    if (open) pendingAfterCloseRef.current = null;
  }, [open]);

  useEffect(() => {
    if (!open) {
      searchComposingRef.current = false;
      setSearchQuery('');
      setFilterQuery('');
    }
  }, [open]);

  const closeThen = useCallback((afterClose: () => void) => {
    pendingAfterCloseRef.current = afterClose;
    onOpenChange(false);
  }, [onOpenChange]);

  const handleExitComplete = useCallback(() => {
    const afterClose = pendingAfterCloseRef.current;
    pendingAfterCloseRef.current = null;
    afterClose?.();
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // Do not unmount the content while a pointer reorder is in progress.
      if (!next && pointerRef.current?.dragging) return;
      if (next) void refreshNotebooks();
      onOpenChange(next);
    },
    [onOpenChange, refreshNotebooks],
  );

  useEffect(() => {
    const findDropTarget = (x: number, y: number, sourceId: string): DropTarget | null => {
      const geometry = dragGeometryRef.current;
      if (!geometry?.viewportRect) return null;
      const { viewportRect } = geometry;
      if (
        x < viewportRect.left || x > viewportRect.right ||
        y < viewportRect.top || y > viewportRect.bottom
      ) {
        return null;
      }
      const sourceRect = geometry.itemRects.get(sourceId);
      if (
        sourceRect &&
        x >= sourceRect.left && x <= sourceRect.right &&
        y >= sourceRect.top && y <= sourceRect.bottom
      ) {
        return null;
      }

      let nearest: { id: string; distance: number; position: DropPosition } | null = null;

      for (const notebook of notebooks) {
        if (notebook.id === sourceId) continue;
        const rect = geometry.itemRects.get(notebook.id);
        if (!rect) continue;
        if (
          rect.right < viewportRect.left || rect.left > viewportRect.right ||
          rect.bottom < viewportRect.top || rect.top > viewportRect.bottom
        ) continue;
        const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const distance = Math.hypot(x - centerX, y - centerY);
        const position: DropPosition = y < centerY ? 'before' : 'after';

        if (inside) return { id: notebook.id, position };
        if (!nearest || distance < nearest.distance) {
          nearest = { id: notebook.id, distance, position };
        }
      }

      return nearest ? { id: nearest.id, position: nearest.position } : null;
    };

    const handleMove = (event: PointerEvent) => {
      const pointer = pointerRef.current;
      if (!pointer || pointer.pointerId !== event.pointerId) return;

      if (!pointer.dragging) {
        if (normalizedSearchQuery) return;
        const dx = Math.abs(event.clientX - pointer.startX);
        const dy = Math.abs(event.clientY - pointer.startY);
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        pointer.dragging = true;
        setDraggingId(pointer.sourceId);
      }

      pointer.pointerX = event.clientX;
      pointer.pointerY = event.clientY;
      setGhost({ ...pointer });
      const nextTarget = findDropTarget(event.clientX, event.clientY, pointer.sourceId);
      setDropTarget((currentTarget) => {
        if (
          currentTarget?.id === nextTarget?.id &&
          currentTarget?.position === nextTarget?.position
        ) {
          return currentTarget;
        }
        return nextTarget;
      });
    };

    const handleUp = (event: PointerEvent) => {
      const pointer = pointerRef.current;
      if (!pointer || pointer.pointerId !== event.pointerId) return;

      const target = pointer.dragging
        ? findDropTarget(event.clientX, event.clientY, pointer.sourceId)
        : null;
      if (target) {
        const ids = reorderNotebookIds(notebooks, pointer.sourceId, target);
        if (ids.some((id, index) => id !== notebooks[index]?.id)) {
          void reorderNotebooks(ids);
        }
      } else if (!pointer.dragging) {
        const notebook = notebooks.find((item) => item.id === pointer.sourceId);
        if (notebook) {
          if (notebook.missing) {
            closeThen(() => toast.warning(t('status.invalidNotebookPath')));
          } else {
            closeThen(() => onSelect(notebook));
          }
        }
      }

      pointerRef.current = null;
      dragGeometryRef.current = null;
      setDraggingId(null);
      setDropTarget(null);
      setGhost(null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [closeThen, notebooks, normalizedSearchQuery, onSelect, reorderNotebooks, t]);

  const handleCardPointerDown = (notebook: Notebook, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pointerRef.current) return;
    event.preventDefault();
    const itemRects = new Map<string, DOMRect>();
    for (const [id, item] of itemRefs.current) {
      itemRects.set(id, item.getBoundingClientRect());
    }
    dragGeometryRef.current = {
      itemRects,
      viewportRect: listViewportRef.current?.getBoundingClientRect() ?? null,
    };
    pointerRef.current = {
      sourceId: notebook.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      ghostRect: event.currentTarget.getBoundingClientRect(),
      pointerX: event.clientX,
      pointerY: event.clientY,
    };
  };

  const handleCardKeyDown = (notebook: Notebook, event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (notebook.missing) {
      closeThen(() => toast.warning(t('status.invalidNotebookPath')));
      return;
    }
    closeThen(() => onSelect(notebook));
  };

  const sourceNotebook = ghost ? notebooks.find((notebook) => notebook.id === ghost.sourceId) : null;

  const renderNotebookItem = (notebookId: string) => {
    if (notebookId === draggingId) {
      return (
        <div
          key={`placeholder-${notebookId}`}
          aria-hidden="true"
          className={cn(
            NOTEBOOK_ITEM_CLASS,
            'min-h-9',
            'flowix-notebook-drop-placeholder rounded-lg border-2 border-dashed border-[color-mix(in_oklch,var(--primary)_62%,var(--border))] bg-[color-mix(in_oklch,var(--primary)_5%,transparent)]',
          )}
        />
      );
    }

    const notebook = notebooksById.get(notebookId);
    if (!notebook) return null;
    const isActive = selectedNotebook?.id === notebook.id;
    const isMissing = Boolean(notebook.missing);

    return (
      <div
        key={notebook.id}
        ref={(element) => {
          if (element) itemRefs.current.set(notebook.id, element);
          else itemRefs.current.delete(notebook.id);
        }}
        role="button"
        tabIndex={0}
        aria-pressed={isActive}
        onPointerDown={(event) => handleCardPointerDown(notebook, event)}
        onKeyDown={(event) => handleCardKeyDown(notebook, event)}
        className={cn(
          NOTEBOOK_ITEM_CLASS,
          'group relative flex cursor-pointer select-none items-center gap-0 rounded-lg px-1.5 py-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
          isActive
            ? 'bg-[color-mix(in_oklch,var(--primary)_9%,var(--popover))]'
            : 'bg-transparent hover:bg-[var(--muted)]',
          isMissing && 'opacity-70',
        )}
        style={{ touchAction: 'none' }}
      >
        <NotebookIcon
          icon={notebook.icon}
          name={notebook.name}
          className={cn(
            'mr-3 h-7 w-7 shrink-0 rounded-md text-[15px] font-semibold transition-colors duration-150',
            isActive
              ? 'bg-[color-mix(in_oklch,var(--primary)_16%,var(--muted))] !text-[var(--primary)]'
              : 'bg-[var(--muted)] !text-[var(--foreground)]',
          )}
          fallbackClassName={cn(
            isActive
              ? '!text-[color-mix(in_oklch,var(--primary)_25%,transparent)]'
              : '!text-[color-mix(in_oklch,var(--foreground)_25%,transparent)]',
          )}
          imageClassName="h-[72%] w-[72%]"
        />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn(
              'block min-w-0 flex-1 truncate text-sm',
              isMissing ? 'text-[var(--muted-foreground)]' : 'text-[var(--foreground)]',
            )}
            title={notebook.name}
          >
            {notebook.name}
            {isMissing && ` ${t('status.invalid')}`}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--muted-foreground)] group-hover:hidden group-focus-within:hidden">
            {notebook.pinned && (
              <span title={t('memo.list.notebookMenu.pin')}>
                <StarIcon
                  className="h-4 w-4 text-[var(--primary)]"
                  aria-label={t('memo.list.notebookMenu.pin')}
                  weight="fill"
                />
              </span>
            )}
            {cloudSyncedNotebookIds?.has(notebook.id) && (
              <span className="flex h-4 w-3 shrink-0 items-center justify-center" aria-hidden="true">
                <span
                  className={cn(
                    'h-2 w-2 rounded-full',
                    cloudSyncAvailable ? 'bg-[var(--success)]' : 'bg-[var(--muted-foreground)]',
                  )}
                  aria-hidden="true"
                />
              </span>
            )}
            <span className="text-sm">
              {notebook.memoCount === undefined ? '—' : t('status.notebookMemoCount', { count: notebook.memoCount })}
            </span>
          </span>
        </div>
        <div className="flex w-0 shrink-0 items-center justify-end gap-0.5 overflow-hidden opacity-0 transition-[width,opacity] duration-[37.5ms] group-hover:w-[76px] group-hover:opacity-100 group-focus-within:w-[76px] group-focus-within:opacity-100">
          <button
            type="button"
            aria-label={t(notebook.pinned ? 'memo.list.notebookMenu.unpin' : 'memo.list.notebookMenu.pin')}
            title={t(notebook.pinned ? 'memo.list.notebookMenu.unpin' : 'memo.list.notebookMenu.pin')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              void toggleNotebookPinned(notebook);
            }}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
          >
            <StarIcon className="h-4 w-4" weight={notebook.pinned ? 'fill' : 'regular'} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={t('common.edit')}
            title={t('common.edit')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              closeThen(() => onEdit(notebook));
            }}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
          >
            <PencilSimpleIcon className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={t('dialog.delete')}
            title={t('dialog.delete')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              closeThen(() => onDelete(notebook));
            }}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--destructive)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
          >
            <TrashSimpleIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            className="flex h-[26px] items-center gap-0.5 pl-2.5 pr-1 text-[var(--foreground)] hover:bg-[var(--muted)]"
            aria-label={t('status.switchNotebook')}
            title={t('status.switchNotebook')}
          >
            {selectedNotebook?.icon && (
              <NotebookIcon
                icon={selectedNotebook.icon}
                name={selectedNotebook.name}
                className="h-4 w-4 rounded text-[12px] font-semibold !text-[var(--foreground)]"
              />
            )}
            {selectedNotebook?.name && (
              <span className="w-fit max-w-20 min-w-0 truncate text-xs text-[var(--muted-foreground)]">
                {selectedNotebook.name}
              </span>
            )}
            <ChevronsUpDown className="h-3 w-3 shrink-0 text-[var(--foreground)]" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side={side}
        sideOffset={sideOffset}
        onExitComplete={handleExitComplete}
        aria-label={t('status.notebookList')}
        className={cn(
          'flowix-notebook-selector-popup !z-[150] !w-[320px] !max-w-[calc(100vw-1rem)] !h-auto !max-h-[72vh] !flex !flex-col !overflow-hidden !rounded-xl !border-[var(--border-popup)] !bg-[var(--popover)] !p-0 !text-[var(--foreground)] !shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]',
          side === 'bottom' && 'flowix-notebook-selector-popup--bottom',
        )}
      >
        <div className="shrink-0 px-2">
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => {
              const value = event.target.value;
              setSearchQuery(value);
              if (!searchComposingRef.current && !(event.nativeEvent as InputEvent).isComposing) {
                setFilterQuery(value);
              }
            }}
            onCompositionStart={() => { searchComposingRef.current = true; }}
            onCompositionEnd={(event) => {
              searchComposingRef.current = false;
              const value = event.currentTarget.value;
              setSearchQuery(value);
              setFilterQuery(value);
            }}
            placeholder={t('status.searchNotebookPlaceholder')}
            aria-label={t('status.searchNotebookPlaceholder')}
            className="agent-composer__note-search flowix-notebook-selector-search !mt-0 !h-[48px] !text-[var(--foreground)]"
          />
        </div>
        <OverlayScrollbar
          className="flowix-notebook-selector-scrollbar min-h-0 max-h-[calc(72vh-6.375rem)] flex-initial"
          scrollerRef={listViewportRef}
          scrollerClassName="min-h-0 max-h-[calc(72vh-6.375rem)] overflow-x-hidden overflow-y-auto overscroll-contain px-2 pt-1 pb-1"
        >
          <div className="flex flex-col gap-1">
            {notebooks.length === 0 && (
              <div className="px-3 py-4 text-center text-sm text-[var(--muted-foreground)]">
                {t('status.noNotebooks')}
              </div>
            )}
            {notebooks.length > 0 && normalizedSearchQuery && previewNotebookIds.length === 0 && (
              <div className="px-3 py-4 text-center text-sm text-[var(--muted-foreground)]">
                {t('status.noMatchingNotebooks')}
              </div>
            )}
            {groupedNotebookIds.pinned.length > 0 && (
              <>
                <div className="px-2 pb-0.5 pt-1.5 text-xs font-medium text-[var(--muted-foreground)]">
                  {t('status.notebookPinnedSection')}
                </div>
                <div className="flex flex-col space-y-0.5">
                  {groupedNotebookIds.pinned.map((id) => renderNotebookItem(id))}
                </div>
              </>
            )}
            {groupedNotebookIds.others.length > 0 && (
              <>
                <div className="px-2 pb-0.5 pt-1.5 text-xs font-medium text-[var(--muted-foreground)]">
                  {t('status.notebookAllSection')}
                </div>
                <div className="flex flex-col space-y-0.5">
                  {groupedNotebookIds.others.map((id) => renderNotebookItem(id))}
                </div>
              </>
            )}
          </div>
        </OverlayScrollbar>
        <div className="shrink-0 p-2">
          <Button
            type="button"
            className="h-9 w-full border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] hover:bg-[var(--hover-bg)]"
            onClick={() => closeThen(onCreateNotebook)}
          >
            <Plus />
            {t('status.newNotebook')}
          </Button>
        </div>

        {ghost && sourceNotebook && typeof document !== 'undefined' && createPortal(
          <div
            className="pointer-events-none fixed z-[160] flex origin-top-left items-center gap-3 rounded-lg border border-[color-mix(in_oklch,var(--primary)_70%,var(--border))] bg-[var(--popover)] px-1.5 py-1 opacity-95 shadow-[0_16px_40px_color-mix(in_oklch,var(--foreground)_18%,transparent)]"
            style={{
              left: ghost.pointerX + 10,
              top: ghost.pointerY + 10,
              width: ghost.ghostRect.width,
              height: ghost.ghostRect.height,
              transform: 'rotate(0.5deg) scale(1.01)',
            }}
          >
            <NotebookIcon
              icon={sourceNotebook.icon}
              name={sourceNotebook.name}
              className="h-7 w-7 shrink-0 rounded-md bg-[color-mix(in_oklch,var(--primary)_14%,var(--muted))] text-[15px] font-semibold !text-[var(--primary)]"
            />
            <div className="min-w-0 flex-1 space-y-0.5">
              <span className="block truncate text-sm text-[var(--foreground)]">
                {sourceNotebook.name}
              </span>
              <span className="block text-xs text-[var(--muted-foreground)]">
                {sourceNotebook.memoCount === undefined ? '—' : t('status.notebookMemoCount', { count: sourceNotebook.memoCount })}
              </span>
            </div>
          </div>,
          document.body,
        )}
      </PopoverContent>
    </Popover>
  );
}
