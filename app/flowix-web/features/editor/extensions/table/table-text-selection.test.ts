import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTablePlugin } from './table-plugin';

const editors: Editor[] = [];

function createEditor() {
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit, createTablePlugin()],
    content: '<table><tr><th>Head</th><th>Value</th></tr><tr><td>Alpha</td><td>Beta</td></tr></table><p>After</p>',
  });
  editors.push(editor);
  return editor;
}

function cellPosition(editor: Editor, row: number, column: number) {
  const table = editor.state.doc.firstChild!;
  const map = TableMap.get(table);
  return 1 + map.map[row * map.width + column];
}

afterEach(() => {
  editors.splice(0).forEach(editor => {
    const element = editor.options.element as HTMLElement;
    editor.destroy();
    element.remove();
  });
  vi.restoreAllMocks();
});

describe('triple click in table text', () => {
  function tripleClick(editor: Editor, nodePos: number) {
    const node = editor.state.doc.nodeAt(nodePos)!;
    return editor.view.someProp('handleTripleClickOn', handler => handler(
      editor.view, nodePos + 2, node, nodePos, new MouseEvent('mousedown', { button: 0, detail: 3 }), true,
    ));
  }

  it.each([0, 1])('selects the paragraph text in row %s rather than a CellSelection', row => {
    const editor = createEditor();
    const position = cellPosition(editor, row, 0) + 1;
    expect(tripleClick(editor, position)).toBe(true);
    expect(editor.state.selection).not.toBeInstanceOf(CellSelection);
    expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe(row === 0 ? 'Head' : 'Alpha');
    expect(editor.view.dom.querySelector('.selectedCell')).toBeNull();
  });

  it('selects only the clicked paragraph in a cell containing multiple paragraphs', () => {
    const editor = createEditor();
    editor.commands.setContent('<table><tr><td><p>First paragraph</p><p>Second paragraph</p></td></tr></table>');
    const position = cellPosition(editor, 0, 0) + 1 + editor.state.doc.firstChild!.firstChild!.firstChild!.firstChild!.nodeSize;
    expect(tripleClick(editor, position)).toBe(true);
    expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe('Second paragraph');
  });

  it('leaves ordinary paragraph triple click to the editor default', () => {
    const editor = createEditor();
    expect(tripleClick(editor, editor.state.doc.firstChild!.nodeSize)).toBeUndefined();
  });
});

it('does not select the whole cell when triple clicking its padding', () => {
  const editor = createEditor();
  const nodePos = cellPosition(editor, 1, 0);
  const node = editor.state.doc.nodeAt(nodePos)!;
  const handled = editor.view.someProp('handleTripleClickOn', handler => handler(
    editor.view, nodePos + 1, node, nodePos, new MouseEvent('mousedown', { button: 0, detail: 3 }), true,
  ));
  expect(handled).toBe(true);
  expect(editor.state.selection).toBeInstanceOf(TextSelection);
  expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe('Alpha');
});
