import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { CellSelection } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it } from 'vitest';
import { createTableTemplate } from './table-templates';
import { createTablePlugin } from './table-plugin';
import { getBorderExtendsHint, getTablePresentationSelection, setTableCellBorder, setTableColumnRole, setTableRowRole, setTableStyle } from './table-style-commands';

const editors: Editor[] = [];
const table: JSONContent = {
  type: 'table', content: ['项目|附注|本期|上期', '收入|5|25,500|21,000', '成本|6|(9,700)|(7,800)']
    .map((row, index) => ({
      type: 'tableRow', content: row.split('|').map((text) => ({
        type: index === 0 ? 'tableHeader' : 'tableCell',
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      })),
    })),
};

function createEditor() {
  const editor = new Editor({
    extensions: [StarterKit, createTablePlugin(), Markdown],
    content: { type: 'doc', content: [table, { type: 'paragraph' }, table] },
  });
  editors.push(editor);
  return editor;
}

function cellPosition(editor: Editor, row: number, column: number): number {
  const firstTable = editor.state.doc.firstChild!;
  let position = 1;
  for (let index = 0; index < row; index += 1) position += firstTable.child(index).nodeSize;
  position += 1;
  for (let index = 0; index < column; index += 1) position += firstTable.child(row).child(index).nodeSize;
  return position;
}

afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

