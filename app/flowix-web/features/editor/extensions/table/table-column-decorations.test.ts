import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it } from 'vitest';
import { createTablePlugin } from './table-plugin';
import { setTableStyle } from './table-style-commands';
import type { TableStyleId } from './table-presentation';

const editors: Editor[] = [];

function createEditor(styleId: TableStyleId = 'comparison', columns = 4) {
  const table: JSONContent = {
    type: 'table', attrs: { styleId },
    content: Array.from({ length: 3 }, (_, row) => ({
      type: 'tableRow',
      content: Array.from({ length: columns }, (_, column) => ({
        type: row === 0 ? 'tableHeader' : 'tableCell',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: `${row}:${column}` }] }],
      })),
    })),
  };
  const editor = new Editor({
    extensions: [StarterKit, createTablePlugin(), Markdown],
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'before' }] }, table, { type: 'paragraph' }] },
  });
  editors.push(editor);
  return editor;
}

function cellPosition(editor: Editor, row: number, column: number): number {
  const table = editor.state.doc.child(1);
  const map = TableMap.get(table);
  return editor.state.doc.child(0).nodeSize + 1 + map.map[row * map.width + column];
}

function markedCells(editor: Editor): HTMLTableCellElement[] {
  return Array.from(editor.view.dom.querySelectorAll<HTMLTableCellElement>('[data-flowix-comparison-column]'));
}

function merge(editor: Editor, fromRow: number, fromColumn: number, toRow: number, toColumn: number) {
  editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(
    editor.state.doc, cellPosition(editor, fromRow, fromColumn), cellPosition(editor, toRow, toColumn),
  )));
  expect(editor.commands.mergeCells()).toBe(true);
}

afterEach(() => editors.splice(0).forEach(editor => editor.destroy()));

