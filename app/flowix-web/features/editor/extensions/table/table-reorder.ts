import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import { CellSelection, TableMap, columnResizingPluginKey } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';
import { canReorderTable, reorderTable, tableAxisSelection, type Axis } from './table-reorder-commands';
import { TableReorderPreview } from './table-reorder-preview';

export interface TableReorderLabels {
  reorderColumn?: string;
  reorderRow?: string;
}

function localBox(element: HTMLElement, rail: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const parent = rail.getBoundingClientRect();
  const scaleX = rail.offsetWidth ? parent.width / rail.offsetWidth : 1;
  const scaleY = rail.offsetHeight ? parent.height / rail.offsetHeight : 1;
  return {
    left: (rect.left - parent.left) / (scaleX || 1),
    top: (rect.top - parent.top) / (scaleY || 1),
    width: rect.width / (scaleX || 1),
    height: rect.height / (scaleY || 1),
  };
}

interface Target {
  table: HTMLTableElement;
  node: PMNode;
  pos: number;
  row: number;
  column: number;
}

interface DragState {
  target: Target;
  axis: Axis;
  from: number;
  to: number;
  x: number;
  y: number;
  active: boolean;
  valid: boolean;
  anchor: DOMRect;
}

const DRAG_THRESHOLD = 5;
const DROP_TOLERANCE = 24;
const SCROLL_EDGE = 28;
const SCROLL_STEP = 10;

class ReorderView {
  private buttons: HTMLButtonElement[] = [];
  private pinnedButtons: HTMLButtonElement[] = [];
  private pinnedTarget: Target | null = null;
  private marker: HTMLDivElement;
  private readonly preview: TableReorderPreview;
  private target: Target | null = null;
  private pointerTarget: Element | null = null;
  private pinnedAxis: Axis | null = null;
  /** Grips belonging to the selection, independent of pointer hover. */
  private pinnedShowing = false;
  private drag: DragState | null = null;
  private readonly doc: Document;
  private readonly ownerWindow: Window;
  private scrollFrame: number | null = null;
  private lastMove: MouseEvent | null = null;

  constructor(private view: EditorView, labels?: TableReorderLabels) {
    this.doc = view.dom.ownerDocument;
    this.ownerWindow = this.doc.defaultView ?? window;
    this.marker = this.doc.createElement('div');
    this.marker.className = 'table-reorder-marker';
    this.marker.hidden = true;
    this.preview = new TableReorderPreview(this.doc);
    for (const pinned of [false, true]) for (const axis of ['column', 'row'] as const) {
      const button = this.doc.createElement('button');
      button.type = 'button';
      button.className = `table-reorder-handle table-reorder-handle--${axis}`;
      button.title = axis === 'column' ? (labels?.reorderColumn ?? 'Drag to reorder column') : (labels?.reorderRow ?? 'Drag to reorder row');
      button.setAttribute('aria-label', button.title);
      button.contentEditable = 'false';
      button.hidden = true;
      button.addEventListener('mousedown', event => this.start(event, axis, pinned));
      button.addEventListener('click', event => {
        if (event.detail !== 0) return;
        const target = pinned ? this.pinnedTarget : this.target;
        if (!target || !this.view.editable) return;
        const index = axis === 'row' ? target.row : target.column;
        this.pinnedAxis = axis;
        this.view.dispatch(this.view.state.tr.setSelection(tableAxisSelection(this.view.state.doc, target.node, target.pos, axis, index)));
        this.openMenu(axis, button.getBoundingClientRect());
      });
      (pinned ? this.pinnedButtons : this.buttons).push(button);
    }
    view.dom.addEventListener('mousemove', this.captureReorderMove, true);
    view.dom.addEventListener('mousemove', this.hover);
    view.dom.addEventListener('mouseleave', this.leave);
    this.doc.addEventListener('mousemove', this.move);
    this.doc.addEventListener('mouseup', this.end);
    this.doc.addEventListener('keydown', this.key);
    this.doc.addEventListener('scroll', this.scroll, true);
    this.doc.defaultView?.addEventListener('blur', this.cancel);
  }

  private read(target: EventTarget | null): Target | null {
    if (!(target instanceof Element)) return null;
    const cell = target.closest('td, th');
    const table = cell?.closest('table');
    if (!cell || !(table instanceof HTMLTableElement) || cell.closest('.ProseMirror') !== this.view.dom
      || !table.parentElement?.classList.contains('markdown-table-rail')) return null;
    const $pos = this.view.state.doc.resolve(this.view.posAtDOM(cell, 0));
    let cellDepth = 0;
    for (let d = $pos.depth; d > 0; d--) {
      const role = $pos.node(d).type.spec.tableRole;
      if (role === 'cell' || role === 'header_cell') cellDepth = d;
      const node = $pos.node(d);
      if (node.type.spec.tableRole !== 'table' || !cellDepth) continue;
      if (!canReorderTable(node)) return null;
      const bounds = TableMap.get(node).findCell($pos.before(cellDepth) - $pos.start(d));
      return { table, node, pos: $pos.before(d), row: bounds.top, column: bounds.left };
    }
    return null;
  }

