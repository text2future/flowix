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

  it('leaves default and tables with fewer than three columns unmarked', () => {
    expect(markedCells(createEditor('default'))).toHaveLength(0);
    expect(markedCells(createEditor('comparison', 2))).toHaveLength(0);
  });
});
