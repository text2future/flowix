import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { afterEach, expect, it } from 'vitest';
import { createTablePlugin } from './table-plugin';
import { setTableBackground } from './table-background-commands';
import { reorderTable } from './table-reorder-commands';
import { setTableStyle } from './table-style-commands';

let editor: Editor;
afterEach(() => editor?.destroy());
function setup() {
  editor = new Editor({ extensions: [StarterKit, createTablePlugin(), Markdown],
    content: '<table><tr><th>A</th><th>B</th></tr><tr><td>C</td><td>D</td></tr><tr><td>E</td><td>F</td></tr></table>' });
  select(1, 1);
}
function select(row: number, column: number) {
  const table = editor.state.doc.firstChild!;
  const position = 1 + TableMap.get(table).map[row * 2 + column];
  editor.commands.setTextSelection(position + 2);
}
it('persists only color tokens, with independent clearing and undo', () => {
  setup();
  expect(setTableBackground(editor, 'row', 'yellow')).toBe(true);
  expect(setTableBackground(editor, 'column', 'blue')).toBe(true);
  const text = editor.getMarkdown();
  expect(text).toContain('"rowBackgrounds":[null,"yellow",null]');
  expect(text).toContain('"columnBackgrounds":[[0,1,"blue"],[1,1,"blue"],[2,1,"blue"]]');
  expect(text).not.toMatch(/#[\da-f]{3}|rgba?\(|oklch\(/i);
  editor.commands.setContent(text, { contentType: 'markdown' });
  expect(editor.state.doc.firstChild!.child(1).attrs.rowBackground).toBe('yellow');
  editor.state.doc.firstChild!.forEach(row => expect(row.child(1).attrs.columnBackground).toBe('blue'));
  select(1, 1);
  setTableBackground(editor, 'row', null);
  expect(editor.state.doc.firstChild!.child(1).attrs.rowBackground).toBeNull();
  editor.commands.undo();
  expect(editor.state.doc.firstChild!.child(1).attrs.rowBackground).toBe('yellow');
});
it('keeps backgrounds through theme changes, insertion and ordering', () => {
  setup();
  setTableBackground(editor, 'row', 'green');
  setTableBackground(editor, 'column', 'pink');
  setTableStyle(editor, 'business-blue');
  expect(editor.state.doc.firstChild!.child(1).attrs.rowBackground).toBe('green');
  editor.commands.addRowAfter();
  expect(editor.state.doc.firstChild!.child(2).attrs.rowBackground).toBeNull();
  expect(editor.state.doc.firstChild!.child(2).child(1).attrs.columnBackground).toBe('pink');
  expect(reorderTable(editor.view, 0, 'column', 1, 0)).toBe(true);
  editor.state.doc.firstChild!.forEach(row => expect(row.child(0).attrs.columnBackground).toBe('pink'));
  expect(reorderTable(editor.view, 0, 'row', 1, 2)).toBe(true);
  expect(editor.state.doc.firstChild!.child(2).attrs.rowBackground).toBe('green');
});
it('colors whole selected axes, supports merged HTML and read-only guards', () => {
  setup();
  const table = editor.state.doc.firstChild!;
  const map = TableMap.get(table);
  editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, 1 + map.map[2], 1 + map.map[5])));
  setTableBackground(editor, 'row', 'cyan');
  expect(editor.state.doc.firstChild!.child(1).attrs.rowBackground).toBe('cyan');
  expect(editor.state.doc.firstChild!.child(2).attrs.rowBackground).toBe('cyan');
  editor.setEditable(false);
  expect(setTableBackground(editor, 'row', 'red')).toBe(false);
  editor.setEditable(true);
  editor.commands.setContent('<table><tr><td colspan="2">merged</td></tr><tr><td>A</td><td>B</td></tr></table>');
  editor.commands.setTextSelection(4);
  setTableBackground(editor, 'row', 'orange');
  setTableBackground(editor, 'column', 'purple');
  const html = editor.getMarkdown();
  expect(html).toContain('data-flowix-row-background="orange"');
  expect(html).toContain('data-flowix-column-background="purple"');
  editor.commands.setContent(html, { contentType: 'markdown' });
  expect(editor.state.doc.firstChild!.firstChild!.attrs.rowBackground).toBe('orange');
  expect(editor.state.doc.firstChild!.firstChild!.firstChild!.attrs.columnBackground).toBe('purple');
});