  private hover = (event: MouseEvent): void => {
    // Read-only panes still show the grips: a document in the unfocused column
    // of a two-column workspace is read-only, and hiding the chrome there looks
    // like the feature was removed. start() keeps blocking the drag itself.
    if (this.drag) return;
    // Selected grips remain pinned independently while hover follows the pointer.
    if (event.target instanceof Element && event.target.closest('.table-reorder-handle')) return;
    this.pointerTarget = event.target instanceof Element ? event.target : null;
    this.target = this.read(event.target);
    if (!this.target) { this.hide(); return; }
    this.showHandles(this.target);
  };

  private showHandles(target: Target, selectedAxis?: Axis, pinned = false): void {
    if (pinned) this.pinnedTarget = target;
    else this.target = target;
    const { table, row, column } = target;
    const rail = table.parentElement!;
    const columnCell = table.rows[0].cells[column];
    const rowCell = table.rows[row].cells[0];
    const buttons = pinned ? this.pinnedButtons : this.buttons;
    if (buttons[0].parentElement !== rail) rail.append(...buttons);
    if (!pinned && this.marker.parentElement !== rail) rail.append(this.marker);
    const columnBox = localBox(columnCell, rail);
    const rowBox = localBox(rowCell, rail);
    const tableBox = localBox(table, rail);
    const [col, line] = pinned ? this.pinnedButtons : this.buttons;
    col.hidden = selectedAxis === 'row';
    line.hidden = selectedAxis === 'column';
    col.toggleAttribute('data-selected', selectedAxis === 'column');
    line.toggleAttribute('data-selected', selectedAxis === 'row');
    col.style.left = `${Math.round(columnBox.left + columnBox.width / 2 - col.offsetWidth / 2)}px`;
    col.style.top = `${Math.round(tableBox.top - col.offsetHeight / 2)}px`;
    line.style.left = `${Math.round(tableBox.left - line.offsetWidth / 2)}px`;
    line.style.top = `${Math.round(rowBox.top + rowBox.height / 2 - line.offsetHeight / 2)}px`;
  }

  /** Row/column of the first selected cell in reading order, or the caret cell. */
  private selectionTarget(selection: CellSelection | TextSelection): Target | null {
    const $cell = selection instanceof CellSelection ? selection.$anchorCell : selection.$from;
    let cellPos: number | null = selection instanceof CellSelection ? $cell.pos : null;
    for (let depth = $cell.depth; depth > 0; depth--) {
      const node = $cell.node(depth);
      const role = node.type.spec.tableRole;
      if (cellPos === null && (role === 'cell' || role === 'header_cell')) {
        if (selection.to > $cell.end(depth)) return null;
        cellPos = $cell.before(depth);
      }
      if (role !== 'table' || cellPos === null) continue;
      const pos = $cell.before(depth);
      const dom = this.view.nodeDOM(pos);
      const table = dom instanceof HTMLElement ? dom.querySelector('table') : null;
      if (!canReorderTable(node) || !(table instanceof HTMLTableElement)) return null;
      const start = $cell.start(depth);
      const map = TableMap.get(node);
      const bounds = selection instanceof CellSelection
        ? map.rectBetween(selection.$anchorCell.pos - start, selection.$headCell.pos - start)
        : map.findCell(cellPos - start);
      return { table, node, pos, row: bounds.top, column: bounds.left };
    }
    return null;
  }

  /** Grip for the row/column a grip drag just selected, so the drag's result
   * stays visible without the pointer resting on it. */
  private pinAxisSelection(selection: CellSelection, axis: Axis): boolean {
    const $cell = selection.$anchorCell;
    for (let depth = $cell.depth; depth > 0; depth--) {
      const node = $cell.node(depth);
      if (node.type.spec.tableRole !== 'table') continue;
      const pos = $cell.before(depth);
      const map = TableMap.get(node);
      const start = $cell.start(depth);
      const bounds = map.rectBetween(selection.$anchorCell.pos - start, selection.$headCell.pos - start);
      const matches = axis === 'row'
        ? selection.isRowSelection() && bounds.bottom - bounds.top === 1
        : selection.isColSelection() && bounds.right - bounds.left === 1;
      const dom = this.view.nodeDOM(pos);
      const table = dom instanceof HTMLElement ? dom.querySelector('table') : null;
      if (matches && canReorderTable(node) && table instanceof HTMLTableElement) {
        this.showHandles({ table, node, pos, row: bounds.top, column: bounds.left }, axis, true);
        return true;
      }
      return false;
    }
    return false;
  }

