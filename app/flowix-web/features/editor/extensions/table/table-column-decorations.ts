import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { normalizeComparisonColumn } from './table-presentation';

const tableColumnDecorationsKey = new PluginKey<DecorationSet>('tableColumnDecorations');
const COMPARISON_COLUMN = 2;

interface RelativeDecoration {
  from: number;
  to: number;
  attrs: Record<string, string>;
}

/**
 * Decorations for one table, relative to the table node start.
 *
 * ProseMirror reuses unchanged subtree nodes by identity, so a table keeps its
 * cache entry until something inside it actually changes. Rebuilding the whole
 * document's decorations therefore only costs the walk; TableMap lookups and
 * cell scans are skipped for every untouched comparison table.
 */
const decorationsByTable = new WeakMap<ProseMirrorNode, RelativeDecoration[]>();

function buildTableDecorations(table: ProseMirrorNode): RelativeDecoration[] {
  if (table.attrs.styleId !== 'comparison') return [];

  const map = TableMap.get(table);
  const configuredColumn = normalizeComparisonColumn(table.attrs.comparisonColumn);
  const column = configuredColumn === null ? COMPARISON_COLUMN : Math.min(configuredColumn, map.width - 1);
  if (map.width <= column) return [];

  const positions = new Set<number>();
  for (let row = 0; row < map.height; row += 1) {
    positions.add(map.map[row * map.width + column]);
  }

  const decorations: RelativeDecoration[] = [];
  for (const position of positions) {
    const cell = table.nodeAt(position);
    if (!cell || (cell.type.spec.tableRole !== 'cell' && cell.type.spec.tableRole !== 'header_cell')) continue;
    const bounds = map.findCell(position);
    const attrs: Record<string, string> = { 'data-flowix-comparison-column': '' };
    if (bounds.top === 0) attrs['data-flowix-comparison-first'] = '';
    if (bounds.bottom === map.height) attrs['data-flowix-comparison-last'] = '';
    // A merged cell is styled as a whole; these view markers never enter the saved document.
    decorations.push({ from: 1 + position, to: 1 + position + cell.nodeSize, attrs });
  }
  return decorations;
}

function tableDecorations(table: ProseMirrorNode): RelativeDecoration[] {
  const cached = decorationsByTable.get(table);
  if (cached) return cached;
  const built = buildTableDecorations(table);
  decorationsByTable.set(table, built);
  return built;
}

function createColumnDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((table, tablePosition) => {
    if (table.type.name !== 'table') return;
    for (const relative of tableDecorations(table)) {
      decorations.push(Decoration.node(tablePosition + relative.from, tablePosition + relative.to, relative.attrs));
    }
  });
  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

export function createTableColumnDecorationsPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: tableColumnDecorationsKey,
    state: {
      init: (_config, state) => createColumnDecorations(state.doc),
      apply: (tr, value) => tr.docChanged ? createColumnDecorations(tr.doc) : value,
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}
