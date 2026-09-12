'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronsUpDown, Pencil, Plus, Trash2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { notebooks as notebooksClient } from '@platform/tauri/client';
import { NotebookIcon, useMemoStore, type Notebook } from '@features/memo';
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
  cardRects: Map<string, DOMRect>;
  gridRect: DOMRect | null;
}

const DRAG_THRESHOLD_PX = 4;

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
  const reorderNotebooks = useMemoStore((state) => state.reorderNotebooks);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const previousCardRectsRef = useRef(new Map<string, DOMRect>());
  const cardAnimationsRef = useRef(new Map<string, Animation>());
  const pointerRef = useRef<PointerState | null>(null);
  const dragGeometryRef = useRef<DragGeometry | null>(null);
  const refreshRequestRef = useRef(0);
  const pendingAfterCloseRef = useRef<(() => void) | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [ghost, setGhost] = useState<PointerState | null>(null);

  const previewNotebookIds = useMemo(
    () => draggingId
      ? reorderNotebookIds(notebooks, draggingId, dropTarget)
      : notebooks.map((notebook) => notebook.id),
    [draggingId, dropTarget, notebooks],
  );

  useLayoutEffect(() => {
    const nextRects = new Map<string, DOMRect>();
    for (const [id, card] of cardRefs.current) {
      const activeAnimation = cardAnimationsRef.current.get(id);
      const visualRect = activeAnimation ? card.getBoundingClientRect() : null;
      activeAnimation?.cancel();
      cardAnimationsRef.current.delete(id);
      const nextRect = card.getBoundingClientRect();
      nextRects.set(id, nextRect);
      const previousRect = visualRect ?? previousCardRectsRef.current.get(id);
      if (!previousRect || typeof card.animate !== 'function') continue;
      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue;
      const animation = card.animate(
        [
          { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
          { transform: 'translate3d(0, 0, 0)' },
        ],
        { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
      cardAnimationsRef.current.set(id, animation);
      animation.addEventListener('finish', () => {
        if (cardAnimationsRef.current.get(id) === animation) {
          cardAnimationsRef.current.delete(id);
        }
      }, { once: true });
    }
    previousCardRectsRef.current = nextRects;
  }, [previewNotebookIds]);

  useEffect(() => () => {
    for (const animation of cardAnimationsRef.current.values()) animation.cancel();
    cardAnimationsRef.current.clear();
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

  useEffect(() => () => {
    refreshRequestRef.current += 1;
  }, []);

  useEffect(() => {
    if (open) pendingAfterCloseRef.current = null;
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
      if (!geometry?.gridRect) return null;
      const { gridRect } = geometry;
      if (x < gridRect.left || x > gridRect.right || y < gridRect.top || y > gridRect.bottom) {
        return null;
      }
      const sourceRect = geometry.cardRects.get(sourceId);
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
        const rect = geometry.cardRects.get(notebook.id);
        if (!rect) continue;
        const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const distance = Math.hypot(x - centerX, y - centerY);
        const position: DropPosition = x < centerX ? 'before' : 'after';

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
  }, [closeThen, notebooks, onSelect, reorderNotebooks, t]);

  const handleCardPointerDown = (notebook: Notebook, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pointerRef.current) return;
    event.preventDefault();
    const cardRects = new Map<string, DOMRect>();
    let gridRect: DOMRect | null = null;
    for (const [id, card] of cardRefs.current) {
      const rect = card.getBoundingClientRect();
      cardRects.set(id, rect);
      if (!gridRect) {
        gridRect = rect;
        continue;
      }
      const left = Math.min(gridRect.left, rect.left);
      const top = Math.min(gridRect.top, rect.top);
      const right = Math.max(gridRect.right, rect.right);
      const bottom = Math.max(gridRect.bottom, rect.bottom);
      gridRect = new DOMRect(left, top, right - left, bottom - top);
    }
    dragGeometryRef.current = { cardRects, gridRect };
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

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            className="flex h-[26px] items-center gap-1 bg-[var(--primary)] pl-2.5 pr-1 hover:opacity-90"
            aria-label={t('status.switchNotebook')}
            title={t('status.switchNotebook')}
          >
            <NotebookIcon
              icon={selectedNotebook?.icon}
              name={selectedNotebook?.name}
              className="h-4 w-4 rounded text-[12px] font-semibold text-[var(--primary-foreground)]"
            />
            <ChevronsUpDown className="h-3 w-3 shrink-0 text-[var(--primary-foreground)]" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side={side}
        sideOffset={sideOffset}
        onExitComplete={handleExitComplete}
        className={cn(
          'flowix-notebook-selector-popup ml-1.5 flex h-auto max-h-[calc(100vh-8px)] w-[390px] flex-col overflow-hidden rounded-xl border-[var(--border-popup)] bg-[var(--popover)] pb-2 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]',
          side === 'bottom' && 'flowix-notebook-selector-popup--bottom',
        )}
      >
        <div className="shrink-0 px-1.5 py-2 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          {t('status.notebookList')}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
          {notebooks.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-[var(--muted-foreground)]">
              {t('status.noNotebooks')}
            </div>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(108px,1fr))] gap-2.5">
            {previewNotebookIds.map((notebookId) => {
                if (notebookId === draggingId) {
                  return (
                    <div
                      key={`placeholder-${notebookId}`}
                      aria-hidden="true"
                      className="flowix-notebook-drop-placeholder min-h-[124px] rounded-lg border-2 border-dashed border-[color-mix(in_oklch,var(--primary)_62%,var(--border))] bg-[color-mix(in_oklch,var(--primary)_5%,transparent)]"
                    />
                  );
                }

                const notebook = notebooks.find((item) => item.id === notebookId);
                if (!notebook) return null;
                const isActive = selectedNotebook?.id === notebook.id;
                const isMissing = Boolean(notebook.missing);

                return (
                  <div
                    key={notebook.id}
                    ref={(element) => {
                      if (element) cardRefs.current.set(notebook.id, element);
                      else cardRefs.current.delete(notebook.id);
                    }}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isActive}
                    onPointerDown={(event) => handleCardPointerDown(notebook, event)}
                    onKeyDown={(event) => handleCardKeyDown(notebook, event)}
                    className={cn(
                      'group relative flex min-h-[124px] cursor-default select-none flex-col items-start gap-2 rounded-lg border px-3 py-3 text-left transition-[border-color,background-color,box-shadow]',
                      isActive
                        ? 'border-[var(--primary)]/50 bg-[color-mix(in_oklch,var(--primary)_10%,transparent)]'
                        : 'border-[var(--border)] hover:border-[var(--primary)]/50 hover:bg-[var(--muted)]/60',
                      isMissing && 'opacity-70',
                    )}
                    style={{
                      touchAction: 'none',
                      ...(isActive
                        ? {
                            backgroundColor: 'var(--popover)',
                            backgroundImage:
                              'radial-gradient(ellipse 90% 145% at 100% 0%, color-mix(in oklch, var(--primary) 18%, transparent), transparent 58%)',
                          }
                        : {}),
                    }}
                  >
                    <NotebookIcon
                      icon={notebook.icon}
                      name={notebook.name}
                      className={cn(
                        'h-7 w-7 shrink-0 rounded-md text-[11px] font-semibold transition-[color,background-color,opacity,filter] duration-150',
                        isActive
                          ? 'bg-[color-mix(in_oklch,var(--primary)_14%,var(--muted))] !text-[var(--primary)] opacity-100'
                          : 'bg-[var(--muted)] text-[var(--secondary-foreground)] opacity-75 saturate-75 group-hover:opacity-90 group-hover:saturate-90',
                      )}
                      imageClassName="h-[72%] w-[72%]"
                    />
                    <div className="mt-auto w-full space-y-1">
                      <span
                        className={cn(
                          'block min-h-5 w-full min-w-0 truncate text-left text-sm font-medium',
                          isMissing ? 'text-[var(--muted-foreground)]' : 'text-[var(--foreground)]',
                        )}
                        title={notebook.name}
                      >
                        {notebook.name}
                        {isMissing && ` ${t('status.invalid')}`}
                      </span>
                      <span className="flex items-center gap-0 text-left text-xs text-[var(--muted-foreground)]">
                        {cloudSyncedNotebookIds?.has(notebook.id) && (
                          <span className="flex h-4 w-3 shrink-0 items-center justify-center" aria-hidden="true">
                            <span
                              className={cn(
                                'h-2 w-2 rounded-full',
                                cloudSyncAvailable
                                  ? 'bg-[var(--success)]'
                                  : 'bg-[var(--muted-foreground)]',
                              )}
                              aria-hidden="true"
                            />
                          </span>
                        )}
                        {t('status.notebookMemoCount', { count: notebook.memoCount ?? 0 })}
                      </span>
                    </div>
                    <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <button
                        type="button"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          closeThen(() => onEdit(notebook));
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                        aria-label={t('status.editNotebook')}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          closeThen(() => onDelete(notebook));
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
                        aria-label={t('status.deleteNotebook')}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                );
            })}
            <button
              type="button"
              onClick={() => closeThen(onCreateNotebook)}
              className="group relative flex min-h-[124px] items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-transparent text-[var(--muted-foreground)] transition-colors hover:border-[var(--primary)]/50 hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
              aria-label={t('status.newNotebook')}
              title={t('status.newNotebook')}
            >
              <Plus className="h-7 w-7" />
            </button>
          </div>
        </div>

        {ghost && sourceNotebook && typeof document !== 'undefined' && createPortal(
          <div
            className="pointer-events-none fixed z-[160] flex origin-top-left flex-col items-start gap-2 rounded-lg border border-[color-mix(in_oklch,var(--primary)_70%,var(--border))] bg-[var(--popover)] px-3 py-3 opacity-95 shadow-[0_16px_40px_color-mix(in_oklch,var(--foreground)_18%,transparent)]"
            style={{
              left: ghost.pointerX + 10,
              top: ghost.pointerY + 10,
              width: ghost.ghostRect.width,
              height: ghost.ghostRect.height,
              transform: 'rotate(1.5deg) scale(1.02)',
            }}
          >
            <NotebookIcon
              icon={sourceNotebook.icon}
              name={sourceNotebook.name}
              className="h-7 w-7 shrink-0 rounded-md bg-[color-mix(in_oklch,var(--primary)_14%,var(--muted))] text-[11px] font-semibold !text-[var(--primary)]"
            />
            <div className="mt-auto w-full space-y-1">
              <span className="block truncate text-sm font-medium text-[var(--foreground)]">
                {sourceNotebook.name}
              </span>
              <span className="block text-xs text-[var(--muted-foreground)]">
                {t('status.notebookMemoCount', { count: sourceNotebook.memoCount ?? 0 })}
              </span>
            </div>
          </div>,
          document.body,
        )}
      </PopoverContent>
    </Popover>
  );
}