describe('table presentation commands', () => {
  it('fills a blank table with the selected localized template and restores it with undo/redo', () => {
    const editor = createEditor();
    editor.commands.setContent({ type: 'doc', content: [createTableTemplate('default'), { type: 'paragraph' }, table] });
    editor.commands.setTextSelection(cellPosition(editor, 2, 2) + 2);
    const original = editor.getJSON();
    expect(setTableStyle(editor, 'financial-brief', 'en-US')).toBe(true);
    expect(editor.state.doc.firstChild!.eq(editor.schema.nodeFromJSON(createTableTemplate('financial-brief', 'en-US')))).toBe(true);
    expect(editor.state.doc.child(2).toJSON()).toEqual(original.content![2]);
    expect(editor.state.selection.$from.parent.content.size).toBe(0);
    expect(editor.isActive('table')).toBe(true);
    const populated = editor.getJSON();
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(original);
    editor.commands.redo();
    expect(editor.getJSON()).toEqual(populated);
    const text = editor.state.doc.textContent;
    setTableStyle(editor, 'hk-financial');
    expect(editor.state.doc.textContent).toBe(text);
    const saved = editor.getJSON();
    editor.commands.setContent(editor.getMarkdown(), { contentType: 'markdown' });
    expect(editor.getJSON().content!.filter(node => node.type === 'table'))
      .toEqual(saved.content!.filter(node => node.type === 'table'));
  });

  it('preserves an empty grid when switching between themes without template content', () => {
    const editor = createEditor();
    editor.commands.setContent({ type: 'doc', content: [createTableTemplate('default')] });
    editor.commands.setTextSelection(cellPosition(editor, 1, 1) + 2);
    for (const style of ['striped', 'business-blue', 'comparison'] as const) {
      expect(setTableStyle(editor, style)).toBe(true);
      expect(editor.state.doc.firstChild!.childCount).toBe(3);
      expect(editor.state.doc.firstChild!.firstChild!.childCount).toBe(3);
      expect(editor.state.doc.textContent).toBe('');
    }
  });

  it('treats non-text cell content as populated and respects read-only editors', () => {
    const editor = createEditor();
    const grid = createTableTemplate('default');
    grid.content![1].content![1].content = [{ type: 'paragraph', content: [{ type: 'hardBreak' }] }];
    editor.commands.setContent({ type: 'doc', content: [grid] });
    editor.commands.setTextSelection(cellPosition(editor, 1, 1) + 2);
    const expected = editor.getJSON();
    expected.content![0].attrs!.styleId = 'financial-brief';
    expect(setTableStyle(editor, 'financial-brief')).toBe(true);
    expect(editor.getJSON()).toEqual(expected);
    editor.setEditable(false);
    expect(setTableStyle(editor, 'hk-financial')).toBe(false);
    expect(editor.getJSON()).toEqual(expected);
  });

  it('changes only the current table, preserving text and supporting undo', () => {
    const editor = createEditor();
    const text = editor.state.doc.textContent;
    editor.commands.setTextSelection(cellPosition(editor, 1, 2) + 2);
    expect(setTableStyle(editor, 'hk-financial')).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.styleId).toBe('hk-financial');
    expect(editor.state.doc.child(2).attrs.styleId).toBe('default');
    expect(editor.state.doc.textContent).toBe(text);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.styleId).toBe('default');
  });

  it('keeps a total attached to its row after inserting and deleting preceding rows', () => {
    const editor = createEditor();
    editor.commands.setTextSelection(cellPosition(editor, 2, 2) + 2);
    setTableRowRole(editor, 'total');
    editor.commands.addRowBefore();
    expect(editor.state.doc.firstChild?.child(3).attrs.role).toBe('total');
    expect(editor.state.doc.firstChild?.child(2).attrs.role).toBe('body');
    editor.commands.setTextSelection(cellPosition(editor, 2, 0) + 2);
    editor.commands.deleteRow();
    expect(editor.state.doc.firstChild?.child(2).attrs.role).toBe('total');
  });

  it('formats an entire amount column and preserves it after deleting a preceding column', () => {
    const editor = createEditor();
    editor.commands.setTextSelection(cellPosition(editor, 1, 2) + 2);
    setTableColumnRole(editor, 'amount');
    editor.state.doc.firstChild!.forEach((row) => {
      expect(row.child(2).attrs.columnRole).toBe('amount');
      expect(row.child(3).attrs.columnRole).toBe('default');
    });
    editor.commands.setTextSelection(cellPosition(editor, 1, 1) + 2);
    editor.commands.deleteColumn();
    expect(editor.state.doc.firstChild?.child(2).child(1).attrs.columnRole).toBe('amount');
    expect(editor.state.doc.firstChild?.child(2).child(1).textContent).toBe('(9,700)');
  });

  it('supports multi-cell row and column selections', () => {
    const editor = createEditor();
    const selection = CellSelection.create(editor.state.doc, cellPosition(editor, 1, 2), cellPosition(editor, 2, 3));
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    setTableRowRole(editor, 'subtotal');
    setTableColumnRole(editor, 'amount');
    expect(editor.state.doc.firstChild?.child(0).attrs.role).toBe('body');
    for (const row of [1, 2]) expect(editor.state.doc.firstChild?.child(row).attrs.role).toBe('subtotal');
    editor.state.doc.firstChild!.forEach((row) => {
      for (const column of [2, 3]) expect(row.child(column).attrs.columnRole).toBe('amount');
    });
  });

  it('does nothing outside tables', () => {
    const editor = createEditor();
    editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize + 1);
    const original = editor.getJSON();
    expect(setTableStyle(editor, 'three-line')).toBe(false);
    expect(setTableRowRole(editor, 'group')).toBe(false);
    expect(setTableColumnRole(editor, 'note')).toBe(false);
    expect(editor.getJSON()).toEqual(original);
  });

  it('shows mixed selections so an existing role can be applied to the whole selection', () => {
    const editor = createEditor();
    editor.commands.setTextSelection(cellPosition(editor, 1, 2) + 2);
    setTableRowRole(editor, 'total');
    setTableColumnRole(editor, 'amount');
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(
      editor.state.doc, cellPosition(editor, 1, 2), cellPosition(editor, 2, 3),
    )));
    expect(getTablePresentationSelection(editor)).toMatchObject({ style: 'default', row: 'mixed', column: 'mixed' });
    setTableRowRole(editor, 'total');
    setTableColumnRole(editor, 'amount');
    expect(getTablePresentationSelection(editor)).toMatchObject({ style: 'default', row: 'total', column: 'amount' });
  });
});

