import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';

import { suppressTextSelectionForDrag } from '@shared/drag-drop/drag-drop-coordinator';

interface DropMarker {
  top: number;
  left: number;
  width: number;
}

interface RowDragOptions {
  tableRef: RefObject<HTMLTableElement | null>;
  scrollerRef: RefObject<HTMLDivElement | null>;
  recordIds: readonly string[];
  viewId: string | null;
  nextRecordId: string | null;
  disabled: boolean;
  sorted: boolean;
  confirmClearSort: () => boolean;
  onReorder: (recordId: string, beforeRecordId: string | null, clearSort: boolean) => Promise<unknown>;
}

function moveRecordId(ids: readonly string[], sourceId: string, beforeId: string | null): string[] {
  const next = ids.filter((id) => id !== sourceId);
  const beforeIndex = beforeId ? next.indexOf(beforeId) : -1;
  next.splice(beforeIndex >= 0 ? beforeIndex : next.length, 0, sourceId);
  return next;
}

function copyRowForPreview(row: HTMLTableRowElement, table: HTMLTableElement): HTMLDivElement {
  const preview = window.document.createElement('div');
  preview.className = 'multidimensional-table__row-drag-floating';
  preview.setAttribute('aria-hidden', 'true');
  preview.inert = true;

  const previewTable = window.document.createElement('table');
  previewTable.className = table.className;
  previewTable.style.width = `${table.getBoundingClientRect().width}px`;
  previewTable.style.minWidth = previewTable.style.width;
  previewTable.style.tableLayout = 'fixed';
  const colgroup = table.querySelector('colgroup');
  if (colgroup) previewTable.append(colgroup.cloneNode(true));

  const body = window.document.createElement('tbody');
  const clone = row.cloneNode(true) as HTMLTableRowElement;
  clone.removeAttribute('data-table-record');
  clone.removeAttribute('data-table-reorderable-record');
  clone.removeAttribute('data-row-dragging-source');
  clone.removeAttribute('data-selected');
  clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
  clone.querySelectorAll('.multidimensional-table__row-leading-controls').forEach((element) => element.remove());
  clone.querySelectorAll('button, input, textarea, select').forEach((element) => {
    (element as HTMLButtonElement).disabled = true;
  });
  body.append(clone);
  previewTable.append(body);
  preview.append(previewTable);
  preview.style.width = previewTable.style.width;
  window.document.body.append(preview);
  return preview;
}

