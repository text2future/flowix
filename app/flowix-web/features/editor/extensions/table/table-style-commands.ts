import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { isInTable, selectedRect } from '@tiptap/pm/tables';
import { normalizeTableBorderStyle, normalizeTableColumnRole, normalizeTableRowRole, normalizeTableStyleId, type TableBorderStyle, type TableColumnRole, type TableRowRole, type TableStyleId } from './table-presentation';

type BorderAttribute = 'borderTop' | 'borderBottom';

function getSharedBorderEdges(rect: ReturnType<typeof selectedRect>, edge: 'top' | 'bottom') {
  const { map } = rect;
  const selected = new Set(map.cellsInRect(rect));
  const targets = new Map<number, Set<BorderAttribute>>();
  let extendsSelection = false;
  for (const position of selected) {
    const cellRect = map.findCell(position);
    const line = edge === 'top' ? cellRect.top : cellRect.bottom;
    let { left, right } = cellRect;
    let expanded: boolean;
    // A wider merged neighbor joins entire cell edges. Follow that connected
    // span on both sides so an older hidden/double edge cannot mask part of it.
    do {
      const previousLeft = left;
      const previousRight = right;
      for (const row of [line - 1, line]) {
        if (row < 0 || row >= map.height) continue;
        const attribute: BorderAttribute = row < line ? 'borderBottom' : 'borderTop';
        for (let column = left; column < right; column += 1) {
          const neighbor = map.map[row * map.width + column];
          const bounds = map.findCell(neighbor);
          if ((row < line ? bounds.bottom : bounds.top) !== line) continue;
          left = Math.min(left, bounds.left);
          right = Math.max(right, bounds.right);
          const attributes = targets.get(neighbor) ?? new Set<BorderAttribute>();
          attributes.add(attribute);
          targets.set(neighbor, attributes);
          if (attribute === (edge === 'top' ? 'borderTop' : 'borderBottom') && !selected.has(neighbor)) {
            extendsSelection = true;
          }
        }
      }
      expanded = left !== previousLeft || right !== previousRight;
    } while (expanded);
  }
  return { targets, extendsSelection };
}

export function getTablePresentationSelection(editor: Editor) {
  if (editor.isDestroyed) return null;
  if (!isInTable(editor.state)) return null;
  const rect = selectedRect(editor.state);
  const { table, map, top, bottom, left, right } = rect;
  const rowRoles = new Set<TableRowRole>();
  for (let row = top; row < bottom; row += 1) rowRoles.add(normalizeTableRowRole(table.child(row).attrs.role));
  const columnRoles = new Set<TableColumnRole>();
  for (let row = 0; row < map.height; row += 1) {
    for (let column = left; column < right; column += 1) {
      const cell = table.nodeAt(map.map[row * map.width + column]);
      columnRoles.add(normalizeTableColumnRole(cell?.attrs.columnRole));
    }
  }
  const borderTops = new Set<TableBorderStyle>();
  const borderBottoms = new Set<TableBorderStyle>();
  for (const position of map.cellsInRect(rect)) {
    const cell = table.nodeAt(position);
    borderTops.add(normalizeTableBorderStyle(cell?.attrs.borderTop));
    borderBottoms.add(normalizeTableBorderStyle(cell?.attrs.borderBottom));
  }
  return {
    style: normalizeTableStyleId(table.attrs.styleId),
    row: rowRoles.size === 1 ? [...rowRoles][0] : 'mixed',
    column: columnRoles.size === 1 ? [...columnRoles][0] : 'mixed',
    borderTop: borderTops.size === 1 ? [...borderTops][0] : 'mixed',
    borderBottom: borderBottoms.size === 1 ? [...borderBottoms][0] : 'mixed',
    borderTopExtends: getSharedBorderEdges(rect, 'top').extendsSelection,
    borderBottomExtends: getSharedBorderEdges(rect, 'bottom').extendsSelection,
  };
}

/** A horizontal border is shared with the adjoining cell's opposite edge. */
export function setTableCellBorder(editor: Editor, edge: 'top' | 'bottom', style: TableBorderStyle): boolean {
  if (editor.isDestroyed || !editor.isEditable || !isInTable(editor.state)) return false;
  if (normalizeTableBorderStyle(style) !== style) return false;
  return editor.chain().focus().command(({ tr, state }) => {
    const rect = selectedRect(state);
    const { targets } = getSharedBorderEdges(rect, edge);
    closeHistory(tr);
    targets.forEach((attributes, position) => {
      const cell = tr.doc.nodeAt(rect.tableStart + position);
      if (!cell) return;
      const attrs = { ...cell.attrs };
      attributes.forEach(attribute => { attrs[attribute] = style; });
      tr.setNodeMarkup(rect.tableStart + position, undefined, attrs);
    });
    return true;
  }).run();
}

export function setTableStyle(editor: Editor, styleId: TableStyleId): boolean {
  if (!isInTable(editor.state)) return false;
  return editor.chain().focus().command(({ tr, state }) => {
    const { table, tableStart } = selectedRect(state);
    tr.setNodeMarkup(tableStart - 1, undefined, { ...table.attrs, styleId });
    return true;
  }).run();
}

export function setTableRowRole(editor: Editor, role: TableRowRole): boolean {
  if (!isInTable(editor.state)) return false;
  return editor.chain().focus().command(({ tr, state }) => {
    const { table, tableStart, top, bottom } = selectedRect(state);
    table.forEach((row, offset, index) => {
      if (index >= top && index < bottom) {
        tr.setNodeMarkup(tableStart + offset, undefined, { ...row.attrs, role });
      }
    });
    return true;
  }).run();
}

/** Column roles belong to cells, so removing a preceding column cannot shift them. */
export function setTableColumnRole(editor: Editor, columnRole: TableColumnRole): boolean {
  if (!isInTable(editor.state)) return false;
  return editor.chain().focus().command(({ tr, state }) => {
    const { table, tableStart, map, left, right } = selectedRect(state);
    const positions = new Set<number>();
    for (let row = 0; row < map.height; row += 1) {
      for (let column = left; column < right; column += 1) {
        positions.add(map.map[row * map.width + column]);
      }
    }
    positions.forEach((position) => {
      const cell = table.nodeAt(position);
      if (cell) tr.setNodeMarkup(tableStart + position, undefined, { ...cell.attrs, columnRole });
    });
    return true;
  }).run();
}
