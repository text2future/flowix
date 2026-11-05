import type { Editor } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';

type EdgeKind = 'column' | 'row';

interface EdgeTarget {
  cellPos: number;
  atLastColumn: boolean;
  atLastRow: boolean;
  table: HTMLTableElement;
  rail: HTMLElement;
}

const tableEdgeInsertPluginKey = new PluginKey('tableEdgeInsert');
const EDGE_BUTTON_SIZE = 16;
const EDGE_GAP = 4;

export interface TableEdgeInsertLabels {
  insertColumnAfter: string;
  insertRowAfter: string;
}

/** Neutral fallbacks for callers without an i18n context (tests, worker schemas). */
const DEFAULT_LABELS: TableEdgeInsertLabels = {
  insertColumnAfter: 'Insert column after',
  insertRowAfter: 'Insert row after',
};

function closestTableCell(target: EventTarget | null): HTMLTableCellElement | null {
  if (!(target instanceof Element)) return null;
  const cell = target.closest('td, th');
  return cell instanceof HTMLTableCellElement ? cell : null;
}

function getEdgeTarget(view: EditorView, eventTarget: EventTarget | null): EdgeTarget | null {
  const cell = closestTableCell(eventTarget);
  const table = cell?.closest('table');
  if (!cell || !(table instanceof HTMLTableElement)) return null;

  // NodeView 内部的 HTML 表格不属于 ProseMirror 表格节点，它们的 cell
  // 在编辑器文档中没有对应位置。若继续显示边缘插入按钮，控件会错位，
  // 点击 addRowAfter/addColumnAfter 也会作用到编辑器里的其他表格。
  if (cell.closest('.agent-thread-card, .table-reference-node')) return null;

  if (cell.closest('.ProseMirror') !== view.dom) return null;
  const rail = table.closest<HTMLElement>('.markdown-table-rail');
  if (!rail || table.parentElement !== rail) return null;
  const $pos = view.state.doc.resolve(view.posAtDOM(cell, 0));
  let cellDepth = 0;
  for (let depth = $pos.depth; depth > 0; depth--) {
    const role = $pos.node(depth).type.spec.tableRole;
    if (role === 'cell' || role === 'header_cell') cellDepth = depth;
    if (role !== 'table' || !cellDepth) continue;
    const map = TableMap.get($pos.node(depth));
    const cellPos = $pos.before(cellDepth);
    const rect = map.findCell(cellPos - $pos.start(depth));
    const atLastColumn = rect.right === map.width;
    const atLastRow = rect.bottom === map.height;
    return atLastColumn || atLastRow ? { cellPos, atLastColumn, atLastRow, table, rail } : null;
  }
  return null;
}

