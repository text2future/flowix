import type { JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * Which header modes a table currently uses.
 *
 * Markdown's first row is always a header row, so "no header row" is encoded
 * as a synthetic empty header line. Two call sites need this decision on two
 * different shapes (JSON while rendering Markdown, ProseMirror nodes while
 * driving the toolbar). The decision itself lives here once: the previous
 * pair of implementations had already drifted in how they read the first cell.
 */
export interface TableHeaderModes {
  rowHeader: boolean;
  columnHeader: boolean;
}

const NO_HEADERS: TableHeaderModes = { rowHeader: false, columnHeader: false };

/**
 * @param rowCount physical rows
 * @param columnCount cells in the first row; spanning cells are not expanded
 *   because both Markdown and the toolbar treat the first row literally
 */
export function tableHeaderModes(
  rowCount: number,
  columnCount: number,
  isHeaderCell: (row: number, column: number) => boolean,
): TableHeaderModes {
  if (rowCount === 0 || columnCount === 0) return NO_HEADERS;

  // A column header means every row starts with a header cell. A single-row or
  // single-column table cannot express it (Markdown would have no body row).
  let columnHeader = columnCount > 1 && rowCount > 1;
  for (let row = 0; row < rowCount && columnHeader; row += 1) {
    columnHeader = isHeaderCell(row, 0);
  }

  let rowHeader = false;
  for (let column = 0; column < columnCount; column += 1) {
    if (isHeaderCell(0, column) && (column > 0 || !columnHeader)) {
      rowHeader = true;
      break;
    }
  }

  return { rowHeader, columnHeader };
}

export function tableHeaderModesFromJSON(node: JSONContent): TableHeaderModes {
  const rows = (node.content ?? []).filter(row => row.type === 'tableRow' && Array.isArray(row.content));
  const firstRow = rows[0]?.content ?? [];
  return tableHeaderModes(
    rows.length,
    firstRow.length,
    (row, column) => rows[row]?.content?.[column]?.type === 'tableHeader',
  );
}

export function tableHeaderModesFromTable(table: ProseMirrorNode): TableHeaderModes {
  return tableHeaderModes(
    table.childCount,
    table.firstChild?.childCount ?? 0,
    (row, column) => table.child(row).child(column).type.name === 'tableHeader',
  );
}