  /** Chrome that outlives the pointer: the row/column a grip drag just moved,
   * and the row/column of the selected cell — the selection stays framed, so
   * the grips for its row and column stay with it until the selection changes.
   * Returns true when one of those is showing. Hover chrome is not ours to tear
   * down here: only grips this method put up are cleared. */
  private syncPinned(): boolean {
    const selection = this.view.state.selection;
    if (this.pinnedAxis) {
      if (this.view.editable && selection instanceof CellSelection && this.pinAxisSelection(selection, this.pinnedAxis)) {
        this.pinnedShowing = true;
        return true;
      }
      this.pinnedAxis = null;
    }
    if (this.view.editable && (selection instanceof CellSelection || selection instanceof TextSelection)) {
      const target = this.selectionTarget(selection);
      if (target) { this.showHandles(target, undefined, true); this.pinnedShowing = true; return true; }
    }
    if (this.pinnedShowing) {
      this.pinnedShowing = false;
      this.pinnedTarget = null;
      this.pinnedButtons.forEach(button => { button.removeAttribute('data-selected'); button.hidden = true; });
    }
    return false;
  }

  private start(event: MouseEvent, axis: Axis, pinned: boolean): void {
    const target = pinned ? this.pinnedTarget : this.target;
    if (event.button !== 0 || !target || !this.view.editable) return;
    event.preventDefault(); event.stopPropagation();
    const from = axis === 'row' ? target.row : target.column;
    const rail = target.table.parentElement!;
    if (this.marker.parentElement !== rail) rail.append(this.marker);
    this.pinnedAxis = axis;
    this.view.dom.setAttribute('data-table-reordering', 'true');
    const tr = this.view.state.tr.setSelection(tableAxisSelection(this.view.state.doc, target.node, target.pos, axis, from));
    // Remove an existing resize hover before it can resemble the drop marker.
    if (columnResizingPluginKey.getState(this.view.state)) tr.setMeta(columnResizingPluginKey, { setHandle: -1 });
    this.view.dispatch(tr);
    this.drag = { target, axis, from, to: from, x: event.clientX, y: event.clientY, active: false, valid: false,
      anchor: (event.currentTarget as HTMLElement).getBoundingClientRect() };
  }

  private captureReorderMove = (event: MouseEvent): void => {
    if (!this.drag) return;
    // Own pointer movement until mouseup, before ProseMirror's resize handler.
    // Outside the editor, the document listener still handles drag movement.
    event.stopImmediatePropagation();
    this.move(event);
  };