function setBox(
  element: HTMLElement,
  rect: { top: number; left: number; width: number; height: number },
): void {
  element.style.top = `${rect.top}px`;
  element.style.left = `${rect.left}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}

function positionSelectionInCell(view: EditorView, cellPos: number): void {
  const docSize = view.state.doc.content.size;
  const pos = Math.min(Math.max(cellPos + 1, 1), docSize);
  const $pos = view.state.doc.resolve(pos);

  view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)));
  view.focus();
}

class TableEdgeInsertView {
  private columnButton: HTMLButtonElement;
  private rowButton: HTMLButtonElement;
  private columnHoverZone: HTMLDivElement;
  private rowHoverZone: HTMLDivElement;
  private currentColumnCellPos: number | null = null;
  private currentRowCellPos: number | null = null;
  private hoverArea: HTMLElement;
  private overlayRoot: HTMLElement | null = null;
  private hideTimer: number | null = null;
  private frameId: number | null = null;
  private pendingTarget: EventTarget | null = null;
  // view 可能因为所在 Editor.destroy() 而失效；任何走 view.dom / view.posAtDOM
  // 的路径都要先看这个旗子。事件 listener 在 destroy 里已经 remove, 但
  // 浏览器仍可能 flush 一帧在途事件, 不守卫就会读到 detached dom 抛 warning。
  private isDestroyed = false;

  constructor(
    private view: EditorView,
    private editor: Editor,
    labels: TableEdgeInsertLabels = DEFAULT_LABELS,
  ) {
    this.hoverArea = this.findHoverArea();
    this.columnButton = this.createButton('column', labels.insertColumnAfter);
    this.rowButton = this.createButton('row', labels.insertRowAfter);
    this.columnHoverZone = this.createHoverZone('column');
    this.rowHoverZone = this.createHoverZone('row');

    this.hoverArea.addEventListener('mousemove', this.handleMouseMove);
    this.hoverArea.addEventListener('mouseleave', this.handleMouseLeave);
    this.hoverArea.addEventListener('scroll', this.handleScroll, { passive: true, capture: true });
  }

  update(view: EditorView): void {
    if (this.isDestroyed) return;
    this.view = view;
    this.hide();
  }

  destroy(): void {
    this.isDestroyed = true;
    // A pending hide timer would otherwise fire against the buttons removed
    // below, 120ms after the editor is gone.
    this.cancelScheduledHide();
    if (this.frameId !== null) window.cancelAnimationFrame(this.frameId);
    this.frameId = null;
    this.pendingTarget = null;
    this.hoverArea.removeEventListener('mousemove', this.handleMouseMove);
    this.hoverArea.removeEventListener('mouseleave', this.handleMouseLeave);
    this.hoverArea.removeEventListener('scroll', this.handleScroll, true);
    this.columnButton.remove();
    this.rowButton.remove();
    this.columnHoverZone.remove();
    this.rowHoverZone.remove();
  }

  private findHoverArea(): HTMLElement {
    const pane = this.view.dom.closest<HTMLElement>('.editor-content');
    if (pane) return pane;
    const parent = this.view.dom.parentElement;
    return parent instanceof HTMLElement ? parent : this.view.dom;
  }

  private createButton(kind: EdgeKind, title: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `table-edge-insert-button table-edge-insert-button--${kind}`;
    button.setAttribute('aria-label', title);
    button.title = title;
    button.hidden = true;

    button.addEventListener('mouseenter', this.cancelScheduledHide);
    button.addEventListener('mouseleave', this.scheduleHide);
    button.addEventListener('mousedown', (event) => this.handleButtonMouseDown(event, kind));

    return button;
  }

  private createHoverZone(kind: EdgeKind): HTMLDivElement {
    const zone = document.createElement('div');
    zone.className = `table-edge-insert-hover-zone table-edge-insert-hover-zone--${kind}`;
    zone.hidden = true;

    zone.addEventListener('mouseenter', this.cancelScheduledHide);
    zone.addEventListener('mouseleave', this.scheduleHide);

    return zone;
  }

  private handleButtonMouseDown(event: MouseEvent, kind: EdgeKind): void {
    if (this.isDestroyed) return;
    event.preventDefault();
    event.stopPropagation();

    const cellPos = kind === 'column' ? this.currentColumnCellPos : this.currentRowCellPos;
    if (cellPos === null || !this.editor.isEditable) return;

    positionSelectionInCell(this.view, cellPos);

    if (kind === 'column') {
      this.editor.chain().focus().addColumnAfter().run();
    } else {
      this.editor.chain().focus().addRowAfter().run();
    }

    this.hide();
  }

  private isEdgeControlTarget(target: EventTarget | null): boolean {
    return target instanceof Element && Boolean(
      target.closest('.table-edge-insert-button, .table-edge-insert-hover-zone'),
    );
  }

  private handleMouseMove = (event: MouseEvent): void => {
    if (this.isDestroyed) return;
    // Coalesce to one pass per frame: hit-testing reads layout and the button
    // placement writes it, so raw mousemove frequency forces layout thrash.
    this.pendingTarget = event.target;
    if (this.frameId !== null) return;
    this.frameId = window.requestAnimationFrame(this.flushMouseMove);
  };

  private flushMouseMove = (): void => {
    this.frameId = null;
    if (this.isDestroyed) return;
    const target = this.pendingTarget;
    this.pendingTarget = null;
    this.updateEdgeControls(target);
  };

  private updateEdgeControls(eventTarget: EventTarget | null): void {
    if (!this.editor.isEditable || this.view.dom.hasAttribute('data-table-reordering')) {
      this.hide();
      return;
    }

    if (this.isEdgeControlTarget(eventTarget)) return;

    const target = getEdgeTarget(this.view, eventTarget);
    if (!target) {
      this.hide();
      return;
    }

    // Keep controls in the table's scrollable rail. Their coordinates then move
    // and clip with the table, rather than sticking to the pane's outer edge.
    const root = target.rail;
    if (root !== this.overlayRoot) {
      this.hide();
      this.overlayRoot = root;
      root.append(this.columnHoverZone, this.rowHoverZone, this.columnButton, this.rowButton);
    }
    if (target.atLastColumn) this.showColumnButton(target);
    else this.hideColumnButton();
    if (target.atLastRow) this.showRowButton(target);
    else this.hideRowButton();
  }

  private showColumnButton(target: EdgeTarget): void {
    this.cancelScheduledHide();
    // offset geometry is in rail-local CSS pixels. Viewport rect differences
    // would double-apply transforms/zoom when assigned to absolute CSS offsets.
    const top = target.table.offsetTop;
    const right = target.table.offsetLeft + target.table.offsetWidth;

    this.currentColumnCellPos = target.cellPos;
    this.columnHoverZone.hidden = false;
    setBox(this.columnHoverZone, {
      top,
      left: right,
      width: EDGE_GAP,
      height: target.table.offsetHeight,
    });

    this.columnButton.hidden = false;
    setBox(this.columnButton, {
      top,
      left: right + EDGE_GAP,
      width: EDGE_BUTTON_SIZE,
      height: target.table.offsetHeight,
    });
  }

  private showRowButton(target: EdgeTarget): void {
    this.cancelScheduledHide();
    const bottom = target.table.offsetTop + target.table.offsetHeight;
    const left = target.table.offsetLeft;

    this.currentRowCellPos = target.cellPos;
    this.rowHoverZone.hidden = false;
    setBox(this.rowHoverZone, {
      top: bottom,
      left,
      width: target.table.offsetWidth,
      height: EDGE_GAP,
    });

    this.rowButton.hidden = false;
    setBox(this.rowButton, {
      top: bottom + EDGE_GAP,
      left,
      width: target.table.offsetWidth,
      height: EDGE_BUTTON_SIZE,
    });
  }

  private hideColumnButton(): void {
    this.currentColumnCellPos = null;
    this.columnHoverZone.hidden = true;
    this.columnButton.hidden = true;
  }

  private hideRowButton(): void {
    this.currentRowCellPos = null;
    this.rowHoverZone.hidden = true;
    this.rowButton.hidden = true;
  }

  private handleScroll = (): void => {
    // A queued pre-scroll mousemove must not resurrect controls after hiding.
    if (this.frameId !== null) window.cancelAnimationFrame(this.frameId);
    this.frameId = null;
    this.pendingTarget = null;
    this.hide();
  };

  private hide = (): void => {
    this.cancelScheduledHide();
    this.hideColumnButton();
    this.hideRowButton();
  };

  private handleMouseLeave = (event: MouseEvent): void => {
    if (this.isEdgeControlTarget(event.relatedTarget)) return;
    this.scheduleHide();
  };

  private scheduleHide = (): void => {
    this.cancelScheduledHide();
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      this.hide();
    }, 120);
  };

  private cancelScheduledHide = (): void => {
    if (this.hideTimer === null) return;
    window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
  };
}

export function createTableEdgeInsertPlugin(editor: Editor, labels?: TableEdgeInsertLabels): Plugin {
  return new Plugin({
    key: tableEdgeInsertPluginKey,
    view: (view) => new TableEdgeInsertView(view, editor, labels),
  });
}
