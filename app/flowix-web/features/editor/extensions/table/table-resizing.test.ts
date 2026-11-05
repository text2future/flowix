import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { columnResizingPluginKey, TableMap } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTablePlugin } from './table-plugin';
import type { TableStyleId } from './table-presentation';

const editors: Editor[] = [];

function createEditor(editable = true, styleId: TableStyleId = 'default') {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({
    element, editable, extensions: [StarterKit, createTablePlugin()],
    content: { type: 'doc', content: [{ type: 'table', attrs: { styleId }, content: [0, 1].map(row => ({
      type: 'tableRow', content: [0, 1].map(column => ({
        type: row === 0 ? 'tableHeader' : 'tableCell',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: `${row}:${column}` }] }],
      })),
    })) }] },
  });
  editors.push(editor);
  const table = editor.state.doc.firstChild!;
  const cellPos = 1 + TableMap.get(table).map[0];
  vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: cellPos + 2, inside: cellPos });
  const cell = editor.view.dom.querySelector<HTMLTableCellElement>('th')!;
  vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue({
    left: 100, right: 200, top: 40, bottom: 80, width: 100, height: 40, x: 100, y: 40, toJSON: () => ({}),
  });
  Object.defineProperty(cell, 'offsetWidth', { configurable: true, value: 100 });
  return { editor, cell, cellPos };
}

function hover(cell: HTMLElement, clientX = 198) {
  cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX, clientY: 60 }));
}

afterEach(() => {
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  editors.splice(0).forEach(editor => {
    const element = editor.options.element as HTMLElement;
    editor.destroy();
    element.remove();
  });
  vi.restoreAllMocks();
});

describe('table column resizing', () => {
  it('keeps resizing available when an initially read-only editor becomes editable', () => {
    const { editor, cell, cellPos } = createEditor(false);
    editor.setEditable(true, false);
    expect(columnResizingPluginKey.getState(editor.state)).toBeDefined();
    hover(cell);
    expect(columnResizingPluginKey.getState(editor.state)?.activeHandle).toBe(cellPos);
    expect(editor.view.dom.querySelectorAll('.column-resize-handle')).toHaveLength(2);
    expect(editor.view.dom.classList.contains('resize-cursor')).toBe(true);
  });

  it.each(['default', 'striped', 'business-blue', 'three-line', 'comparison'] as const)(
    'shows the column edge while hovering and clears it on leaving in %s', styleId => {
      const { editor, cell } = createEditor(true, styleId);
      hover(cell);
      expect(editor.view.dom.querySelectorAll('.column-resize-handle')).toHaveLength(2);
      hover(cell, 150);
      expect(editor.view.dom.querySelector('.column-resize-handle')).toBeNull();
      expect(editor.view.dom.classList.contains('resize-cursor')).toBe(false);
    },
  );

  it('updates the column width on drag after switching from read-only to editable', () => {
    const { editor, cell } = createEditor(false);
    editor.setEditable(true, false);
    hover(cell);
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 198, clientY: 60 }));
    expect(columnResizingPluginKey.getState(editor.state)?.dragging).toBeTruthy();
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 228, clientY: 60 }));
    editor.state.doc.firstChild!.forEach(row => expect(row.firstChild?.attrs.colwidth).toEqual([130]));
    expect(columnResizingPluginKey.getState(editor.state)?.dragging).toBeFalsy();
  });

  it.each(['row', 'column'])('suspends resize hover during %s sorting and restores it after release', axis => {
    const { editor, cell, cellPos } = createEditor();
    hover(cell);
    expect(columnResizingPluginKey.getState(editor.state)?.activeHandle).toBe(cellPos);
    const button = editor.view.dom.querySelector<HTMLButtonElement>(`.table-reorder-handle--${axis}`)!;
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    expect(columnResizingPluginKey.getState(editor.state)?.activeHandle).toBe(-1);
    expect(editor.view.dom.dataset.tableReordering).toBe('true');
    const before = editor.getJSON();
    hover(cell);
    expect(columnResizingPluginKey.getState(editor.state)?.activeHandle).toBe(-1);
    expect(editor.view.dom.querySelector('.column-resize-handle')).toBeNull();
    expect(editor.getJSON()).toEqual(before);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(editor.view.dom.dataset.tableReordering).toBeUndefined();
    hover(cell);
    expect(columnResizingPluginKey.getState(editor.state)?.activeHandle).toBe(cellPos);
  });

  it('does not activate a resize handle while read-only', () => {
    const { editor, cell } = createEditor(false);
    const original = editor.getJSON();
    hover(cell);
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 198, clientY: 60 }));
    expect(editor.view.dom.querySelector('.column-resize-handle')).toBeNull();
    expect(editor.getJSON()).toEqual(original);
  });
});
