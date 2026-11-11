import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
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

describe('editing cell marker', () => {
  it('follows the caret between header and body cells and clears outside the table', () => {
    const editor = createEditor();
    editor.commands.setTextSelection(cellPosition(editor, 0, 0) + 2);
    expect(editor.view.dom.querySelector('.table-editing-cell')?.textContent).toBe('Head');
    editor.commands.setTextSelection(cellPosition(editor, 1, 1) + 2);
    expect(editor.view.dom.querySelectorAll('.table-editing-cell')).toHaveLength(1);
    expect(editor.view.dom.querySelector('.table-editing-cell')?.textContent).toBe('Beta');
    editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize + 1);
    expect(editor.view.dom.querySelector('.table-editing-cell')).toBeNull();
  });

  it('supports text selection within one cell but excludes selections crossing cells', () => {
    const editor = createEditor();
    const from = cellPosition(editor, 1, 0) + 2;
    editor.commands.setTextSelection({ from, to: from + 3 });
    expect(editor.view.dom.querySelector('.table-editing-cell')?.textContent).toBe('Alpha');
    editor.commands.setTextSelection({ from, to: cellPosition(editor, 1, 1) + 3 });
    expect(editor.view.dom.querySelector('.table-editing-cell')).toBeNull();
  });

  it('does not add another highlight to a rectangular cell selection', () => {
    const editor = createEditor();
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(
      editor.state.doc, cellPosition(editor, 1, 0), cellPosition(editor, 1, 1),
    )));
    expect(editor.view.dom.querySelectorAll('.selectedCell')).toHaveLength(2);
    expect(editor.view.dom.querySelector('.table-editing-cell')).toBeNull();
  });

  it('only matches the highlight selector while the editor is focused and editable', () => {
    const editor = createEditor();
    editor.commands.setTextSelection(cellPosition(editor, 1, 0) + 2);
    const selector = '.ProseMirror-focused[contenteditable="true"] .table-editing-cell';
    expect(editor.view.dom.querySelector(selector)).toBeNull();
    editor.view.focus();
    expect(editor.view.dom.querySelector(selector)).not.toBeNull();
    editor.view.dom.blur();
    expect(editor.view.dom.querySelector(selector)).toBeNull();
    editor.view.focus();
    editor.setEditable(false);
    expect(editor.view.dom.querySelector(selector)).toBeNull();
  });

  it('does not persist the editing marker in saved content', () => {
    const editor = createEditor();
    editor.commands.setTextSelection(cellPosition(editor, 1, 0) + 2);
    expect(editor.view.dom.querySelector('.table-editing-cell')).not.toBeNull();
    expect(editor.getHTML()).not.toContain('table-editing-cell');
    expect(JSON.stringify(editor.getJSON())).not.toContain('table-editing-cell');
  });
});
