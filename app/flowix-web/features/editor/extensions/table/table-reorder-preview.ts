import type { Axis } from './table-reorder-commands';

/** The portal lives outside editor CSS: snapshot typography and block spacing. */
function clonePreviewContent(source: HTMLElement, target: HTMLElement): void {
  const style = getComputedStyle(source);
  for (const property of [
    'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
    'letter-spacing', 'text-align', 'text-transform', 'text-decoration',
    'white-space', 'overflow-wrap', 'word-break', 'color',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'background-color', 'background-image',
  ]) target.style.setProperty(property, style.getPropertyValue(property));
  for (const child of Array.from(source.childNodes)) {
    if (child instanceof HTMLElement && child.matches('.column-resize-handle, .table-edge-insert-button, .table-reorder-handle')) continue;
    const clone = child.cloneNode(false);
    if (child instanceof HTMLElement && clone instanceof HTMLElement) {
      clone.removeAttribute('id');
      clone.removeAttribute('contenteditable');
      clonePreviewContent(child, clone);
      if (child.matches('img, video, canvas')) {
        const rect = child.getBoundingClientRect();
        clone.style.width = `${rect.width}px`;
        clone.style.height = `${rect.height}px`;
      }
    } else if (child instanceof Element) {
      // SVG/math descendants keep their existing markup and attributes.
      target.append(child.cloneNode(true));
      continue;
    }
    target.append(clone);
  }
}

/** A body portal owns its DOM, visual snapshot and pointer anchoring. */
export class TableReorderPreview {
  private readonly dom: HTMLDivElement;

  constructor(private readonly doc: Document) {
    this.dom = doc.createElement('div');
    this.dom.className = 'table-reorder-preview';
    this.dom.hidden = true;
    this.dom.inert = true;
    this.dom.setAttribute('aria-hidden', 'true');
    doc.body.append(this.dom);
  }

  show(source: HTMLElement, table: HTMLTableElement, axis: Axis, index: number, event: { clientX: number; clientY: number }): void {
    if (this.dom.hidden) {
      const style = getComputedStyle(source);
      for (const token of ['--brand', '--info', '--background', '--document-bg', '--foreground', '--border', '--editor-table-selection-bg']) {
        this.dom.style.setProperty(token, style.getPropertyValue(token));
      }
      this.dom.style.font = style.font;
      this.dom.style.lineHeight = style.lineHeight;
      const cells = axis === 'row'
        ? Array.from(table.rows[index].cells)
        : Array.from(table.rows, row => row.cells[index]).filter((cell): cell is HTMLTableCellElement => Boolean(cell));
      const boxes = cells.map(cell => cell.getBoundingClientRect());
      const width = axis === 'row'
        ? boxes.reduce((sum, box) => sum + box.width, 0)
        : Math.max(0, ...boxes.map(box => box.width));
      const height = axis === 'row'
        ? Math.max(0, ...boxes.map(box => box.height))
        : boxes.reduce((sum, box) => sum + box.height, 0);

      this.dom.className = `table-reorder-preview table-reorder-preview--${axis}`;
      const content = this.doc.createElement('div');
      content.className = 'table-reorder-preview-content';
      content.replaceChildren(...cells.map((cell, index) => {
        const item = this.doc.createElement('div');
        item.className = 'table-reorder-preview-cell';
        clonePreviewContent(cell, item);
        item.style.width = `${boxes[index].width}px`;
        item.style.height = `${boxes[index].height}px`;
        return item;
      }));
      this.dom.replaceChildren(content);
      this.dom.style.width = `${width}px`;
      this.dom.style.height = `${height}px`;
      this.dom.hidden = false;
    }
    this.dom.style.left = `${axis === 'row' ? event.clientX : event.clientX - this.dom.offsetWidth / 2}px`;
    this.dom.style.top = `${axis === 'row' ? event.clientY - this.dom.offsetHeight / 2 : event.clientY}px`;
  }

  hide(): void {
    this.dom.hidden = true;
    // Release cloned links/media immediately, rather than retaining a hidden
    // copy of the last dragged content for the editor's entire lifetime.
    this.dom.replaceChildren();
  }

  destroy(): void {
    this.dom.remove();
  }
}
