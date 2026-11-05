import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, expect, it } from 'vitest';
import { createTablePlugin } from './table-plugin';
import { canReorderTable, reorderTable } from './table-reorder-commands';

let editor: Editor;
afterEach(() => editor?.destroy());
function setup() {
  editor = new Editor({ extensions: [StarterKit, createTablePlugin()], content: {
    type: 'doc', content: [{ type: 'table', attrs: { styleId: 'comparison', comparisonColumn: 1 }, content:
      Array.from({ length: 3 }, (_, r) => ({ type: 'tableRow', attrs: { role: r === 2 ? 'total' : null }, content:
        Array.from({ length: 3 }, (_, c) => ({ type: r === 0 ? 'tableHeader' : 'tableCell', attrs: { colwidth: [100 + c * 50] }, content: [{ type: 'paragraph', content: [{ type: 'text', text: `${r}:${c}` }] }] })),
      })),
    }],
  } });
  return editor.view;
}
it('moves columns with widths and highlighted identity, and supports undo/redo', () => {
  const view = setup();
  const before = editor.state.doc.firstChild!.toJSON();
  expect(reorderTable(view, 0, 'column', 1, 2)).toBe(true);
  const table = editor.state.doc.firstChild!;
  expect(table.firstChild!.textContent).toBe('0:00:20:1');
  expect(table.firstChild!.child(2).attrs.colwidth).toEqual([150]);
  expect(table.attrs.comparisonColumn).toBe(2);
  expect(editor.commands.undo()).toBe(true);
  expect(editor.state.doc.firstChild!.toJSON()).toEqual(before);
  editor.commands.redo();
  expect(editor.state.doc.firstChild!.attrs.comparisonColumn).toBe(2);
});
it('moves a row with its role while keeping header semantics at the top', () => {
  const view = setup();
  expect(reorderTable(view, 0, 'row', 2, 0)).toBe(true);
  const table = editor.state.doc.firstChild!;
  expect(table.firstChild!.textContent).toBe('2:02:12:2');
  expect(table.firstChild!.attrs.role).toBe('total');
  expect(table.firstChild!.firstChild!.type.name).toBe('tableHeader');
  expect(table.child(1).firstChild!.type.name).toBe('tableCell');
});
it('rejects no-op, invalid, read-only and merged table moves', () => {
  const view = setup();
  expect(reorderTable(view, 0, 'row', 0, 0)).toBe(false);
  expect(reorderTable(view, 0, 'column', -1, 2)).toBe(false);
  editor.setEditable(false);
  expect(reorderTable(view, 0, 'row', 0, 1)).toBe(false);
  editor.setEditable(true);
  editor.commands.setContent('<table><tr><td colspan="2">merged</td></tr><tr><td>a</td><td>b</td></tr></table>');
  expect(canReorderTable(editor.state.doc.firstChild!)).toBe(false);
  expect(reorderTable(view, 0, 'row', 0, 1)).toBe(false);
});
it('keeps the header column at the left while moving its content and preserves cell formatting', () => {
  const view = setup();
  // Use schema content to make the header-column mode explicit.
  editor.commands.setContent('<table><tr><th>A</th><th>B</th></tr><tr><th><p><strong>C</strong></p></th><td>D</td></tr></table>');
  expect(reorderTable(view, 0, 'column', 0, 1)).toBe(true);
  const row = editor.state.doc.firstChild!.child(1);
  expect(row.child(0).type.name).toBe('tableHeader');
  expect(row.child(1).type.name).toBe('tableCell');
  expect(row.child(1).textContent).toBe('C');
  expect(row.child(1).firstChild!.firstChild!.marks[0].type.name).toBe('bold');
});

it('moves the visible comparison column when a saved index exceeds the current width', () => {
  const view = setup();
  view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, {
    ...editor.state.doc.firstChild!.attrs, comparisonColumn: 99,
  }));
  expect(reorderTable(view, 0, 'column', 2, 0)).toBe(true);
  expect(editor.state.doc.firstChild!.attrs.comparisonColumn).toBe(0);
  expect(editor.state.doc.firstChild!.firstChild!.firstChild!.textContent).toBe('0:2');
});

it('rejects invalid command coordinates without changing the document', () => {
  const view = setup();
  const before = editor.state.doc;
  for (const pos of [-1, 0.5, NaN, editor.state.doc.content.size + 1]) {
    expect(reorderTable(view, pos, 'column', 0, 1)).toBe(false);
  }
  for (const to of [0.5, NaN, Infinity]) {
    expect(reorderTable(view, 0, 'column', 0, to)).toBe(false);
  }
  expect(editor.state.doc).toBe(before);
});
