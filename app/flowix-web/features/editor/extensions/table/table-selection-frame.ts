import { Plugin, PluginKey, type Selection } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

const tableSelectionFrameKey = new PluginKey<DecorationSet>('tableSelectionFrame');

/** Attribute carrying the outline sides of one cell: any of `t b l r`, space separated. */
export const TABLE_CELL_FRAME_ATTR = 'data-flowix-cell-frame';

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function outlineSides(bounds: Rect, rect: Rect): string {
  const sides = [
    bounds.top === rect.top ? 't' : '',
    bounds.bottom === rect.bottom ? 'b' : '',
    bounds.left === rect.left ? 'l' : '',
    bounds.right === rect.right ? 'r' : '',
  ];
  return sides.filter(Boolean).join(' ');
}

/**
 * Marks the cells whose edges fall on the outline of a rectangular cell
 * selection, so the frame paints one block border instead of drawing every
 * cell's grid. CSS owns the paint; this plugin owns only the geometry.
 */
function buildSelectionFrame(doc: ProseMirrorNode, selection: Selection): DecorationSet {
  if (!(selection instanceof CellSelection)) return DecorationSet.empty;

  const { $anchorCell, $headCell } = selection;
  const table = $anchorCell.node(-1);
  if (table.type.name !== 'table') return DecorationSet.empty;

  const map = TableMap.get(table);
  const start = $anchorCell.start(-1);
  const rect = map.rectBetween($anchorCell.pos - start, $headCell.pos - start);

  const decorations: Decoration[] = [];
  for (const offset of map.cellsInRect(rect)) {
    const cell = table.nodeAt(offset);
    if (!cell) continue;
    const sides = outlineSides(map.findCell(offset), rect);
    // An interior cell of a wide rectangle has no side on the outline; leaving
    // it undecorated is what keeps the inner grid free of edges.
    if (!sides) continue;
    decorations.push(Decoration.node(start + offset, start + offset + cell.nodeSize, {
      [TABLE_CELL_FRAME_ATTR]: sides,
    }));
  }
  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

export function createTableSelectionFramePlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: tableSelectionFrameKey,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, value, _old, newState) => {
        if (!tr.selectionSet && !tr.docChanged) return value;
        return buildSelectionFrame(newState.doc, newState.selection);
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}
