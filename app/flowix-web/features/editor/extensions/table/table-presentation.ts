import { Extension, type JSONContent } from '@tiptap/core';

export const TABLE_STYLE_IDS = [
  'default', 'business-blue', 'striped', 'comparison', 'financial-brief',
  'hk-financial', 'three-line', 'grouped', 'minimal', 'literature',
] as const;
export const TABLE_ROW_ROLES = ['body', 'group', 'subtotal', 'total'] as const;
export const TABLE_COLUMN_ROLES = ['default', 'label', 'note', 'amount'] as const;
export const TABLE_BORDER_STYLES = ['auto', 'none', 'single', 'double'] as const;

export type TableStyleId = typeof TABLE_STYLE_IDS[number];
export type TableRowRole = typeof TABLE_ROW_ROLES[number];
export type TableColumnRole = typeof TABLE_COLUMN_ROLES[number];
export type TableBorderStyle = typeof TABLE_BORDER_STYLES[number];

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

export interface TablePresentationMetadata {
  styleId?: TableStyleId;
  rows?: TableRowRole[];
  cells?: TableColumnRole[][];
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

export function parseTablePresentationMetadata(value: unknown): TablePresentationMetadata {
  if (!value || typeof value !== 'object') return {};
  const metadata: TablePresentationMetadata = {};
  if ('styleId' in value) metadata.styleId = normalizeTableStyleId(value.styleId);
  if ('rows' in value && Array.isArray(value.rows)) {
    metadata.rows = value.rows.map(normalizeTableRowRole);
  }
  if ('cells' in value && Array.isArray(value.cells)) {
    metadata.cells = value.cells.map(row => Array.isArray(row) ? row.map(normalizeTableColumnRole) : []);
  }
  if ('borders' in value && Array.isArray(value.borders)) {
    const borders = value.borders.map(row => Array.isArray(row) ? row.map(cell => (
      cell && typeof cell === 'object' && !Array.isArray(cell)
        ? cellBorderMetadata(cell.top, cell.bottom)
        : null
    )) : []);
    if (borders.some(row => row.some(Boolean))) metadata.borders = borders;
  }
  return metadata;
}

export function getTablePresentationMetadata(node: JSONContent): TablePresentationMetadata {
  const styleId = normalizeTableStyleId(node.attrs?.styleId);
  const rows = (node.content ?? []).map(row => normalizeTableRowRole(row.attrs?.role));
  const cells = (node.content ?? []).map(row => (
    (row.content ?? []).map(cell => normalizeTableColumnRole(cell.attrs?.columnRole))
  ));
  const borders = (node.content ?? []).map(row => (
    (row.content ?? []).map(cell => cellBorderMetadata(cell.attrs?.borderTop, cell.attrs?.borderBottom))
  ));
  return {
    ...(styleId === 'default' ? {} : { styleId }),
    ...(rows.some(role => role !== 'body') ? { rows } : {}),
    ...(cells.some(row => row.some(role => role !== 'default')) ? { cells } : {}),
    ...(borders.some(row => row.some(Boolean)) ? { borders } : {}),
  };
}

/** Metadata indexes actual rows and cells, excluding Markdown's synthetic header. */
export function applyTablePresentationMetadata(
  node: JSONContent,
  metadata: TablePresentationMetadata | undefined,
): JSONContent {
  if (!metadata) return node;
  const { styleId, rows, cells, borders } = metadata;
  if (styleId === undefined && !rows && !cells && !borders) return node;
  return {
    ...node,
    ...(styleId === undefined ? {} : { attrs: { ...node.attrs, styleId } }),
    content: node.content?.map((row, rowIndex) => ({
      ...row,
      ...(rows ? { attrs: { ...row.attrs, role: rows[rowIndex] ?? 'body' } } : {}),
      ...(cells || borders ? {
        content: row.content?.map((cell, cellIndex) => ({
          ...cell,
          attrs: {
            ...cell.attrs,
            ...(cells ? { columnRole: cells[rowIndex]?.[cellIndex] ?? 'default' } : {}),
            ...(borders ? {
              borderTop: normalizeTableBorderStyle(borders[rowIndex]?.[cellIndex]?.top),
              borderBottom: normalizeTableBorderStyle(borders[rowIndex]?.[cellIndex]?.bottom),
            } : {}),
          },
        })),
      } : {}),
    })),
  };
}
