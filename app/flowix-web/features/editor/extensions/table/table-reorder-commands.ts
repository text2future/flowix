import type { Node as PMNode } from '@tiptap/pm/model';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';
import { tableHeaderModesFromTable } from './table-header-modes';
import { resolveComparisonColumn } from './table-presentation';

export type Axis = 'row' | 'column';

const reorderableTables = new WeakMap<PMNode, boolean>();

export function canReorderTable(table: PMNode): boolean {
  const cached = reorderableTables.get(table);
  if (cached !== undefined) return cached;
  let simple = !TableMap.get(table).problems?.length;
  table.forEach(row => row.forEach(cell => {
    if (cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1) simple = false;
  }));
  reorderableTables.set(table, simple);
  return simple;
}

/** One transaction retains row attributes, cell content/widths and undo history. */
export function reorderTable(view: EditorView, pos: number, axis: Axis, from: number, to: number): boolean {
  if (!Number.isSafeInteger(pos) || pos < 0 || pos >= view.state.doc.content.size) return false;
  const table = view.state.doc.nodeAt(pos);
  if (!view.editable || table?.type.spec.tableRole !== 'table' || !canReorderTable(table)) return false;
  const map = TableMap.get(table);
  const count = axis === 'row' ? map.height : map.width;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from === to || Math.min(from, to) < 0 || Math.max(from, to) >= count) return false;
  const order = Array.from({ length: count }, (_, i) => i);
  order.splice(to, 0, order.splice(from, 1)[0]);
  const modes = tableHeaderModesFromTable(table);
  const rows: PMNode[] = [];
  for (let r = 0; r < map.height; r++) {
    const source = table.child(axis === 'row' ? order[r] : r);
    const cells: PMNode[] = [];
    for (let c = 0; c < map.width; c++) {
      const cell = source.child(axis === 'column' ? order[c] : c);
      const header = (modes.rowHeader && r === 0) || (modes.columnHeader && c === 0);
      const type = header ? view.state.schema.nodes.tableHeader : view.state.schema.nodes.tableCell;
      cells.push(cell.type === type ? cell : type.create(cell.attrs, cell.content, cell.marks));
    }
    rows.push(source.type.create(source.attrs, cells, source.marks));
  }
  const attrs = { ...table.attrs };
  if (axis === 'column' && attrs.styleId === 'comparison') {
    const highlighted = resolveComparisonColumn(attrs.comparisonColumn, map.width);
    if (highlighted !== null) attrs.comparisonColumn = order.indexOf(highlighted);
  }
  const next = table.type.create(attrs, rows, table.marks);
  const tr = view.state.tr.replaceWith(pos, pos + table.nodeSize, next);
  tr.setSelection(tableAxisSelection(tr.doc, next, pos, axis, to));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** All callers use the same logical endpoints for selecting one row/column. */
export function tableAxisSelection(doc: PMNode, table: PMNode, pos: number, axis: Axis, index: number): CellSelection {
  const map = TableMap.get(table);
  const start = pos + 1;
  const first = start + map.map[axis === 'row' ? index * map.width : index];
  const last = start + map.map[axis === 'row' ? (index + 1) * map.width - 1 : (map.height - 1) * map.width + index];
  return CellSelection.create(doc, first, last);
}
