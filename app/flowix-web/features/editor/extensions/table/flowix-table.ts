import { DOMSerializer } from '@tiptap/pm/model';
import { getExtensionField } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { Table } from '@tiptap/extension-table';
import type { Command } from '@tiptap/pm/state';
import { addRowAfter, addRowBefore, isInTable, selectedRect, TableMap } from '@tiptap/pm/tables';
import { Lexer } from 'marked';
import { isEmptyMarkdownPlaceholderOnly } from '../../markdown-normalization';
import { scanHead } from '@features/editor/markdown-tokenizer-start';
import {
  applyTablePresentationMetadata,
  getTablePresentationMetadata,
  normalizeTableColumnRole,
  type TableColumnRole,
  parseTablePresentationMetadata,
  type TablePresentationMetadata,
} from './table-presentation';
import type {
  JSONContent,
  MarkdownParseHelpers,
  MarkdownRendererHelpers,
  MarkdownToken,
} from '@tiptap/core';

const TABLE_METADATA_RE = /^<!--[ \t]*flowix:table[ \t]+(\{[^\r\n]*\})[ \t]*-->(?:\r?\n)+/;
const LEGACY_TABLE_WIDTH_METADATA_RE = /^<!--[ \t]*flowix:table-widths=([^\s]+)[ \t]*-->(?:\r?\n)+/;
const TABLE_WIDTH_VALUE_RE = /^(?:auto|[1-9]\d*)$/;
const FLOWIX_TABLE_METADATA_VERSION = 1;

type TableColumnWidth = number | null;

type FlowixTableToken = MarkdownToken & {
  flowixColumnWidths?: TableColumnWidth[];
  flowixRowHeader?: boolean;
  flowixColumnHeader?: boolean;
  flowixPresentation?: TablePresentationMetadata;
};