describe('cell border commands', () => {
  it('changes one edge and its shared neighbor without changing text, roles, or other tables', () => {
    const editor = createEditor();
    const text = editor.state.doc.textContent;
    editor.commands.setTextSelection(cellPosition(editor, 1, 2) + 2);
    setTableStyle(editor, 'hk-financial');
    setTableRowRole(editor, 'subtotal');
    setTableColumnRole(editor, 'amount');
    expect(setTableCellBorder(editor, 'top', 'double')).toBe(true);
    const first = editor.state.doc.firstChild!;
    expect(first.child(1).child(2).attrs).toMatchObject({ borderTop: 'double', borderBottom: 'auto', columnRole: 'amount' });
    expect(first.child(0).child(2).attrs.borderBottom).toBe('double');
    expect(first.child(1).attrs.role).toBe('subtotal');
    expect(first.child(1).child(3).attrs.borderTop).toBe('auto');
    expect(editor.state.doc.child(2).child(1).child(2).attrs.borderTop).toBe('auto');
    expect(editor.state.doc.textContent).toBe(text);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.firstChild?.child(1).child(2).attrs.borderTop).toBe('auto');
    expect(editor.state.doc.firstChild?.child(0).child(2).attrs.borderBottom).toBe('auto');
    expect(editor.state.doc.firstChild?.attrs.styleId).toBe('hk-financial');
    expect(editor.commands.redo()).toBe(true);
    expect(editor.state.doc.firstChild?.child(1).child(2).attrs.borderTop).toBe('double');
  });

  it('can remove a shared edge, redraw it from the other cell, and restore both template edges', () => {
    const editor = createEditor();
    editor.commands.setTextSelection(cellPosition(editor, 1, 2) + 2);
    setTableCellBorder(editor, 'bottom', 'none');
    expect(editor.state.doc.firstChild?.child(2).child(2).attrs.borderTop).toBe('none');
    editor.commands.setTextSelection(cellPosition(editor, 2, 2) + 2);
    setTableCellBorder(editor, 'top', 'single');
    expect(editor.state.doc.firstChild?.child(1).child(2).attrs.borderBottom).toBe('single');
    expect(editor.state.doc.firstChild?.child(2).child(2).attrs.borderTop).toBe('single');
    setTableCellBorder(editor, 'top', 'auto');
    expect(editor.state.doc.firstChild?.child(1).child(2).attrs.borderBottom).toBe('auto');
    expect(editor.state.doc.firstChild?.child(2).child(2).attrs.borderTop).toBe('auto');
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.firstChild?.child(2).child(2).attrs.borderTop).toBe('single');
  });

  it('applies to each selected cell and reports mixed borders before unifying them', () => {
    const editor = createEditor();
    editor.commands.setTextSelection(cellPosition(editor, 1, 2) + 2);
    setTableCellBorder(editor, 'bottom', 'single');
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(
      editor.state.doc, cellPosition(editor, 1, 2), cellPosition(editor, 2, 3),
    )));
    expect(getTablePresentationSelection(editor)).toMatchObject({ borderBottom: 'mixed' });
    setTableCellBorder(editor, 'bottom', 'double');
    for (const row of [1, 2]) {
      for (const column of [2, 3]) expect(editor.state.doc.firstChild?.child(row).child(column).attrs.borderBottom).toBe('double');
      expect(editor.state.doc.firstChild?.child(row).child(1).attrs.borderBottom).toBe('auto');
    }
    expect(editor.state.selection).toBeInstanceOf(CellSelection);
    expect(getTablePresentationSelection(editor)).toMatchObject({ borderBottom: 'double' });
  });

  it('handles a merged cell and all neighbors along its full width', () => {
    const editor = createEditor();
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(
      editor.state.doc, cellPosition(editor, 1, 1), cellPosition(editor, 1, 2),
    )));
    editor.commands.mergeCells();
    setTableCellBorder(editor, 'bottom', 'double');
    expect(editor.state.doc.firstChild?.child(1).child(1).attrs).toMatchObject({ colspan: 2, borderBottom: 'double' });
    for (const column of [1, 2]) expect(editor.state.doc.firstChild?.child(2).child(column).attrs.borderTop).toBe('double');
    expect(editor.state.doc.firstChild?.child(2).child(3).attrs.borderTop).toBe('auto');
  });

  it('keeps manual borders attached to existing cells when rows and columns are inserted', () => {
    const editor = createEditor();
    editor.commands.setTextSelection(cellPosition(editor, 2, 2) + 2);
    setTableCellBorder(editor, 'bottom', 'double');
    editor.commands.addRowBefore();
    editor.commands.addColumnBefore();
    expect(editor.state.doc.firstChild?.child(3).child(3).attrs.borderBottom).toBe('double');
    expect(editor.state.doc.firstChild?.child(2).child(3).attrs.borderBottom).toBe('auto');
    expect(editor.state.doc.firstChild?.child(3).child(2).attrs.borderBottom).toBe('auto');
  });

  it('unifies the complete shared edge when an adjoining merged cell is wider than the selection', () => {
    const editor = createEditor();
    editor.commands.setTextSelection(cellPosition(editor, 1, 2) + 2);
    setTableCellBorder(editor, 'bottom', 'none');
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(
      editor.state.doc, cellPosition(editor, 2, 1), cellPosition(editor, 2, 2),
    )));
    editor.commands.mergeCells();
    editor.commands.setTextSelection(cellPosition(editor, 1, 1) + 2);
    expect(getTablePresentationSelection(editor)).toMatchObject({ rowHeader: true });
    expect(getBorderExtendsHint(editor, 'bottom')).toBe(true);
    expect(getBorderExtendsHint(editor, 'top')).toBe(false);
    setTableCellBorder(editor, 'bottom', 'single');
    for (const column of [1, 2]) expect(editor.state.doc.firstChild?.child(1).child(column).attrs.borderBottom).toBe('single');
    expect(editor.state.doc.firstChild?.child(2).child(1).attrs).toMatchObject({ colspan: 2, borderTop: 'single' });
    expect(editor.state.doc.firstChild?.child(1).child(3).attrs.borderBottom).toBe('auto');
    setTableCellBorder(editor, 'bottom', 'auto');
    for (const column of [1, 2]) expect(editor.state.doc.firstChild?.child(1).child(column).attrs.borderBottom).toBe('auto');
    expect(editor.state.doc.firstChild?.child(2).child(1).attrs.borderTop).toBe('auto');
  });

  it('uses the actual bottom of a cell spanning rows', () => {
    const editor = createEditor();
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(
      editor.state.doc, cellPosition(editor, 0, 2), cellPosition(editor, 1, 2),
    )));
    editor.commands.mergeCells();
    setTableCellBorder(editor, 'bottom', 'double');
    expect(editor.state.doc.firstChild?.child(0).child(2).attrs).toMatchObject({ rowspan: 2, borderBottom: 'double' });
    expect(editor.state.doc.firstChild?.child(2).child(2).attrs.borderTop).toBe('double');
    expect(editor.state.doc.firstChild?.child(1).child(2).attrs.borderTop).toBe('auto');
  });

  it('follows shared edges through staggered merged cells on both sides', () => {
    const editor = createEditor();
    for (const [row, left, right] of [[1, 2, 3], [1, 0, 1], [2, 1, 2]]) {
      editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(
        editor.state.doc, cellPosition(editor, row, left), cellPosition(editor, row, right),
      )));
      editor.commands.mergeCells();
    }
    editor.commands.setTextSelection(cellPosition(editor, 2, 0) + 2);
    expect(getBorderExtendsHint(editor, 'top')).toBe(true);
    setTableCellBorder(editor, 'top', 'double');
    const first = editor.state.doc.firstChild!;
    first.child(1).forEach(cell => expect(cell.attrs.borderBottom).toBe('double'));
    first.child(2).forEach(cell => expect(cell.attrs.borderTop).toBe('double'));
    first.child(0).forEach(cell => expect(cell.attrs.borderBottom).toBe('auto'));
  });

  it('does not mutate a read-only editor or a selection outside a table', () => {
    const editor = createEditor();
    editor.commands.setTextSelection(cellPosition(editor, 1, 1) + 2);
    const original = editor.getJSON();
    editor.setEditable(false);
    expect(setTableCellBorder(editor, 'top', 'none')).toBe(false);
    expect(editor.getJSON()).toEqual(original);
    editor.setEditable(true);
    editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize + 1);
    expect(setTableCellBorder(editor, 'bottom', 'double')).toBe(false);
    expect(editor.getJSON()).toEqual(original);
    editor.destroy();
    expect(setTableCellBorder(editor, 'top', 'single')).toBe(false);
  });
});
