import type { Editor } from '@tiptap/core';
import { getExtensionField } from '@tiptap/core';
import { Table } from '@tiptap/extension-table';
import { Lexer } from 'marked';
import type { Command } from '@tiptap/pm/state';
import {
  addRowAfter,
  addRowBefore,
  columnResizing,
  columnResizingPluginKey,
  isInTable,
  selectedRect,
  TableMap,
} from '@tiptap/pm/tables';
import { isEmptyMarkdownPlaceholderOnly } from '../../markdown-normalization';
import { scanHead } from '@features/editor/markdown-tokenizer-start';
import { tableHeaderModesFromJSON } from './table-header-modes';
import {
  applyColumnHeader,
  applyColumnWidths,
  getColumnWidths,
  normalizeNodeForMarkdown,
  parseTableMetadata,
  removeSyntheticHeader,
  renderTableMetadata,
} from './table-metadata';
import { serializeTableHtml } from './table-html';
import {
  applyTablePresentationMetadata,
  normalizeTableBackground,
  getTablePresentationMetadata,
  normalizeTableColumnRole,
  type TableColumnRole,
  type TablePresentationMetadata,
} from './table-presentation';
import type {
  JSONContent,
  MarkdownParseHelpers,
  MarkdownRendererHelpers,
  MarkdownToken,
} from '@tiptap/core';

/**
 * The GFM table rule is read from marked's lexer because it consumes the source
 * exactly the way the real tokenizer will. It is not public API: a missing rule
 * must only drop table styling, never break lexing of the whole note.
 */
const gfmTableRule: RegExp | undefined =
  (Lexer as unknown as { rules?: { block?: { gfm?: { table?: RegExp } } } }).rules?.block?.gfm?.table;

type FlowixTableToken = MarkdownToken & {
  flowixColumnWidths?: ReturnType<typeof getColumnWidths>;
  flowixRowHeader?: boolean;
  flowixColumnHeader?: boolean;
  flowixPresentation?: TablePresentationMetadata;
};

/** Pipe tables cannot represent merged cells or multiple blocks in a cell. */
export function tableNeedsHtml(node: JSONContent): boolean {
  return (node.content ?? []).some(row => (row.content ?? []).some(cell =>
    cell.content?.length !== 1 || cell.content[0]?.type !== 'paragraph'
      || (typeof cell.attrs?.colspan === 'number' && cell.attrs.colspan > 1)
      || (typeof cell.attrs?.rowspan === 'number' && cell.attrs.rowspan > 1),
  ));
}

/**
 * Markdown-only table behavior, shared by the parser worker and the editor.
 *
 * The editor replaces `renderMarkdown` through `createEditorTable()` so that
 * complex tables can be serialized as HTML with the live schema. This base
 * version has no schema, so it refuses to render a table it would have to
 * downgrade — a silent pipe rendering drops merged cells, which is the one
 * thing the user cannot see and cannot undo.
 */
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
    if (tableNeedsHtml(node)) {
      throw new Error(
        '[flowix-table] this table needs HTML (merged or multi-block cells) but is being rendered '
        + 'without an editor schema. Render it through createEditorTable(), which upgrades to HTML.',
      );
    }

    const widths = getColumnWidths(node);
    const { rowHeader, columnHeader } = tableHeaderModesFromJSON(node);
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

      // Lex only this table, avoiding recursive re-parsing of later metadata
      // tables. The slice copies the remaining document once per styled table;
      // a sticky rule would avoid it but cannot read marked's rule object.
      const tableSource = gfmTableRule?.exec(src.slice(metadata.raw.length))?.[0];
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
      const backgrounds = Array.from({ length: rect.map.width }, (_, column) => {
        const first = normalizeTableBackground(rect.table.nodeAt(rect.map.map[column])?.attrs.columnBackground);
        for (let row = 1; row < rect.map.height; row++) {
          if (normalizeTableBackground(rect.table.nodeAt(rect.map.map[row * rect.map.width + column])?.attrs.columnBackground) !== first) return null;
        }
        return first;
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
          const background = backgrounds[left];
          const rolePatch = role && role !== 'default' && roles.slice(left, right).every(value => value === role) ? { columnRole: role } : {};
          const backgroundPatch = background && backgrounds.slice(left, right).every(value => value === background) ? { columnBackground: background } : {};
          if (!Object.keys(rolePatch).length && !Object.keys(backgroundPatch).length) return;
          tr.setNodeMarkup(rect.tableStart + position, undefined, { ...cell.attrs, ...rolePatch, ...backgroundPatch });
        });
      }
      dispatch(tr);
    } : undefined, view);
  };
}

const addRowBeforeWithColumnRoles = inheritColumnRoles(addRowBefore, true);
const addRowAfterWithColumnRoles = inheritColumnRoles(addRowAfter, false);

/**
 * The editor's table. It adds the resize plugin, the column-role commands, and
 * an HTML fallback for tables pipe syntax cannot express.
 *
 * Each editor gets its own instance so `renderMarkdown` can capture the live
 * schema: Markdown callbacks receive no editor context, and the DOM serializer
 * must match the schema the document was parsed with.
 */
export function createEditorTable() {
  // Filled by `onBeforeCreate`, the only hook that hands the extension its
  // editor. Rendering before that point would have no schema to serialize with.
  let editor: Editor | undefined;
  const renderSimple = getExtensionField(FlowixTable, 'renderMarkdown');
  return Table.extend({
    ...FlowixTable.config,
    addProseMirrorPlugins() {
      const plugins = this.parent?.() ?? [];
      // Editors survive read-only/editable transitions. The resize plugin must
      // exist from initialization; its event handlers already check view.editable.
      if (!this.options.resizable || plugins.some(plugin => plugin.spec.key === columnResizingPluginKey)) return plugins;
      return [columnResizing({
        handleWidth: this.options.handleWidth,
        cellMinWidth: this.options.cellMinWidth,
        defaultCellMinWidth: this.options.cellMinWidth,
        View: this.options.View,
        lastColumnResizable: this.options.lastColumnResizable,
      }), ...plugins];
    },
    addNodeView() {
      // The resize plugin supplies the table NodeView in both editing modes.
      return this.options.resizable ? null : this.parent?.() ?? null;
    },
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
      if (!editor) {
        throw new Error('[flowix-table] HTML table serialization ran before the editor was created.');
      }
      return serializeTableHtml(node, editor.schema);
    },
  });
}