interface FlowixTableMetadata extends TablePresentationMetadata {
  version: number;
  columns: Array<{ width: TableColumnWidth }>;
  rowHeader?: boolean;
  columnHeader?: boolean;
  /** Legacy v1 field; read-only compatibility with the first header fix. */
  header?: false;
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

function parseTableMetadata(src: string): {
  raw: string;
  widths: TableColumnWidth[];
  rowHeader?: boolean;
  columnHeader?: boolean;
  presentation?: TablePresentationMetadata;
} | null {
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

function getColumnWidths(node: JSONContent): TableColumnWidth[] {
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

function applyColumnWidths(node: JSONContent, widths: TableColumnWidth[]): JSONContent {
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

function renderTableMetadata(
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

function removeSyntheticHeader(node: JSONContent): JSONContent {
  if (!Array.isArray(node.content) || node.content.length === 0) return node;
  return { ...node, content: node.content.slice(1) };
}

function applyColumnHeader(node: JSONContent): JSONContent {
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

function getHeaderModes(node: JSONContent): { rowHeader: boolean; columnHeader: boolean } {
  const rows = Array.isArray(node.content)
    ? node.content.filter(row => row.type === 'tableRow' && Array.isArray(row.content))
    : [];
  const firstRow = rows[0];
  const firstRowCells = firstRow?.content ?? [];
  const columnCount = firstRowCells.length;
  const columnHeader = columnCount > 1
    && rows.length > 1
    && rows.every(row => row.content?.[0]?.type === 'tableHeader');
  const rowHeader = firstRowCells.some((cell, index) => (
    cell.type === 'tableHeader' && (index > 0 || !columnHeader)
  ));

  return { rowHeader, columnHeader };
}

function normalizeNodeForMarkdown(node: JSONContent, rowHeader: boolean, columnHeader: boolean): JSONContent {
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

/** Pipe tables cannot represent merged cells or multiple blocks in a cell. */
export function tableNeedsHtml(node: JSONContent): boolean {
  return (node.content ?? []).some(row => (row.content ?? []).some(cell =>
    cell.content?.length !== 1 || cell.content[0]?.type !== 'paragraph'
      || (typeof cell.attrs?.colspan === 'number' && cell.attrs.colspan > 1)
      || (typeof cell.attrs?.rowspan === 'number' && cell.attrs.rowspan > 1),
  ));
}

export const FlowixTable = Table.extend({
  parseMarkdown(this: { parent?: (token: MarkdownToken, helpers: MarkdownParseHelpers) => JSONContent }, token, helpers) {
    // Table's parser builds cell paragraphs directly, bypassing Paragraph.parseMarkdown.
    // Check source tokens and parsed text so formatting and additional encoding survive.
    const parsed = this.parent ? this.parent(token, {
      ...helpers,
      parseInline(tokens) {
        const content = helpers.parseInline(tokens);
        const isEmptyCell = tokens.every(part => part.type === 'text'
          && isEmptyMarkdownPlaceholderOnly(part.raw ?? part.text ?? ''))
          && content.every(part => part.type === 'text'
            && !part.marks?.length
            && typeof part.text === 'string'
            && isEmptyMarkdownPlaceholderOnly(part.text));
        return isEmptyCell ? [] : content;
      },
    }) : { type: 'table', content: [] };
    if (Array.isArray(parsed) || parsed.type !== 'table') return parsed;

    const flowixToken = token as FlowixTableToken;
    const withoutSyntheticHeader = flowixToken.flowixRowHeader === false
      ? removeSyntheticHeader(parsed)
      : parsed;
    const withColumnWidths = flowixToken.flowixColumnWidths
      ? applyColumnWidths(withoutSyntheticHeader, flowixToken.flowixColumnWidths)
      : withoutSyntheticHeader;
    const withHeaders = flowixToken.flowixColumnHeader === true
      ? applyColumnHeader(withColumnWidths)
      : withColumnWidths;
    return applyTablePresentationMetadata(withHeaders, flowixToken.flowixPresentation);
  },

  renderMarkdown(
    this: {
      parent?: (node: JSONContent, helpers: MarkdownRendererHelpers, ctx: unknown) => string
    },
    node,
    helpers,
    ctx,
  ) {
    const widths = getColumnWidths(node);
    const { rowHeader, columnHeader } = getHeaderModes(node);
    const normalizedNode = normalizeNodeForMarkdown(node, rowHeader, columnHeader);
    const rendered = this.parent?.(normalizedNode, {
      ...helpers,
      // The standard table renderer renders paragraphs with the table as their
      // parent. Remove reserved empty-paragraph markers locally, before padding.
      renderChildren(nodes, separator) {
        const value = helpers.renderChildren(nodes, separator);
        return isEmptyMarkdownPlaceholderOnly(value) ? '' : value;
      },
    }, ctx) ?? '';
    const hasExplicitWidth = widths.some(width => width !== null);
    const presentation = getTablePresentationMetadata(node);
    return (hasExplicitWidth || !rowHeader || columnHeader || Object.keys(presentation).length > 0)
      ? `${renderTableMetadata(widths, rowHeader, columnHeader, presentation)}${rendered}`
      : rendered;
  },

  markdownTokenizer: {
    name: 'table',
    level: 'block' as const,
    start: (src: string) => {
      const head = scanHead(src);
      const escapedTableIndex = head.search(/^[ \t]*&lt;table(?:[ \t]|&gt;)/mi);
      const versionedIndex = head.search(/^<!--[ \t]*flowix:table[ \t]+\{/m);
      const legacyIndex = head.search(/^<!--[ \t]*flowix:table-widths=/m);
      const indices = [escapedTableIndex, versionedIndex, legacyIndex].filter(index => index >= 0);
      return indices.length ? Math.min(...indices) : -1;
    },
    tokenize(src, _tokens, lexer) {
      // Older notes can contain a whole HTML table escaped as text. Decode one
      // layer only for a complete standalone table, leaving inline examples and
      // code blocks to the standard Markdown tokenizers.
      const escaped = /^[ \t]*&lt;table(?:[ \t][^\r\n]*?)?&gt;[\s\S]*?&lt;\/table&gt;[ \t]*(?=\r?\n|$)/i.exec(src);
      if (escaped) {
        const entities: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'" };
        const html = escaped[0].replace(/&(lt|gt|amp|quot|#39);/g, (_match, name: string) => entities[name]);
        const tokens = lexer.blockTokens(html);
        if (tokens.length === 1 && tokens[0].type === 'html') {
          return { ...tokens[0], raw: escaped[0], text: html };
        }
      }

      const metadata = parseTableMetadata(src);
      if (!metadata) return undefined;

      // Lex only this table, avoiding recursive re-parsing of later metadata tables.
      const tableSource = Lexer.rules.block.gfm.table.exec(src.slice(metadata.raw.length))?.[0];
      if (!tableSource) return undefined;
      const tableTokens = lexer.blockTokens(tableSource);
      const table = tableTokens[0] as FlowixTableToken | undefined;
      if (!table || table.type !== 'table') return undefined;

      return {
        ...table,
        raw: metadata.raw + table.raw,
        flowixColumnWidths: metadata.widths,
        flowixPresentation: metadata.presentation,
        ...(metadata.rowHeader === undefined ? {} : { flowixRowHeader: metadata.rowHeader }),
        ...(metadata.columnHeader === undefined ? {} : { flowixColumnHeader: metadata.columnHeader }),
      };
    },
  },
});

function inheritColumnRoles(addRow: Command, before: boolean): Command {
  return (state, dispatch, view) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    return addRow(state, dispatch ? (tr) => {
      const roles = Array.from({ length: rect.map.width }, (_, column): TableColumnRole => {
        let role: TableColumnRole | undefined;
        for (let row = 0; row < rect.map.height; row += 1) {
          const cell = rect.table.nodeAt(rect.map.map[row * rect.map.width + column]);
          const current = normalizeTableColumnRole(cell?.attrs.columnRole);
          if (current === 'default' || (role !== undefined && current !== role)) return 'default';
          role = current;
        }
        return role ?? 'default';
      });
      const table = tr.doc.nodeAt(rect.tableStart - 1);
      if (table) {
        const map = TableMap.get(table);
        const insertedRow = before ? rect.top : rect.bottom;
        let rowOffset = 0;
        for (let row = 0; row < insertedRow; row += 1) rowOffset += table.child(row).nodeSize;
        // Only cells created by this insertion are eligible; spanning cells and
        // existing rows retain their own roles, and pasted tables are untouched.
        table.child(insertedRow).forEach((cell, offset) => {
          if (normalizeTableColumnRole(cell.attrs.columnRole) !== 'default' || cell.textContent) return;
          const position = rowOffset + 1 + offset;
          const { left, right } = map.findCell(position);
          const role = roles[left];
          if (!role || role === 'default' || roles.slice(left, right).some(value => value !== role)) return;
          tr.setNodeMarkup(rect.tableStart + position, undefined, { ...cell.attrs, columnRole: role });
        });
      }
      dispatch(tr);
    } : undefined, view);
  };
}

const addRowBeforeWithColumnRoles = inheritColumnRoles(addRowBefore, true);
const addRowAfterWithColumnRoles = inheritColumnRoles(addRowAfter, false);

/** Capture the active editor schema; Markdown callbacks have no editor context. */
export function createEditorTable() {
  let editor: Editor;
  const renderSimple = getExtensionField(FlowixTable, 'renderMarkdown');
  return Table.extend({
    ...FlowixTable.config,
    addCommands() {
      return {
        ...this.parent?.(),
        addRowBefore: () => ({ state, dispatch, view }) => addRowBeforeWithColumnRoles(state, dispatch, view),
        addRowAfter: () => ({ state, dispatch, view }) => addRowAfterWithColumnRoles(state, dispatch, view),
      };
    },
    onBeforeCreate() {
      editor = this.editor;
    },
    renderMarkdown(node, helpers, ctx) {
      if (!tableNeedsHtml(node)) return renderSimple(node, helpers, ctx);
      const schema = editor.schema;
      const container = document.createElement('div');
      container.appendChild(DOMSerializer.fromSchema(schema).serializeNode(schema.nodeFromJSON(node)));
      // A blank source line ends a CommonMark HTML block. Character references
      // keep the table on one source line and decode back to literal newlines
      // inside pre/code when the schema parses the HTML.
      return container.innerHTML.replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
    },
  });
}
