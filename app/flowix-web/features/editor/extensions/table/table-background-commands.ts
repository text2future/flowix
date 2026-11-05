import type { Editor } from '@tiptap/core';
import { isInTable, selectedRect } from '@tiptap/pm/tables';
import { isFlowixTextColor, type FlowixTextColor } from '../flowix-text-colors';

/** Direct formatting: row fills follow row nodes, column fills follow cells. */
export function setTableBackground(editor: Editor, axis: 'row' | 'column', color: FlowixTextColor | null): boolean {
  if (editor.isDestroyed || !editor.isEditable || !isInTable(editor.state)) return false;
  if (color !== null && !isFlowixTextColor(color)) return false;
  return editor.chain().focus().command(({ tr, state }) => {
    const { table, tableStart, map, top, bottom, left, right } = selectedRect(state);
    if (axis === 'row') {
      table.forEach((row, offset, index) => {
        if (index >= top && index < bottom) {
          tr.setNodeMarkup(tableStart + offset, undefined, { ...row.attrs, rowBackground: color });
        }
      });
    } else {
      const positions = new Set<number>();
      for (let row = 0; row < map.height; row++) {
        for (let column = left; column < right; column++) positions.add(map.map[row * map.width + column]);
      }
      for (const position of positions) {
        const cell = table.nodeAt(position);
        if (cell) tr.setNodeMarkup(tableStart + position, undefined, { ...cell.attrs, columnBackground: color });
      }
    }
    return true;
  }).run();
}
