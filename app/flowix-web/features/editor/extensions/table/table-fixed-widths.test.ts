import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { closeHistory } from '@tiptap/pm/history';
import { afterEach, expect, it } from 'vitest';
import { createTablePlugin } from './table-plugin';
import { equalTableWidths } from './table-fixed-widths';
import { insertTableTemplate } from './table-templates';

const editors: Editor[] = [];
function setup(editable = true) {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({ element, editable, extensions: [StarterKit, Markdown, createTablePlugin()], content: '<p></p>' });
  Object.defineProperty(editor.view.dom, 'clientWidth', { configurable: true, value: 800 });
  editors.push(editor);
  return editor;
}
function widths(editor: Editor) {
  return editor.state.doc.firstChild!.firstChild!.content.content.map(cell => cell.attrs.colwidth);
}
afterEach(() => editors.splice(0).forEach(editor => { const element = editor.options.element as HTMLElement; editor.destroy(); element.remove(); }));

it('distributes integer pixels and respects the minimum width', () => {
  expect(equalTableWidths(800, 3)).toEqual([267, 267, 266]);
  expect(equalTableWidths(100, 3)).toEqual([80, 80, 80]);
});
it('freezes template widths, inherits inserted columns and round trips Markdown', () => {
  const editor = setup();
  expect(insertTableTemplate(editor, 'default')).toBe(true);
  expect(widths(editor)).toEqual([[267], [267], [266]]);
  Object.defineProperty(editor.view.dom, 'clientWidth', { value: 500 });
  editor.commands.insertContent('text');
  expect(widths(editor)).toEqual([[267], [267], [266]]);
  editor.commands.addColumnAfter();
  expect(widths(editor)).toEqual([[267], [267], [267], [266]]);
  editor.commands.deleteColumn();
  expect(widths(editor)).toEqual([[267], [267], [266]]);
  const markdown = editor.getMarkdown();
  const restored = setup();
  restored.commands.setContent(markdown, { contentType: 'markdown' });
  expect(widths(restored)).toEqual(widths(editor));
});
it('initializes the standard insertTable command in the same transaction', () => {
  const editor = setup();
  editor.commands.insertTable({ rows: 2, cols: 3 });
  expect(widths(editor)).toEqual([[267], [267], [266]]);
  editor.commands.undo();
  expect(editor.state.doc.firstChild!.type.name).toBe('paragraph');
});
it('does not write missing widths in a read-only editor', () => {
  const editor = setup(false);
  editor.commands.setContent('<table><tr><td>a</td><td>b</td></tr></table>');
  expect(widths(editor)).toEqual([null, null]);
});
it('preserves other column widths on resize and across merge/split', () => {
  const editor = setup();
  editor.commands.insertTable({ rows: 2, cols: 3 });
  const tr = editor.state.tr;
  const table = tr.doc.firstChild!;
  let rowOffset = 1;
  table.forEach(row => {
    tr.setNodeMarkup(rowOffset + 1, undefined, { ...row.firstChild!.attrs, colwidth: [320] });
    rowOffset += row.nodeSize;
  });
  editor.view.dispatch(tr);
  expect(widths(editor)).toEqual([[320], [267], [266]]);
  editor.commands.setCellSelection({ anchorCell: 2, headCell: 6 });
  expect(editor.commands.mergeCells()).toBe(true);
  expect(widths(editor)[0]).toEqual([320, 267]);
  expect(editor.commands.splitCell()).toBe(true);
  expect(widths(editor)).toEqual([[320], [267], [266]]);
});
it('defers hidden tables and initializes once the editable content is measurable', async () => {
  const editor = setup();
  Object.defineProperty(editor.view.dom, 'clientWidth', { value: 0 });
  editor.commands.insertTable({ rows: 2, cols: 3 });
  expect(widths(editor)).toEqual([null, null, null]);
  Object.defineProperty(editor.view.dom, 'clientWidth', { value: 600 });
  editor.commands.setTextSelection(editor.state.selection.from);
  await expect.poll(() => widths(editor)).toEqual([[200], [200], [200]]);
  Object.defineProperty(editor.view.dom, 'clientWidth', { value: 900 });
  editor.commands.setTextSelection(editor.state.selection.from);
  await new Promise(resolve => requestAnimationFrame(resolve));
  expect(widths(editor)).toEqual([[200], [200], [200]]);
});
it('initializes legacy tables after switching from read-only to editable', async () => {
  const editor = setup(false);
  editor.commands.setContent('<table><tr><td>a</td><td>b</td></tr></table>');
  expect(widths(editor)).toEqual([null, null]);
  editor.setEditable(true);
  await expect.poll(() => widths(editor)).toEqual([[400], [400]]);
});

it('defers newly inserted nested tables until their local DOM width is available', async () => {
  const editor = setup();
  editor.commands.setContent('<blockquote><table><tr><td>a</td><td>b</td></tr></table></blockquote>');
  const quote = editor.view.dom.querySelector('blockquote')!;
  Object.defineProperty(quote, 'clientWidth', { value: 400 });
  const localWidths = () => editor.state.doc.firstChild!.firstChild!.firstChild!.content.content.map(cell => cell.attrs.colwidth);
  await expect.poll(localWidths).toEqual([[200], [200]]);
});

it('does not measure unchanged fixed tables when editing a following paragraph', async () => {
  const editor = setup();
  editor.commands.insertTable({ rows: 2, cols: 3 });
  await new Promise(resolve => requestAnimationFrame(resolve));
  let reads = 0;
  Object.defineProperty(editor.view.dom, 'clientWidth', { get() { reads++; return 800; } });
  editor.commands.insertContentAt(editor.state.doc.content.size, '<p>Outside table</p>');
  await new Promise(resolve => requestAnimationFrame(resolve));
  expect(reads).toBe(0);
  expect(widths(editor)).toEqual([[267], [267], [266]]);
});

it('preserves specified widths when filling missing widths in an imported merged cell', async () => {
  const editor = setup();
  editor.commands.setContent('<table><tr><td colspan="2" colwidth="100,0">Merged</td></tr><tr><td>a</td><td>b</td></tr></table>');
  expect(editor.state.doc.firstChild!.firstChild!.firstChild!.attrs.colwidth).toEqual([100, 0]);
  Object.defineProperty(editor.view.dom.querySelector('td')!, 'offsetWidth', { value: 400 });
  await expect.poll(() => editor.state.doc.firstChild!.firstChild!.firstChild!.attrs.colwidth).toEqual([100, 300]);
  expect(editor.state.doc.firstChild!.lastChild!.content.content.map(cell => cell.attrs.colwidth)).toEqual([[100], [300]]);
});

it('undoes and redoes column insertion with its inherited width', () => {
  const editor = setup();
  editor.commands.insertTable({ rows: 2, cols: 3 });
  // A separate history event is necessary to test just the column insertion.
  editor.view.dispatch(closeHistory(editor.state.tr));
  const before = widths(editor);
  editor.commands.addColumnAfter();
  expect(widths(editor)).toEqual([[267], [267], [267], [266]]);
  // Widths are in the same appended transaction and must round-trip through redo.
  editor.commands.undo();
  expect(widths(editor)).toEqual(before);
  editor.commands.redo();
  expect(widths(editor)).toEqual([[267], [267], [267], [266]]);
  expect(before).toEqual([[267], [267], [266]]);
});
