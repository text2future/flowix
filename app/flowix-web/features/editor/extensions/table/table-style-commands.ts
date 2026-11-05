import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { DEFAULT_APP_LANGUAGE, type AppLanguage } from '@/lib/i18n/locales';
import { createTableTemplate, TABLE_TEMPLATE_OPTIONS } from './table-templates';
import { closeHistory } from '@tiptap/pm/history';
import { isInTable, selectedRect } from '@tiptap/pm/tables';
import { tableHeaderModesFromTable } from './table-header-modes';
import { TABLE_STYLE_REQUIRES_HEADER_ROW, normalizeTableBorderStyle, normalizeTableColumnRole, normalizeTableRowRole, normalizeTableStyleId, type TableBorderStyle, type TableColumnRole, type TableRowRole, type TableStyleId } from './table-presentation';

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
  const { table, top, bottom } = rect;
  const { rowHeader, columnHeader } = tableHeaderModesFromTable(table);
  const style = normalizeTableStyleId(table.attrs.styleId);
  const headerRowLocked = rowHeader && TABLE_STYLE_REQUIRES_HEADER_ROW[style];
  const rowRoles = new Set<TableRowRole>();
  for (let row = top; row < bottom; row += 1) rowRoles.add(normalizeTableRowRole(table.child(row).attrs.role));

  // Aggregate everything the toolbar shows in one pass over the selected cells.
  // Column roles used to scan every row of the table on each transaction.
  const columnRoles = new Set<TableColumnRole>();
  const borderTops = new Set<TableBorderStyle>();
  const borderBottoms = new Set<TableBorderStyle>();
  for (const position of rect.map.cellsInRect(rect)) {
    const cell = table.nodeAt(position);
    columnRoles.add(normalizeTableColumnRole(cell?.attrs.columnRole));
    borderTops.add(normalizeTableBorderStyle(cell?.attrs.borderTop));
    borderBottoms.add(normalizeTableBorderStyle(cell?.attrs.borderBottom));
  }

  return {
    rowHeader,
    columnHeader,
    headerRowLocked,
    canToggleHeaderRow: editor.isEditable && !headerRowLocked && editor.can().toggleHeaderRow(),
    canToggleHeaderColumn: editor.isEditable && editor.can().toggleHeaderColumn(),
    style,
    row: rowRoles.size === 1 ? [...rowRoles][0] : 'mixed',
    column: columnRoles.size === 1 ? [...columnRoles][0] : 'mixed',
    borderTop: borderTops.size === 1 ? [...borderTops][0] : 'mixed',
    borderBottom: borderBottoms.size === 1 ? [...borderBottoms][0] : 'mixed',
  };
}

/**
 * Whether an edge edit would reach cells outside the selection.
 *
 * Only the border menu's notice uses this, and its walk is superlinear in the
 * selected cell count (measured ~4 ms for a whole 200x8 table). Computing it
 * inside the menu, which mounts on open, keeps it off the per-transaction path.
 */
export function getBorderExtendsHint(editor: Editor, edge: 'top' | 'bottom'): boolean {
  if (editor.isDestroyed || !isInTable(editor.state)) return false;
  return getSharedBorderEdges(selectedRect(editor.state), edge).extendsSelection;
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

export function setTableStyle(editor: Editor, styleId: TableStyleId, language: AppLanguage = DEFAULT_APP_LANGUAGE): boolean {
  if (editor.isDestroyed || !editor.isEditable || !isInTable(editor.state)) return false;
  if (normalizeTableStyleId(styleId) !== styleId) return false;
  return editor.chain().focus().command(({ tr, state }) => {
    const { table, tableStart, left } = selectedRect(state);
    if (TABLE_TEMPLATE_OPTIONS.find(option => option.styleId === styleId)?.hasContent) {
      // Only empty paragraphs are blank; media, references and other nodes are content.
      let empty = true;
      table.descendants(node => {
        if (!['tableRow', 'tableCell', 'tableHeader', 'paragraph'].includes(node.type.name)) empty = false;
        return empty;
      });
      if (empty) {
        const template = editor.schema.nodeFromJSON(createTableTemplate(styleId, language));
        closeHistory(tr);
        tr.replaceWith(tableStart - 1, tableStart - 1 + table.nodeSize, template);
        let blankPosition: number | undefined;
        template.descendants((node, position) => {
          if (blankPosition === undefined && node.isTextblock && node.content.size === 0) blankPosition = position + 1;
        });
        tr.setSelection(TextSelection.near(tr.doc.resolve(tableStart + (blankPosition ?? 0))));
        tr.scrollIntoView();
        return true;
      }
    }
    tr.setNodeMarkup(tableStart - 1, undefined, {
      ...table.attrs, styleId,
      ...(styleId === 'comparison' ? { comparisonColumn: left } : {}),
    });
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
