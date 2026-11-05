import type { JSONContent } from '@tiptap/core';

import {
  parseTablePresentationMetadata,
  type TablePresentationMetadata,
} from './table-presentation';

/**
 * Everything that maps Markdown's pipe-table limitations onto schema
 * attributes: the metadata comment, column widths, and the synthetic header
 * row Markdown forces on tables that have none.
 *
 * `flowix-table.ts` owns the extension (tokenizer, commands, serialization
 * strategy); this module owns the data shape. Keeping them apart is what lets
 * the extension file stay about ProseMirror and this one stay about bytes.
 */

const TABLE_METADATA_RE = /^<!--[ \t]*flowix:table[ \t]+(\{[^\r\n]*\})[ \t]*-->(?:\r?\n)+/;
const LEGACY_TABLE_WIDTH_METADATA_RE = /^<!--[ \t]*flowix:table-widths=([^\s]+)[ \t]*-->(?:\r?\n)+/;
const TABLE_WIDTH_VALUE_RE = /^(?:auto|[1-9]\d*)$/;
const FLOWIX_TABLE_METADATA_VERSION = 1;

export type TableColumnWidth = number | null;

export interface FlowixTableMetadata extends TablePresentationMetadata {
  version: number;
  columns: Array<{ width: TableColumnWidth }>;
  rowHeader?: boolean;
  columnHeader?: boolean;
  /** Legacy v1 field; read-only compatibility with the first header fix. */
  header?: false;
}

export interface ParsedTableMetadata {
  raw: string;
  widths: TableColumnWidth[];
  rowHeader?: boolean;
  columnHeader?: boolean;
  presentation?: TablePresentationMetadata;
}

function parseColumnWidths(value: string | undefined): TableColumnWidth[] | null {
  if (!value) return null;

  return value.split(',').map(item => {
    const normalized = item.trim();
    if (normalized === 'auto') return null;
    if (!TABLE_WIDTH_VALUE_RE.test(normalized)) return null;

    const width = Number(normalized);
    return Number.isSafeInteger(width) ? width : null;
  });
}

function parseVersionedMetadata(value: string | undefined): {
  widths: TableColumnWidth[];
  rowHeader?: boolean;
  columnHeader?: boolean;
  presentation?: TablePresentationMetadata;
} | null {
  if (!value) return null;

  try {
    const metadata = JSON.parse(value) as Partial<FlowixTableMetadata>;
    if (metadata.version !== FLOWIX_TABLE_METADATA_VERSION || !Array.isArray(metadata.columns)) {
      return null;
    }

    return {
      widths: metadata.columns.map(column => {
        if (!column || typeof column !== 'object' || !('width' in column)) return null;
        const width = column.width;
        return width === null
          ? null
          : typeof width === 'number' && Number.isSafeInteger(width) && width > 0
            ? width
            : null;
      }),
      rowHeader: metadata.rowHeader === false || metadata.header === false ? false : undefined,
      columnHeader: metadata.columnHeader === true ? true : undefined,
      presentation: parseTablePresentationMetadata(metadata),
    };
  } catch {
    return null;
  }
}

/**
 * Read the metadata comment that precedes a pipe table. Returns null for every
 * malformed shape rather than partially trusting it; the table then renders
 * from its pipe form alone.
 */
export function parseTableMetadata(src: string): ParsedTableMetadata | null {
  const versioned = TABLE_METADATA_RE.exec(src);
  if (versioned) {
    const metadata = parseVersionedMetadata(versioned[1]);
    return metadata && metadata.widths.length > 0
      ? { raw: versioned[0], ...metadata }
      : null;
  }

  const legacy = LEGACY_TABLE_WIDTH_METADATA_RE.exec(src);
  if (legacy) {
    const widths = parseColumnWidths(legacy[1]);
    return widths && widths.length > 0 ? { raw: legacy[0], widths } : null;
  }

  return null;
}

