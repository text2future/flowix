import { Extension, type JSONContent } from '@tiptap/core';

export const TABLE_STYLE_IDS = [
  'default', 'striped', 'business-blue', 'comparison', 'financial-brief',
  'hk-financial', 'three-line', 'minimal', 'literature', 'grouped',
] as const;
export const TABLE_ROW_ROLES = ['body', 'group', 'subtotal', 'total'] as const;
export const TABLE_COLUMN_ROLES = ['default', 'label', 'note', 'amount'] as const;
export const TABLE_BORDER_STYLES = ['auto', 'none', 'single', 'double'] as const;

export type TableStyleId = typeof TABLE_STYLE_IDS[number];
export type TableRowRole = typeof TABLE_ROW_ROLES[number];
export type TableColumnRole = typeof TABLE_COLUMN_ROLES[number];
export type TableBorderStyle = typeof TABLE_BORDER_STYLES[number];

/** These themes lose their defining header band or structural rules without a header row.
 * Column roles (label/amount/note) do not require first-column header cells. */
export const TABLE_STYLE_REQUIRES_HEADER_ROW: Record<TableStyleId, boolean> = {
  default: false,
  'business-blue': true,
  striped: false,
  comparison: false,
  'financial-brief': true,
  'hk-financial': true,
  'three-line': true,
  grouped: true,
  minimal: false,
  literature: false,
};

export function normalizeTableStyleId(value: unknown): TableStyleId {
  return TABLE_STYLE_IDS.find(style => style === value) ?? 'default';
}

export function normalizeTableRowRole(value: unknown): TableRowRole {
  return TABLE_ROW_ROLES.find(role => role === value) ?? 'body';
}

export function normalizeTableColumnRole(value: unknown): TableColumnRole {
  return TABLE_COLUMN_ROLES.find(role => role === value) ?? 'default';
}

export function normalizeTableBorderStyle(value: unknown): TableBorderStyle {
  return TABLE_BORDER_STYLES.find(style => style === value) ?? 'auto';
}

export function normalizeComparisonColumn(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function presentationAttribute<T extends string>(
  name: string,
  htmlName: string,
  fallback: T,
  normalize: (value: unknown) => T,
) {
  return {
    default: fallback,
    parseHTML: (element: HTMLElement) => normalize(element.getAttribute(htmlName)),
    renderHTML: (attributes: Record<string, unknown>) => {
      const value = normalize(attributes[name]);
      return value === fallback ? {} : { [htmlName]: value };
    },
  };
}

/** Shared by the interactive editor and the worker's HTML/Markdown schema. */
export const TablePresentation = Extension.create({
  name: 'tablePresentation',
  addGlobalAttributes() {
    return [
      {
        types: ['table'],
        attributes: {
          styleId: presentationAttribute('styleId', 'data-flowix-table-style', 'default', normalizeTableStyleId),
          comparisonColumn: {
            default: null,
            parseHTML: (element: HTMLElement) => {
              const raw = element.getAttribute('data-flowix-emphasis-column');
              return raw === null || !/^\d+$/.test(raw) ? null : normalizeComparisonColumn(Number(raw));
            },
            renderHTML: (attrs: Record<string, unknown>) => {
              const column = normalizeComparisonColumn(attrs.comparisonColumn);
              return column === null ? {} : { 'data-flowix-emphasis-column': String(column) };
            },
          },
        },
      },
      {
        types: ['tableRow'],
        attributes: {
          role: presentationAttribute('role', 'data-flowix-row-role', 'body', normalizeTableRowRole),
        },
      },
      {
        types: ['tableCell', 'tableHeader'],
        attributes: {
          columnRole: presentationAttribute('columnRole', 'data-flowix-column-role', 'default', normalizeTableColumnRole),
          borderTop: presentationAttribute('borderTop', 'data-flowix-border-top', 'auto', normalizeTableBorderStyle),
          borderBottom: presentationAttribute('borderBottom', 'data-flowix-border-bottom', 'auto', normalizeTableBorderStyle),
        },
      },
    ];
  },
});

/** `[row, column, top, bottom]`; null means "template default". */
export type TableBorderEntry = [number, number, TableBorderStyle | null, TableBorderStyle | null];

export interface TablePresentationMetadata {
  styleId?: TableStyleId;
  comparisonColumn?: number;
  rows?: TableRowRole[];
  /**
   * One role per column. Columns are how users think about `label/amount/note`
   * roles, and a per-column array is a fraction of the size of a full cell
   * matrix (about 3 bytes per cell saved on a 12x6 table).
   */
  columnRoles?: TableColumnRole[];
  /** Legacy dense matrix; still read so roles written by older builds survive. */
  cells?: TableColumnRole[][];
  /** Sparse border overrides. Empty cells are omitted instead of stored as null. */
  borderList?: TableBorderEntry[];
  /** Legacy dense border matrix; still read so borders written by older builds survive. */
  borders?: Array<Array<{ top?: TableBorderStyle; bottom?: TableBorderStyle } | null>>;
}

function cellBorderMetadata(top: unknown, bottom: unknown): { top?: TableBorderStyle; bottom?: TableBorderStyle } | null {
  const normalizedTop = normalizeTableBorderStyle(top);
  const normalizedBottom = normalizeTableBorderStyle(bottom);
  if (normalizedTop === 'auto' && normalizedBottom === 'auto') return null;
  return {
    ...(normalizedTop === 'auto' ? {} : { top: normalizedTop }),
    ...(normalizedBottom === 'auto' ? {} : { bottom: normalizedBottom }),
  };
}

function parseColumnRoles(value: unknown): TableColumnRole[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map(normalizeTableColumnRole);
}

function parseBorderList(value: unknown): TableBorderEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const entries: TableBorderEntry[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 4) continue;
    const [row, column, rawTop, rawBottom] = entry;
    if (typeof row !== 'number' || !Number.isSafeInteger(row) || row < 0) continue;
    if (typeof column !== 'number' || !Number.isSafeInteger(column) || column < 0) continue;
    const top = rawTop == null ? null : normalizeTableBorderStyle(rawTop);
    const bottom = rawBottom == null ? null : normalizeTableBorderStyle(rawBottom);
    if ((top === null || top === 'auto') && (bottom === null || bottom === 'auto')) continue;
    entries.push([row, column, top === 'auto' ? null : top, bottom === 'auto' ? null : bottom]);
  }
  return entries.length ? entries : undefined;
}

