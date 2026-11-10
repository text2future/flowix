import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTablePlugin } from './table-plugin';

const editors: Editor[] = [];

beforeEach(() => {
  // jsdom has no hit-testing; prosemirror-tables' hover handler calls it on
  // every mousemove. These assertions only care about the reorder grips.
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
});

function createEditor(): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit, createTablePlugin()],
    // The trailing paragraph mirrors a real note: a table is never the last
    // block, and Tiptap appends one on the first edit otherwise, which would
    // make the counter assertions measure that repair instead.
    content: { type: 'doc', content: [
      { type: 'table', content: [0, 1].map(row => ({
        type: 'tableRow', content: [0, 1].map(column => ({
          type: row === 0 ? 'tableHeader' : 'tableCell',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: `${row}:${column}` }] }],
        })),
      })) },
      { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
    ] },
  });
  editors.push(editor);
  return editor;
}

function hoverBodyCell(editor: Editor): HTMLTableCellElement {
  const cell = editor.view.dom.querySelector<HTMLTableCellElement>('td')!;
  cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }));
  return cell;
}

function grips(editor: Editor): HTMLButtonElement[] {
  return [...editor.view.dom.querySelectorAll<HTMLButtonElement>('.table-reorder-handle')];
}

function visibleGrips(editor: Editor): HTMLButtonElement[] {
  return grips(editor).filter(handle => !handle.hidden);
}

afterEach(() => {
  editors.splice(0).forEach(editor => {
    const element = editor.options.element as HTMLElement;
    editor.destroy();
    element.remove();
  });
});

describe('table reorder grips', () => {
  it('survives the click that puts the caret into a cell', () => {
    const editor = createEditor();
    const cell = hoverBodyCell(editor);
    expect(visibleGrips(editor)).toHaveLength(2);

    // A click anywhere bubbles its mouseup to the plugin's document listener;
    // without the `end()` guard that ran cancel()/hide() and the grips only
    // came back on the next mousemove.
    const paragraph = cell.querySelector('p')!;
    for (const type of ['mousemove', 'mousedown', 'mouseup', 'click']) {
      paragraph.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
    }

    expect(visibleGrips(editor)).toHaveLength(2);
  });

  it('keeps the grips while the hovered cell is being edited', () => {
    const editor = createEditor();
    hoverBodyCell(editor);
    expect(visibleGrips(editor)).toHaveLength(2);

    // Typing rewrites the document under a pointer that never moved.
    editor.view.dispatch(editor.state.tr.insertText('x', 4));

    expect(visibleGrips(editor)).toHaveLength(2);
  });

  it('still ends an actual grip drag on mouseup', () => {
    const editor = createEditor();
    hoverBodyCell(editor);
    const column = editor.view.dom.querySelector<HTMLButtonElement>('.table-reorder-handle--column')!;
    column.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    expect(editor.view.dom.dataset.tableReordering).toBe('true');
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(editor.view.dom.dataset.tableReordering).toBeUndefined();
  });
});
