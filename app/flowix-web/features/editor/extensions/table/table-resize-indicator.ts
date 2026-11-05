import { Plugin, PluginKey } from '@tiptap/pm/state';
import { columnResizingPluginKey, TableMap } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';

/** Draw one continuous rail-local line, rather than one segment per cell.
 * Upstream widgets remain in the DOM, but only the resize plugin owns input. */
export function createTableResizeIndicatorPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('tableResizeIndicator'),
    view(initialView) {
      let view = initialView;
      const ownerWindow = view.dom.ownerDocument.defaultView ?? window;
      const line = view.dom.ownerDocument.createElement('div');
      line.className = 'table-resize-indicator';
      line.setAttribute('aria-hidden', 'true');
      line.hidden = true;
      let table: HTMLTableElement | null = null;
      let cell: HTMLElement | null = null;
      let frame: number | null = null;
      let destroyed = false;

      const schedule = () => {
        if (!destroyed && frame === null) frame = ownerWindow.requestAnimationFrame(() => {
          frame = null;
          sync();
        });
      };
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
      const observe = (nextTable: HTMLTableElement | null, nextCell: HTMLElement | null) => {
        if (table === nextTable && cell === nextCell) return;
        observer?.disconnect();
        table = nextTable;
        cell = nextCell;
        if (table) observer?.observe(table);
        if (cell) observer?.observe(cell);
      };
      const hide = () => {
        line.hidden = true;
        observe(null, null);
      };
      const sync = () => {
        if (destroyed) return;
        const resize = columnResizingPluginKey.getState(view.state);
        if (!view.editable || !resize || resize.activeHandle < 0 || view.dom.hasAttribute('data-table-reordering')) {
          hide();
          return;
        }
        const $cell = view.state.doc.resolve(resize.activeHandle);
        const tableNode = $cell.node(-1);
        if (tableNode.type.spec.tableRole !== 'table') { hide(); return; }
        const dom = view.nodeDOM($cell.before($cell.depth - 1));
        const nextTable = dom instanceof HTMLElement ? dom.querySelector('table') : null;
        const nextCell = view.nodeDOM(resize.activeHandle);
        const rail = nextTable?.parentElement;
        if (!(nextTable instanceof HTMLTableElement) || !(nextCell instanceof HTMLElement)
          || !rail?.classList.contains('markdown-table-rail')) { hide(); return; }

        observe(nextTable, nextCell);
        const tableRect = nextTable.getBoundingClientRect();
        const cellRect = nextCell.getBoundingClientRect();
        const railRect = rail.getBoundingClientRect();
        const scaleX = (rail.offsetWidth ? railRect.width / rail.offsetWidth : 1) || 1;
        const scaleY = (rail.offsetHeight ? railRect.height / rail.offsetHeight : 1) || 1;
        const map = TableMap.get(tableNode);
        const bounds = map.findCell(resize.activeHandle - $cell.start($cell.depth - 1));
        // Keep the last-column indicator inside the outer edge, so it cannot
        // be clipped by the scroll viewport. Interior edges are centered.
        const inset = bounds.right === map.width ? 2 : 1;
        line.style.left = `${(cellRect.right - railRect.left) / scaleX - inset}px`;
        line.style.top = `${(tableRect.top - railRect.top) / scaleY}px`;
        line.style.height = `${tableRect.height / scaleY}px`;
        if (line.parentElement !== rail) rail.append(line);
        line.hidden = false;
      };

      sync();
      return {
        update(nextView: EditorView) { view = nextView; sync(); },
        destroy() {
          destroyed = true;
          if (frame !== null) ownerWindow.cancelAnimationFrame(frame);
          observer?.disconnect();
          line.remove();
        },
      };
    },
  });
}