export function parseTablePresentationMetadata(value: unknown): TablePresentationMetadata {
  if (!value || typeof value !== 'object') return {};
  const metadata: TablePresentationMetadata = {};
  if ('styleId' in value) metadata.styleId = normalizeTableStyleId(value.styleId);
  if ('comparisonColumn' in value) {
    const column = normalizeComparisonColumn(value.comparisonColumn);
    if (column !== null) metadata.comparisonColumn = column;
  }
  if ('rows' in value && Array.isArray(value.rows)) {
    metadata.rows = value.rows.map(normalizeTableRowRole);
  }
  const columnRoles = parseColumnRoles((value as { columnRoles?: unknown }).columnRoles);
  if (columnRoles) metadata.columnRoles = columnRoles;
  else if ('cells' in value && Array.isArray(value.cells)) {
    metadata.cells = value.cells.map(row => Array.isArray(row) ? row.map(normalizeTableColumnRole) : []);
  }
  const borderList = parseBorderList((value as { borderList?: unknown }).borderList);
  if (borderList) metadata.borderList = borderList;
  else if ('borders' in value && Array.isArray(value.borders)) {
    const borders = value.borders.map(row => Array.isArray(row) ? row.map(cell => (
      cell && typeof cell === 'object' && !Array.isArray(cell)
        ? cellBorderMetadata(cell.top, cell.bottom)
        : null
    )) : []);
    if (borders.some(row => row.some(Boolean))) metadata.borders = borders;
  }
  return metadata;
}

function tableRows(node: JSONContent): JSONContent[] {
  return node.content ?? [];
}

function cellSpan(cell: JSONContent): number {
  const colspan = cell.attrs?.colspan;
  return typeof colspan === 'number' && colspan > 0 ? colspan : 1;
}

/**
 * One role per column, or null when rows disagree or the grid is uneven.
 *
 * Returning null makes the caller fall back to a dense per-cell matrix, which
 * grows with rows x cells. That is the only lossless encoding once a single
 * cell disagrees with its column, so do not cap it — dropping entries would
 * silently reset the user's roles on the next load.
 */