/** Pointer-driven row reordering for the table view. The row order is persisted by the owner. */
export function useTableRowDrag({
  tableRef,
  scrollerRef,
  recordIds,
  viewId,
  nextRecordId,
  disabled,
  sorted,
  confirmClearSort,
  onReorder,
}: RowDragOptions) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropMarker, setDropMarker] = useState<DropMarker | null>(null);
  const latest = useRef({ recordIds, viewId, nextRecordId, disabled, sorted, confirmClearSort, onReorder });
  latest.current = { recordIds, viewId, nextRecordId, disabled, sorted, confirmClearSort, onReorder };
  const session = useRef<{
    recordId: string;
    pointerId: number;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    active: boolean;
    sourceRow: HTMLTableRowElement;
    floating: HTMLDivElement | null;
    beforeRecordId: string | null;
    validDrop: boolean;
    viewId: string | null;
    releaseTextSelection: (() => void) | null;
  } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;

    const clear = () => {
      cancelAnimationFrame(frame);
      session.current?.floating?.remove();
      session.current?.releaseTextSelection?.();
      session.current = null;
      setDraggedId(null);
      setDropMarker(null);
    };

    const setMarker = (next: DropMarker | null) => {
      setDropMarker((current) => {
        if (!next || !current) return next;
        return Math.abs(current.top - next.top) < 1
          && Math.abs(current.left - next.left) < 1
          && Math.abs(current.width - next.width) < 1 ? current : next;
      });
    };

    const update = () => {
      const drag = session.current;
      const table = tableRef.current;
      const scroller = scrollerRef.current;
      if (!drag?.active) return;
      if (!table || !scroller || latest.current.disabled
        || latest.current.viewId !== drag.viewId
        || !drag.sourceRow.isConnected
        || !latest.current.recordIds.includes(drag.recordId)) {
        clear();
        return;
      }

      if (drag.floating) {
        drag.floating.style.transform = `translate(${pointerX - drag.offsetX}px, ${pointerY - drag.offsetY}px)`;
      }

      const viewport = scroller.getBoundingClientRect();
      const tableBounds = table.getBoundingClientRect();
      const inside = pointerX >= viewport.left && pointerX <= viewport.right
        && pointerY >= viewport.top && pointerY <= viewport.bottom;
      const rows = [...table.querySelectorAll<HTMLTableRowElement>('tbody tr[data-table-reorderable-record]')]
        .filter((row) => row !== drag.sourceRow && row.dataset.tableReorderableRecord)
        .map((row) => ({ row, bounds: row.getBoundingClientRect(), id: row.dataset.tableReorderableRecord! }))
        .filter(({ bounds }) => bounds.bottom > viewport.top && bounds.top < viewport.bottom);
      if (!inside || !rows.length) {
        drag.beforeRecordId = null;
        drag.validDrop = false;
        setMarker(null);
        return;
      }

      let insertAt = rows.findIndex(({ bounds }) => pointerY < bounds.top + bounds.height / 2);
      if (insertAt < 0) insertAt = rows.length;
      const anchor = rows[insertAt];
      const markerTop = anchor ? anchor.bounds.top : rows[rows.length - 1].bounds.bottom;
      const markerLeft = Math.max(tableBounds.left, viewport.left);
      const markerRight = Math.min(tableBounds.right, viewport.right);
      drag.beforeRecordId = anchor?.id ?? latest.current.nextRecordId;
      drag.validDrop = markerRight > markerLeft;
      setMarker(markerRight > markerLeft ? { top: markerTop, left: markerLeft, width: markerRight - markerLeft } : null);
    };

    const tick = () => {
      const drag = session.current;
      if (!drag?.active) return;
      const scroller = scrollerRef.current;
      const bounds = scroller?.getBoundingClientRect();
      if (scroller && bounds && pointerX >= bounds.left && pointerX <= bounds.right
        && pointerY >= bounds.top && pointerY <= bounds.bottom) {
        const delta = pointerY < bounds.top + 40 ? -12 : pointerY > bounds.bottom - 40 ? 12 : 0;
        if (delta) scroller.scrollTop += delta;
      }
      update();
      if (session.current?.active) frame = requestAnimationFrame(tick);
    };

    const move = (event: PointerEvent) => {
      const drag = session.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (latest.current.disabled) {
        clear();
        return;
      }
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (!drag.active) {
        if (Math.hypot(pointerX - drag.startX, pointerY - drag.startY) < 6) return;
        drag.active = true;
        drag.releaseTextSelection = suppressTextSelectionForDrag();
        suppressClick.current = true;
        drag.floating = copyRowForPreview(drag.sourceRow, tableRef.current!);
        const bounds = drag.sourceRow.getBoundingClientRect();
        drag.offsetX = event.clientX - bounds.left;
        drag.offsetY = event.clientY - bounds.top;
        setDraggedId(drag.recordId);
        frame = requestAnimationFrame(tick);
      }
      event.preventDefault();
      update();
    };

    const up = (event: PointerEvent) => {
      const drag = session.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      pointerX = event.clientX;
      pointerY = event.clientY;
      update();
      if (session.current !== drag) return;
      const beforeRecordId = drag.beforeRecordId;
      const active = drag.active;
      const sortedAtDrop = latest.current.sorted;
      const reorderedIds = active && drag.validDrop
        ? moveRecordId(latest.current.recordIds, drag.recordId, beforeRecordId)
        : [...latest.current.recordIds];
      const changed = active && drag.validDrop
        && reorderedIds.some((id, index) => id !== latest.current.recordIds[index]);
      if (!changed) {
        clear();
        return;
      }
      const clearSort = sortedAtDrop && latest.current.confirmClearSort();
      clear();
      if (sortedAtDrop && !clearSort) return;
      void latest.current.onReorder(drag.recordId, beforeRecordId, clearSort).catch(() => undefined);
    };

    const cancel = (event: PointerEvent) => {
      if (session.current?.pointerId === event.pointerId) clear();
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') clear(); };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', clear);
    return () => {
      clear();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', clear);
    };
  }, [scrollerRef, tableRef]);

  return {
    draggedId,
    dropMarker,
    onPointerDown: (event: ReactPointerEvent<HTMLTableElement>) => {
      suppressClick.current = false;
      if (disabled || event.button !== 0 || !(event.target instanceof Element)) return;
      const handle = event.target.closest<HTMLElement>('[data-row-drag-handle]');
      const row = handle?.closest<HTMLTableRowElement>('tr[data-table-reorderable-record]');
      const recordId = row?.dataset.tableReorderableRecord;
      if (!handle || !row || !recordId) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = row.getBoundingClientRect();
      session.current = {
        recordId,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - bounds.left,
        offsetY: event.clientY - bounds.top,
        active: false,
        sourceRow: row,
        floating: null,
        beforeRecordId: null,
        validDrop: false,
        viewId: latest.current.viewId,
        releaseTextSelection: null,
      };
    },
    onClickCapture: (event: ReactMouseEvent<HTMLTableElement>) => {
      if (!suppressClick.current) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClick.current = false;
    },
  };
}
