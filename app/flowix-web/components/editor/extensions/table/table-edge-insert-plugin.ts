import type { Editor } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

type EdgeKind = 'column' | 'row';

interface EdgeTarget {
  cellPos: number;
  atLastColumn: boolean;
  atLastRow: boolean;
  table: HTMLTableElement;
  wrapper: HTMLElement;
}

const tableEdgeInsertPluginKey = new PluginKey('tableEdgeInsert');
const EDGE_BUTTON_SIZE = 14;
const EDGE_GAP = 2;

function closestTableCell(target: EventTarget | null): HTMLTableCellElement | null {
  if (!(target instanceof Element)) return null;
  const cell = target.closest('td, th');
  return cell instanceof HTMLTableCellElement ? cell : null;
}

function getEdgeTarget(view: EditorView, eventTarget: EventTarget | null): EdgeTarget | null {
  const cell = closestTableCell(eventTarget);
  const table = cell?.closest('table');
  if (!cell || !(table instanceof HTMLTableElement)) return null;

  const row = cell.parentElement;
  if (!(row instanceof HTMLTableRowElement)) return null;

  const cells = Array.from(row.cells);
  const rows = Array.from(table.rows);
  const atLastColumn = cells[cells.length - 1] === cell;
  const atLastRow = rows[rows.length - 1] === row;

  if (!atLastColumn && !atLastRow) return null;

  const wrapper = table.closest('.tableWrapper');

  return {
    cellPos: view.posAtDOM(cell, 0),
    atLastColumn,
    atLastRow,
    table,
    wrapper: wrapper instanceof HTMLElement ? wrapper : table,
  };
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
  private overlayRoot: HTMLElement;
  private hideTimer: number | null = null;

  constructor(
    private view: EditorView,
    private editor: Editor,
  ) {
    this.hoverArea = this.findHoverArea();
    this.overlayRoot = this.findOverlayRoot();
    this.columnButton = this.createButton('column', 'Insert column after');
    this.rowButton = this.createButton('row', 'Insert row after');
    this.columnHoverZone = this.createHoverZone('column');
    this.rowHoverZone = this.createHoverZone('row');

    this.overlayRoot.append(
      this.columnHoverZone,
      this.rowHoverZone,
      this.columnButton,
      this.rowButton,
    );
    this.hoverArea.addEventListener('mousemove', this.handleMouseMove);
    this.hoverArea.addEventListener('mouseleave', this.handleMouseLeave);
    this.hoverArea.addEventListener('scroll', this.hide, { passive: true });
  }

  update(view: EditorView): void {
    this.view = view;
    if (!this.editor.isEditable) this.hide();
  }

  destroy(): void {
    this.hoverArea.removeEventListener('mousemove', this.handleMouseMove);
    this.hoverArea.removeEventListener('mouseleave', this.handleMouseLeave);
    this.hoverArea.removeEventListener('scroll', this.hide);
    this.columnButton.remove();
    this.rowButton.remove();
    this.columnHoverZone.remove();
    this.rowHoverZone.remove();
  }

  private findHoverArea(): HTMLElement {
    const parent = this.view.dom.parentElement;
    return parent instanceof HTMLElement ? parent : this.view.dom;
  }

  private findOverlayRoot(): HTMLElement {
    const editorRoot = this.view.dom.closest('.markdown-editor');
    return editorRoot instanceof HTMLElement ? editorRoot : this.findHoverArea();
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
    if (!this.editor.isEditable) {
      this.hide();
      return;
    }

    if (this.isEdgeControlTarget(event.target)) return;

    const target = getEdgeTarget(this.view, event.target);
    if (!target) {
      this.hide();
      return;
    }

    if (target.atLastColumn) {
      this.showColumnButton(target);
    } else {
      this.hideColumnButton();
    }

    if (target.atLastRow) {
      this.showRowButton(target);
    } else {
      this.hideRowButton();
    }
  };

  private showColumnButton(target: EdgeTarget): void {
    this.cancelScheduledHide();
    const rootRect = this.overlayRoot.getBoundingClientRect();
    const tableRect = target.table.getBoundingClientRect();
    const wrapperRect = target.wrapper.getBoundingClientRect();
    const top = tableRect.top - rootRect.top;
    const right = wrapperRect.right - rootRect.left;

    this.currentColumnCellPos = target.cellPos;
    this.columnHoverZone.hidden = false;
    setBox(this.columnHoverZone, {
      top,
      left: right,
      width: EDGE_GAP,
      height: tableRect.height,
    });

    this.columnButton.hidden = false;
    setBox(this.columnButton, {
      top,
      left: right + EDGE_GAP,
      width: EDGE_BUTTON_SIZE,
      height: tableRect.height,
    });
  }

  private showRowButton(target: EdgeTarget): void {
    this.cancelScheduledHide();
    const rootRect = this.overlayRoot.getBoundingClientRect();
    const wrapperRect = target.wrapper.getBoundingClientRect();
    const bottom = wrapperRect.bottom - rootRect.top;
    const left = wrapperRect.left - rootRect.left;

    this.currentRowCellPos = target.cellPos;
    this.rowHoverZone.hidden = false;
    setBox(this.rowHoverZone, {
      top: bottom,
      left,
      width: wrapperRect.width,
      height: EDGE_GAP,
    });

    this.rowButton.hidden = false;
    setBox(this.rowButton, {
      top: bottom + EDGE_GAP,
      left,
      width: wrapperRect.width,
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

export function createTableEdgeInsertPlugin(editor: Editor): Plugin {
  return new Plugin({
    key: tableEdgeInsertPluginKey,
    view: (view) => new TableEdgeInsertView(view, editor),
  });
}