function readUniformColumnRoles(node: JSONContent): TableColumnRole[] | null {
  const rows = tableRows(node);
  const firstRow = rows[0]?.content ?? [];
  if (rows.length === 0 || firstRow.length === 0) return null;
  if (rows.some(row => (row.content ?? []).length !== firstRow.length)) return null;
  if (rows.some(row => (row.content ?? []).some(cell => cellSpan(cell) > 1))) return null;

  const roles: TableColumnRole[] = [];
  for (let column = 0; column < firstRow.length; column += 1) {
    const role = normalizeTableColumnRole(firstRow[column].attrs?.columnRole);
    for (let row = 1; row < rows.length; row += 1) {
      if (normalizeTableColumnRole(rows[row].content?.[column]?.attrs?.columnRole) !== role) return null;
    }
    roles.push(role);
  }
  return roles;
}

function readDenseCellRoles(node: JSONContent): TableColumnRole[][] {
  return tableRows(node).map(row => (row.content ?? []).map(cell => normalizeTableColumnRole(cell.attrs?.columnRole)));
}

function readSparseBorders(node: JSONContent): TableBorderEntry[] {
  const entries: TableBorderEntry[] = [];
  tableRows(node).forEach((row, rowIndex) => {
    (row.content ?? []).forEach((cell, columnIndex) => {
      const top = normalizeTableBorderStyle(cell.attrs?.borderTop);
      const bottom = normalizeTableBorderStyle(cell.attrs?.borderBottom);
      if (top === 'auto' && bottom === 'auto') return;
      entries.push([rowIndex, columnIndex, top === 'auto' ? null : top, bottom === 'auto' ? null : bottom]);
    });
  });
  return entries;
}

export function getTablePresentationMetadata(node: JSONContent): TablePresentationMetadata {
  const styleId = normalizeTableStyleId(node.attrs?.styleId);
  const comparisonColumn = normalizeComparisonColumn(node.attrs?.comparisonColumn);
  const rows = tableRows(node).map(row => normalizeTableRowRole(row.attrs?.role));
  const hasCellRoles = tableRows(node).some(row => (
    (row.content ?? []).some(cell => normalizeTableColumnRole(cell.attrs?.columnRole) !== 'default')
  ));
  const columnRoles = hasCellRoles ? readUniformColumnRoles(node) : null;
  const borderList = readSparseBorders(node);

  return {
    ...(styleId === 'default' ? {} : { styleId }),
    ...(comparisonColumn === null ? {} : { comparisonColumn }),
    ...(rows.some(role => role !== 'body') ? { rows } : {}),
    ...(hasCellRoles
      ? columnRoles ? { columnRoles } : { cells: readDenseCellRoles(node) }
      : {}),
    ...(borderList.length ? { borderList } : {}),
  };
}

/** Metadata indexes actual rows and cells, excluding Markdown's synthetic header. */
export function applyTablePresentationMetadata(
  node: JSONContent,
  metadata: TablePresentationMetadata | undefined,
): JSONContent {
  if (!metadata) return node;
  const { styleId, comparisonColumn, rows, columnRoles, cells, borderList, borders } = metadata;
  if (styleId === undefined && comparisonColumn === undefined && !rows && !columnRoles && !cells
    && !borderList && !borders) return node;

  const borderOverrides = borderList
    ? new Map(borderList.map(([row, column, top, bottom]) => [`${row}:${column}`, { top, bottom }]))
    : null;

  return {
    ...node,
    attrs: {
      ...node.attrs,
      ...(styleId === undefined ? {} : { styleId }),
      ...(comparisonColumn === undefined ? {} : { comparisonColumn }),
    },
    content: node.content?.map((row, rowIndex) => ({
      ...row,
      ...(rows ? { attrs: { ...row.attrs, role: rows[rowIndex] ?? 'body' } } : {}),
      ...(cells || columnRoles || borderOverrides || borders ? {
        content: row.content?.map((cell, cellIndex) => {
          const override = borderOverrides?.get(`${rowIndex}:${cellIndex}`);
          return {
            ...cell,
            attrs: {
              ...cell.attrs,
              ...(columnRoles
                ? { columnRole: columnRoles[cellIndex] ?? 'default' }
                : cells ? { columnRole: cells[rowIndex]?.[cellIndex] ?? 'default' } : {}),
              ...(borderOverrides
                ? {
                    borderTop: normalizeTableBorderStyle(override?.top),
                    borderBottom: normalizeTableBorderStyle(override?.bottom),
                  }
                : borders ? {
                    borderTop: normalizeTableBorderStyle(borders[rowIndex]?.[cellIndex]?.top),
                    borderBottom: normalizeTableBorderStyle(borders[rowIndex]?.[cellIndex]?.bottom),
                  } : {}),
            },
          };
        }),
      } : {}),
    })),
  };
}