export function getColumnWidths(node: JSONContent): TableColumnWidth[] {
  const firstRow = node.content?.[0];
  if (!firstRow || firstRow.type !== 'tableRow' || !Array.isArray(firstRow.content)) return [];

  const widths: TableColumnWidth[] = [];
  firstRow.content.forEach(cell => {
    const colspan = typeof cell.attrs?.colspan === 'number' && cell.attrs.colspan > 0
      ? cell.attrs.colspan
      : 1;
    const colwidth = Array.isArray(cell.attrs?.colwidth) ? cell.attrs.colwidth : [];

    for (let index = 0; index < colspan; index += 1) {
      const width = colwidth[index];
      widths.push(typeof width === 'number' && Number.isSafeInteger(width) && width > 0 ? width : null);
    }
  });

  return widths;
}

export function applyColumnWidths(node: JSONContent, widths: TableColumnWidth[]): JSONContent {
  if (!Array.isArray(node.content) || widths.length === 0) return node;

  const content = node.content.map(row => {
    if (row.type !== 'tableRow' || !Array.isArray(row.content)) return row;

    let columnIndex = 0;
    const cells = row.content.map(cell => {
      const colspan = typeof cell.attrs?.colspan === 'number' && cell.attrs.colspan > 0
        ? cell.attrs.colspan
        : 1;
      const cellWidths = widths.slice(columnIndex, columnIndex + colspan);
      columnIndex += colspan;

      const colwidth = cellWidths.length > 0 && cellWidths.some(width => width !== null)
        ? cellWidths.map(width => width ?? null)
        : null;

      return {
        ...cell,
        attrs: {
          ...cell.attrs,
          colwidth,
        },
      };
    });

    return { ...row, content: cells };
  });

  return { ...node, content };
}

export function renderTableMetadata(
  widths: TableColumnWidth[],
  rowHeader: boolean,
  columnHeader: boolean,
  presentation: TablePresentationMetadata,
): string {
  const metadata: FlowixTableMetadata = {
    version: FLOWIX_TABLE_METADATA_VERSION,
    columns: widths.map(width => ({ width })),
  };
  if (!rowHeader) metadata.rowHeader = false;
  if (columnHeader) metadata.columnHeader = true;
  Object.assign(metadata, presentation);
  return `<!-- flowix:table ${JSON.stringify(metadata)} -->`;
}

/** Drop the empty header row Markdown required but the document never had. */
export function removeSyntheticHeader(node: JSONContent): JSONContent {
  if (!Array.isArray(node.content) || node.content.length === 0) return node;
  return { ...node, content: node.content.slice(1) };
}

export function applyColumnHeader(node: JSONContent): JSONContent {
  if (!Array.isArray(node.content)) return node;

  return {
    ...node,
    content: node.content.map(row => {
      if (row.type !== 'tableRow' || !Array.isArray(row.content) || row.content.length === 0) return row;
      const firstCell = row.content[0];
      return {
        ...row,
        content: [
          { ...firstCell, type: 'tableHeader' },
          ...row.content.slice(1),
        ],
      };
    }),
  };
}

export function normalizeNodeForMarkdown(
  node: JSONContent,
  rowHeader: boolean,
  columnHeader: boolean,
): JSONContent {
  if (rowHeader || !columnHeader || !Array.isArray(node.content)) return node;

  // Markdown's first row is always a header row. When the document has only
  // a column header, turn the first cell of the first row back into a body
  // cell before delegating to Tiptap's standard table renderer.
  const [firstRow, ...rest] = node.content;
  if (firstRow?.type !== 'tableRow' || !Array.isArray(firstRow.content) || firstRow.content.length === 0) {
    return node;
  }

  return {
    ...node,
    content: [
      {
        ...firstRow,
        content: [{ ...firstRow.content[0], type: 'tableCell' }, ...firstRow.content.slice(1)],
      },
      ...rest,
    ],
  };
}