describe('comparison table column decorations', () => {
  it.each([0, 1, 3])('emphasizes the focused column %i and restores it after saving', column => {
    const editor = createEditor('default');
    const text = editor.state.doc.textContent;
    editor.commands.setTextSelection(cellPosition(editor, 1, column) + 2);
    setTableStyle(editor, 'comparison');
    expect(markedCells(editor).map(cell => cell.textContent)).toEqual([`0:${column}`, `1:${column}`, `2:${column}`]);
    expect(editor.state.doc.textContent).toBe(text);
    const original = editor.getJSON();
    const markdown = editor.getMarkdown();
    expect(markdown).toContain(`"comparisonColumn":${column}`);
    editor.commands.setContent(markdown, { contentType: 'markdown' });
    expect(editor.getJSON()).toEqual(original);
    expect(markedCells(editor).map(cell => cell.textContent)).toEqual([`0:${column}`, `1:${column}`, `2:${column}`]);
    const html = editor.getHTML();
    expect(html).toContain(`data-flowix-emphasis-column="${column}"`);
    editor.commands.setContent(html, { contentType: 'html' });
    expect(markedCells(editor).map(cell => cell.textContent)).toEqual([`0:${column}`, `1:${column}`, `2:${column}`]);
  });

  it('uses the leftmost selected column even when the selection is made in reverse', () => {
    const editor = createEditor('default');
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(
      editor.state.doc, cellPosition(editor, 2, 3), cellPosition(editor, 1, 1),
    )));
    setTableStyle(editor, 'comparison');
    expect(markedCells(editor).map(cell => cell.textContent)).toEqual(['0:1', '1:1', '2:1']);
    editor.commands.setTextSelection(cellPosition(editor, 1, 0) + 2);
    expect(markedCells(editor).map(cell => cell.textContent)).toEqual(['0:1', '1:1', '2:1']);
    setTableStyle(editor, 'comparison');
    expect(markedCells(editor).map(cell => cell.textContent)).toEqual(['0:0', '1:0', '2:0']);
  });

  it('supports applying emphasis in a two-column table and undoing the change', () => {
    const editor = createEditor('default', 2);
    const original = editor.getJSON();
    editor.commands.setTextSelection(cellPosition(editor, 1, 1) + 2);
    setTableStyle(editor, 'comparison');
    expect(markedCells(editor).map(cell => cell.textContent)).toEqual(['0:1', '1:1', '2:1']);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(original);
    expect(markedCells(editor)).toHaveLength(0);
  });

  it('marks the third logical column and keeps it there after preceding cells merge', () => {
    const editor = createEditor();
    expect(markedCells(editor).map(cell => cell.textContent)).toEqual(['0:2', '1:2', '2:2']);
    merge(editor, 1, 0, 1, 1);
    const row = editor.view.dom.querySelectorAll('tr')[1];
    expect(row.children).toHaveLength(3);
    expect(row.children[1].hasAttribute('data-flowix-comparison-column')).toBe(true);
    expect(row.children[2].hasAttribute('data-flowix-comparison-column')).toBe(false);
    expect(markedCells(editor).map(cell => cell.textContent)).toEqual(['0:2', '1:2', '2:2']);
  });

  it('marks an entire colspan cell when it covers the comparison column', () => {
    const editor = createEditor();
    merge(editor, 1, 1, 1, 2);
    const marked = markedCells(editor)[1];
    expect(marked.colSpan).toBe(2);
    expect(marked.textContent).toBe('1:11:2');
    expect(marked.nextElementSibling?.hasAttribute('data-flowix-comparison-column')).toBe(false);
  });

  it('uses actual rowspan bounds for the first and last edge markers', () => {
    const editor = createEditor();
    merge(editor, 1, 2, 2, 2);
    const cells = markedCells(editor);
    expect(cells).toHaveLength(2);
    expect(cells[0].hasAttribute('data-flowix-comparison-first')).toBe(true);
    expect(cells[0].hasAttribute('data-flowix-comparison-last')).toBe(false);
    expect(cells[1].rowSpan).toBe(2);
    expect(cells[1].hasAttribute('data-flowix-comparison-first')).toBe(false);
    expect(cells[1].hasAttribute('data-flowix-comparison-last')).toBe(true);
    merge(editor, 0, 2, 2, 2);
    expect(markedCells(editor)).toHaveLength(1);
    expect(markedCells(editor)[0].hasAttribute('data-flowix-comparison-first')).toBe(true);
    expect(markedCells(editor)[0].hasAttribute('data-flowix-comparison-last')).toBe(true);
  });

  it('updates style changes and recreates markers after saving without persisting decoration attributes', () => {
    const editor = createEditor();
    merge(editor, 1, 0, 1, 1);
    const original = editor.getJSON();
    const markdown = editor.getMarkdown();
    expect(markdown).not.toContain('data-flowix-comparison');
    expect(editor.getHTML()).not.toContain('data-flowix-comparison');
    expect(JSON.stringify(original)).not.toContain('data-flowix-comparison');
    editor.commands.setContent(markdown, { contentType: 'markdown' });
    expect(editor.getJSON()).toEqual(original);
    expect(markedCells(editor).map(cell => cell.textContent)).toEqual(['0:2', '1:2', '2:2']);
    editor.commands.setTextSelection(cellPosition(editor, 1, 2) + 2);
    setTableStyle(editor, 'striped');
    expect(markedCells(editor)).toHaveLength(0);
    setTableStyle(editor, 'comparison');
    expect(markedCells(editor)).toHaveLength(3);
    setTableStyle(editor, 'default');
    expect(markedCells(editor)).toHaveLength(0);
  });

  it('keeps cached markers aligned when content above the table moves it', () => {
    const editor = createEditor();
    const before = markedCells(editor).map(cell => cell.textContent);
    // The decorations for an untouched table are reused; only their offset moves.
    editor.view.dispatch(editor.state.tr.insertText('新增前文', 1));
    expect(editor.state.doc.textContent).toContain('新增前文');
    expect(markedCells(editor).map(cell => cell.textContent)).toEqual(before);
    const row = editor.view.dom.querySelectorAll('tr')[1];
    expect(row.children[2].hasAttribute('data-flowix-comparison-column')).toBe(true);
    expect(row.children[1].hasAttribute('data-flowix-comparison-column')).toBe(false);
  });

  it('recomputes markers when the comparison table itself changes', () => {
    const editor = createEditor();
    editor.commands.setTextSelection(cellPosition(editor, 2, 2) + 2);
    editor.commands.addRowAfter();
    expect(markedCells(editor)).toHaveLength(4);
  });

  it('leaves default and tables with fewer than three columns unmarked', () => {
    expect(markedCells(createEditor('default'))).toHaveLength(0);
    expect(markedCells(createEditor('comparison', 2))).toHaveLength(0);
  });
});
