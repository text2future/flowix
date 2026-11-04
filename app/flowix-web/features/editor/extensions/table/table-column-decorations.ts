import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const tableColumnDecorationsKey = new PluginKey<DecorationSet>('tableColumnDecorations');
const COMPARISON_COLUMN = 2;

function createColumnDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((table, tablePosition) => {
    if (table.type.name !== 'table' || table.attrs.styleId !== 'comparison') return;
    const map = TableMap.get(table);
    if (map.width <= COMPARISON_COLUMN) return;
    const positions = new Set<number>();
    for (let row = 0; row < map.height; row += 1) {
      positions.add(map.map[row * map.width + COMPARISON_COLUMN]);
    }
    for (const position of positions) {
      const cell = table.nodeAt(position);
      if (!cell || (cell.type.spec.tableRole !== 'cell' && cell.type.spec.tableRole !== 'header_cell')) continue;
      const bounds = map.findCell(position);
      const attrs: Record<string, string> = { 'data-flowix-comparison-column': '' };
      if (bounds.top === 0) attrs['data-flowix-comparison-first'] = '';
      if (bounds.bottom === map.height) attrs['data-flowix-comparison-last'] = '';
      const from = tablePosition + 1 + position;
      // A merged cell is styled as a whole; these view markers never enter the saved document.
      decorations.push(Decoration.node(from, from + cell.nodeSize, attrs));
    }
  });
  return DecorationSet.create(doc, decorations);
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
