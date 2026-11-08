import { Plugin, PluginKey } from '@tiptap/pm/state';
import { columnResizingPluginKey, TableMap } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';

/** A fast sweep across a table crosses many column edges; the line may only
 * appear once the pointer rests on one edge, not while it is passing through. */
export const TABLE_RESIZE_HINT_DELAY_MS = 300;

export interface TableResizeIndicatorOptions {
  /** Dwell time before the hover line appears; <= 0 shows it immediately. */
  delayMs?: number;
}

/** Draw one continuous rail-local line, rather than one segment per cell.
 * Upstream widgets remain in the DOM, but only the resize plugin owns input. */
export function createTableResizeIndicatorPlugin({
  delayMs = TABLE_RESIZE_HINT_DELAY_MS,
}: TableResizeIndicatorOptions = {}): Plugin {
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
      // Dwell gate. `handle` is the edge the pointer is on; `shown` says whether
      // that edge has been held long enough to draw the line.
      let hintHandle = -1;
      let hintShown = false;
      let hintTimer: number | null = null;

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
      const cancelHint = () => {
        if (hintTimer !== null) {
          ownerWindow.clearTimeout(hintTimer);
          hintTimer = null;
        }
        hintHandle = -1;
        hintShown = false;
      };
      const armHint = (handle: number) => {
        cancelHint();
        hintHandle = handle;
        if (delayMs <= 0) {
          hintShown = true;
          return;
        }
        hintTimer = ownerWindow.setTimeout(() => {
          hintTimer = null;
          if (destroyed) return;
          hintShown = true;
          sync();
        }, delayMs);
      };
      const settleHint = (resize: NonNullable<ReturnType<typeof columnResizingPluginKey.getState>>) => {
        if (resize.dragging) {
          // An active drag is deliberate: the edge follows the pointer at once.
          if (hintTimer !== null) {
            ownerWindow.clearTimeout(hintTimer);
            hintTimer = null;
          }
          hintHandle = resize.activeHandle;
          hintShown = true;
          return;
        }
        if (hintHandle !== resize.activeHandle) armHint(resize.activeHandle);
      };
      const sync = () => {
        if (destroyed) return;
        const resize = columnResizingPluginKey.getState(view.state);
        if (!view.editable || !resize || resize.activeHandle < 0 || view.dom.hasAttribute('data-table-reordering')) {
          cancelHint();
          hide();
          return;
        }
        const $cell = view.state.doc.resolve(resize.activeHandle);
        const tableNode = $cell.node(-1);
        if (tableNode.type.spec.tableRole !== 'table') { cancelHint(); hide(); return; }
        const dom = view.nodeDOM($cell.before($cell.depth - 1));
        const nextTable = dom instanceof HTMLElement ? dom.querySelector('table') : null;
        const nextCell = view.nodeDOM(resize.activeHandle);
        const rail = nextTable?.parentElement;
        if (!(nextTable instanceof HTMLTableElement) || !(nextCell instanceof HTMLElement)
          || !rail?.classList.contains('markdown-table-rail')) { cancelHint(); hide(); return; }

        settleHint(resize);
        if (!hintShown) { hide(); return; }

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
          if (hintTimer !== null) ownerWindow.clearTimeout(hintTimer);
          hintTimer = null;
          hintHandle = -1;
          hintShown = false;
          line.remove();
        },
      };
    },
  });
}
