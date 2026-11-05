import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import { TableMap } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';
import { isValidTableColumnWidth } from './table-metadata';

export const TABLE_CELL_MIN_WIDTH = 80;

export function equalTableWidths(available: number, columns: number): number[] {
  const total = Math.max(columns * TABLE_CELL_MIN_WIDTH, Math.floor(available));
  return Array.from({ length: columns }, (_, index) =>
    Math.floor(total / columns) + (index < total % columns ? 1 : 0));
}

/** Local content box, including list/blockquote indentation. */
export function tableContentWidth(view: EditorView, position: number): number {
  const root = view.dom;
  const rootStyle = getComputedStyle(root);
  const rootWidth = root.clientWidth
    - (parseFloat(rootStyle.paddingLeft) || 0)
    - (parseFloat(rootStyle.paddingRight) || 0);
  // A hidden editor has no reliable viewport yet. Defer initialization instead
  // of persisting a width inherited from an overflowing descendant.
  if (rootWidth <= 0) return 0;

  const dom = view.domAtPos(position).node;
  let element = dom instanceof HTMLElement ? dom : dom.parentElement;
  while (element && view.dom.contains(element)) {
    const style = getComputedStyle(element);
    const width = element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    if (width > 0) return Math.min(width, rootWidth);
    element = element.parentElement;
  }
  return rootWidth;
}

function normalizeWidths(
  state: EditorState,
  view: EditorView,
  complete: WeakSet<ProseMirrorNode>,
  existedBefore?: (position: number) => boolean,
): Transaction | null {
  if (!view.editable) return null;
  const tr = state.tr;
  state.doc.descendants((table, position, parent) => {
    if (table.type.spec.tableRole !== 'table') return;
    if (complete.has(table)) return false;
    const map = TableMap.get(table);
    const widths: Array<number | undefined> = Array(map.width).fill(undefined);
    // Derive logical columns in one pass, including rowspan/colspan. Repeated
    // TableMap.findCell calls scan the map and become quadratic on large tables.
    const cells = new Map<number, number>();
    map.map.forEach((offset, index) => {
      if (!cells.has(offset)) cells.set(offset, index % map.width);
    });
    for (const [offset, left] of cells) {
      const cell = table.nodeAt(offset)!;
      for (let index = 0; index < cell.attrs.colspan; index++) {
        const width = cell.attrs.colwidth?.[index];
        if (isValidTableColumnWidth(width)) widths[left + index] = width;
      }
    }
    const currentDOM = view.state.doc === state.doc;
    const missing = widths.some(width => width === undefined);
    const hasWidths = widths.some(width => width !== undefined);
    // appendTransaction runs before the view updates: new document positions
    // cannot be read from the previous DOM. Top-level insertions can use the
    // editor's content box; new nested tables wait for the updated local DOM.
    const topLevel = parent === state.doc;
    if (missing && !currentDOM) {
      if (!hasWidths && !topLevel) return false;
      // Inherit for columns inserted into an existing table. A pasted/imported
      // table with partially specified widths must first render at its own size.
      if (hasWidths && !existedBefore?.(position)) return false;
    }
    const tableDOM = missing && currentDOM ? view.nodeDOM(position) : null;
    const rendered = tableDOM instanceof HTMLElement ? tableDOM.querySelector('table') : null;
    const available = missing && (currentDOM || !hasWidths)
      ? tableContentWidth(view, currentDOM ? position : 0)
      : 0;
    const defaults = available > 0 ? equalTableWidths(available, map.width) : null;
    for (let column = 0; column < map.width; column++) {
      if (widths[column] !== undefined) continue;
      if (rendered) {
        const offset = map.map[column];
        const cell = table.nodeAt(offset)!;
        const cellDOM = view.nodeDOM(position + 1 + offset);
        const left = cells.get(offset)!;
        const spanned = widths.slice(left, left + cell.attrs.colspan);
        const unknown = spanned.filter(width => width === undefined).length;
        const known = spanned.reduce<number>((sum, width) => sum + (width ?? 0), 0);
        const measured = cellDOM instanceof HTMLElement && cellDOM.offsetWidth > 0
          ? (cellDOM.offsetWidth - known) / unknown
          : 0;
        const measuredWidth = Math.round(measured);
        if (isValidTableColumnWidth(measuredWidth)) widths[column] = Math.max(TABLE_CELL_MIN_WIDTH, measuredWidth);
      }
      if (hasWidths && (!currentDOM || available > 0)) {
        widths[column] ??= widths.slice(0, column).reverse().find(Boolean) ?? widths.slice(column + 1).find(Boolean);
      }
      widths[column] ??= defaults?.[column];
    }
    if (widths.some(width => width === undefined)) return false;
    for (const [offset, left] of cells) {
      const cell = table.nodeAt(offset)!;
      const colwidth = widths.slice(left, left + cell.attrs.colspan);
      if (JSON.stringify(cell.attrs.colwidth) !== JSON.stringify(colwidth)) {
        tr.setNodeMarkup(position + 1 + offset, undefined, { ...cell.attrs, colwidth });
      }
    }
    complete.add(tr.doc.nodeAt(position)!);
    return false;
  });
  return tr.docChanged ? tr : null;
}

/** Persist missing widths once; viewport changes never rewrite existing widths. */
export function createTableFixedWidthsPlugin() {
  let view: EditorView | undefined;
  const complete = new WeakSet<ProseMirrorNode>();
  let origin: ProseMirrorNode | undefined;
  let mapping = new Mapping();
  return new Plugin({
    key: new PluginKey('tableFixedWidths'),
    appendTransaction(transactions, _old, state) {
      if (!view || !transactions.some(tr => tr.docChanged)) return null;
      // tableEditing may append structural repairs in a second round. Compare
      // against the pre-update view across all rounds, not the intermediate
      // imported table, or a repair looks like an inserted column.
      if (origin !== view.state.doc) {
        origin = view.state.doc;
        mapping = new Mapping();
      }
      for (const transaction of transactions) mapping.appendMapping(transaction.mapping);
      const inverse = mapping.invert();
      const before = origin;
      return normalizeWidths(state, view, complete, position => {
        const previous = inverse.mapResult(position, 1);
        return !previous.deleted && before.nodeAt(previous.pos)?.type.spec.tableRole === 'table';
      });
    },
    view(editorView) {
      view = editorView;
      let frame = 0;
      const schedule = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          const tr = normalizeWidths(editorView.state, editorView, complete);
          if (tr) editorView.dispatch(tr.setMeta('addToHistory', false));
        });
      };
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
      observer?.observe(editorView.dom);
      schedule();
      return {
        update: schedule,
        destroy() { cancelAnimationFrame(frame); observer?.disconnect(); view = undefined; },
      };
    },
  });
}