  private move = (event: MouseEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_THRESHOLD) return;
    drag.active = true;
    this.preview.show(this.view.dom, drag.target.table, drag.axis, drag.from, event);
    this.lastMove = event;
    if (this.scrollFrame === null) this.scrollFrame = this.ownerWindow.requestAnimationFrame(this.autoScroll);
    event.preventDefault();
    const { table } = drag.target;
    const rect = table.getBoundingClientRect();
    drag.valid = event.clientX >= rect.left - DROP_TOLERANCE && event.clientX <= rect.right + DROP_TOLERANCE
      && event.clientY >= rect.top - DROP_TOLERANCE && event.clientY <= rect.bottom + DROP_TOLERANCE;
    if (!drag.valid) { this.marker.hidden = true; return; }
    const items = drag.axis === 'row' ? Array.from(table.rows) : Array.from(table.rows[0].cells);
    const coordinate = drag.axis === 'row' ? event.clientY : event.clientX;
    let boundary = items.findIndex(item => {
      const box = item.getBoundingClientRect();
      return coordinate < (drag.axis === 'row' ? (box.top + box.bottom) / 2 : (box.left + box.right) / 2);
    });
    if (boundary < 0) boundary = items.length;
    drag.to = Math.max(0, Math.min(items.length - 1, boundary > drag.from ? boundary - 1 : boundary));
    const item = items[Math.min(boundary, items.length - 1)];
    const box = localBox(item as HTMLElement, table.parentElement!);
    const tableBox = localBox(table, table.parentElement!);
    const edge = drag.axis === 'row'
      ? box.top + (boundary === items.length ? box.height : 0)
      : box.left + (boundary === items.length ? box.width : 0);
    this.marker.hidden = drag.to === drag.from;
    this.marker.style.cssText = drag.axis === 'row'
      ? `left:${tableBox.left}px;top:${edge}px;width:${tableBox.width}px;height:2px`
      : `left:${edge}px;top:${tableBox.top}px;width:2px;height:${tableBox.height}px`;
  };

  private openMenu(axis: Axis, anchor: DOMRect): void {
    this.view.dom.dispatchEvent(new CustomEvent('flowix:table-axis-menu', { detail: { axis, anchor } }));
  }

  private end = (): void => {
    const drag = this.drag;
    // Only a grip drag owns the document-wide mouseup. A plain click anywhere —
    // including the one that puts the caret into a cell — used to run straight
    // into cancel()/hide(), so the grips blinked out on click and only came
    // back on the next mousemove. Hover chrome is not ours to tear down here.
    if (!drag) return;
    this.cancel();
    if (drag.active && drag.valid && this.view.state.doc.nodeAt(drag.target.pos) === drag.target.node) {
      reorderTable(this.view, drag.target.pos, drag.axis, drag.from, drag.to);
      this.view.focus();
    } else if (!drag.active) {
      this.openMenu(drag.axis, drag.anchor);
    }
  };
  private autoScroll = (): void => {
    this.scrollFrame = null;
    const drag = this.drag;
    const event = this.lastMove;
    if (!drag || !event) return;
    const horizontal = drag.target.table.closest<HTMLElement>('.tableWrapper');
    const vertical = this.view.dom.closest<HTMLElement>('.editor-content');
    let changed = false;
    for (const [element, axis] of [[horizontal, 'x'], [vertical, 'y']] as const) {
      if (!element || (axis === 'x' ? drag.axis !== 'column' : drag.axis !== 'row')) continue;
      const rect = element.getBoundingClientRect();
      const point = axis === 'x' ? event.clientX : event.clientY;
      const start = axis === 'x' ? rect.left : rect.top;
      const end = axis === 'x' ? rect.right : rect.bottom;
      const delta = point < start + SCROLL_EDGE ? -SCROLL_STEP : point > end - SCROLL_EDGE ? SCROLL_STEP : 0;
      const before = axis === 'x' ? element.scrollLeft : element.scrollTop;
      if (axis === 'x') element.scrollLeft += delta;
      else element.scrollTop += delta;
      changed ||= before !== (axis === 'x' ? element.scrollLeft : element.scrollTop);
    }
    if (changed) this.move(event);
  };

  private key = (event: KeyboardEvent): void => { if (event.key === 'Escape') this.cancel(); };
  private leave = (): void => { this.pointerTarget = null; if (!this.drag) this.hide(); };
  private scroll = (): void => { this.pointerTarget = null; if (!this.drag) this.hide(); };
  /** Re-resolve the hovered cell from the pointer position after the document
   * moved under it, so typing in a cell does not blank chrome the user is still
   * pointing at. Positions from before the change are discarded, never reused. */
  private resolvePointer(): void {
    const pointer = this.pointerTarget;
    if (!pointer?.isConnected || !this.view.dom.contains(pointer)) return;
    const target = this.read(pointer);
    if (target) this.showHandles(target);
  }
  private hide(): void {
    this.buttons.forEach(button => { button.hidden = true; });
    this.marker.hidden = true;
    this.preview.hide();
    this.syncPinned();
  }
  private cancel = (): void => {
    if (this.scrollFrame !== null) this.ownerWindow.cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = null;
    this.lastMove = null;
    this.drag = null;
    this.view.dom.removeAttribute('data-table-reordering');
    this.hide();
  };
  update(view: EditorView, previous: EditorState): void {
    this.view = view;
    // Resizing and selection plugins dispatch view-only transactions during a
    // native drag. Only a content change invalidates our document positions.
    if (previous.doc !== view.state.doc || !view.editable) {
      const wasVisible = this.buttons.some(button => !button.hidden);
      this.target = null;
      this.cancel();
      // Editing a cell rewrites the document under a pointer that never moved.
      // Re-resolve the cell it still points at instead of blanking the grips;
      // read-only panes keep them too, as a CSS-ghosted hint.
      if (wasVisible && !this.pinnedShowing) this.resolvePointer();
    } else if (this.drag && !previous.selection.eq(view.state.selection)) {
      this.cancel();
    } else if (!this.drag) {
      this.syncPinned();
    }
  }
  destroy(): void {
    this.pinnedAxis = null;
    this.pointerTarget = null;
    this.cancel();
    this.view.dom.removeEventListener('mousemove', this.captureReorderMove, true);
    this.view.dom.removeEventListener('mousemove', this.hover);
    this.view.dom.removeEventListener('mouseleave', this.leave);
    this.doc.removeEventListener('mousemove', this.move);
    this.doc.removeEventListener('mouseup', this.end);
    this.doc.removeEventListener('keydown', this.key);
    this.doc.removeEventListener('scroll', this.scroll, true);
    this.doc.defaultView?.removeEventListener('blur', this.cancel);
    this.buttons.forEach(button => button.remove());
    this.pinnedButtons.forEach(button => button.remove());
    this.marker.remove();
    this.preview.destroy();
  }
}

export function createTableReorderPlugin(labels?: TableReorderLabels): Plugin {
  return new Plugin({ key: new PluginKey('tableReorder'), view: view => new ReorderView(view, labels) });
}
