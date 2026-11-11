import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTablePlugin } from './table-plugin';
import { TABLE_CELL_FRAME_ATTR } from './table-selection-frame';

const CONTENT = [
  '<table>',
  '<tr><th>H1</th><th>H2</th><th>H3</th></tr>',
  '<tr><td>A1</td><td>A2</td><td>A3</td></tr>',
  '<tr><td>B1</td><td>B2</td><td>B3</td></tr>',
  '</table>',
  '<p>After</p>',
].join('');

const editors: Editor[] = [];

function createEditor() {
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit, createTablePlugin()],
    content: CONTENT,
  });
  editors.push(editor);
  return editor;
}

function cellPosition(editor: Editor, row: number, column: number) {
  const table = editor.state.doc.firstChild!;
  const map = TableMap.get(table);
  return 1 + map.map[row * map.width + column];
}

function selectRect(editor: Editor, from: [number, number], to: [number, number]) {
  editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(
    editor.state.doc,
    cellPosition(editor, from[0], from[1]),
    cellPosition(editor, to[0], to[1]),
  )));
}

/** Outline sides of a cell, keyed by its own text so assertions read as a grid. */
function frameByCellText(editor: Editor) {
  const frames: Record<string, string | null> = {};
  for (const cell of Array.from(editor.view.dom.querySelectorAll('td, th'))) {
    frames[cell.textContent ?? ''] = cell.getAttribute(TABLE_CELL_FRAME_ATTR);
  }
  return frames;
}

afterEach(() => {
  editors.splice(0).forEach(editor => {
    const element = editor.options.element as HTMLElement;
    editor.destroy();
    element.remove();
  });
  vi.restoreAllMocks();
});

describe('table selection frame', () => {
  it('marks a single selected cell on all four sides', () => {
    const editor = createEditor();
    selectRect(editor, [1, 1], [1, 1]);
    expect(frameByCellText(editor)).toMatchObject({ A2: 't b l r' });
  });

  it('paints only the outside of a rectangular selection', () => {
    const editor = createEditor();
    selectRect(editor, [1, 1], [2, 2]);

    const frames = frameByCellText(editor);
    expect(frames).toMatchObject({
      A2: 't l',
      A3: 't r',
      B2: 'b l',
      B3: 'b r',
    });
    // Cells outside the rectangle keep no outline at all.
    expect(frames.H2).toBeNull();
    expect(frames.B1).toBeNull();
  });

  it('leaves interior cells of a multi-cell selection unmarked', () => {
    const editor = createEditor();
    selectRect(editor, [0, 0], [2, 2]);

    const frames = frameByCellText(editor);
    // The centre cell sits inside the block: no side lands on the outline.
    expect(frames.A2).toBeNull();
    expect(frames).toMatchObject({
      H1: 't l',
      H3: 't r',
      B1: 'b l',
      B3: 'b r',
      H2: 't',
      A1: 'l',
      A3: 'r',
      B2: 'b',
    });
  });

  it('keeps the whole perimeter of a row selection', () => {
    const editor = createEditor();
    selectRect(editor, [1, 0], [1, 2]);

    expect(frameByCellText(editor)).toMatchObject({
      A1: 't b l',
      A2: 't b',
      A3: 't b r',
    });
  });

  it('only frames rectangular cell selections, never a caret or text range', () => {
    const editor = createEditor();
    editor.commands.setTextSelection(cellPosition(editor, 1, 1) + 2);
    expect(frameByCellText(editor)).toEqual({
      H1: null, H2: null, H3: null, A1: null, A2: null, A3: null, B1: null, B2: null, B3: null,
    });

    selectRect(editor, [1, 1], [1, 1]);
    expect(frameByCellText(editor).A2).toBe('t b l r');

    editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize + 1);
    expect(frameByCellText(editor).A2).toBeNull();
  });
});
