import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { columnResizingPluginKey } from '@tiptap/pm/tables';
import { afterEach, expect, it, vi } from 'vitest';
import { createTablePlugin } from './table-plugin';

let editor: Editor | undefined;
let host: HTMLElement | undefined;
afterEach(() => { editor?.destroy(); host?.remove(); vi.restoreAllMocks(); });
function rect(left: number, top: number, width: number, height: number) {
  return { left, right: left + width, top, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) };
}
it('anchors one square per axis past the table far edge instead of spanning it', async () => {
  host = document.createElement('div');
  document.body.append(host);
  editor = new Editor({ element: host, extensions: [StarterKit, createTablePlugin()], content: '<table><tr><td>x</td><td>y</td></tr></table>' });
  vi.spyOn(editor.view, 'posAtCoords').mockReturnValue(null);
  const root = editor.view.dom;
  const table = root.querySelector('table')!;
  const rail = root.querySelector<HTMLElement>('.markdown-table-rail')!;
  Object.defineProperties(table, {
    offsetLeft: { value: 14 }, offsetTop: { value: 14 },
    offsetWidth: { value: 360 }, offsetHeight: { value: 100 },
  });
  // Viewport coordinates deliberately include a 2x transform; controls still
  // use unscaled CSS offsets inside the rail.
  vi.spyOn(table, 'getBoundingClientRect').mockReturnValue(rect(200, 80, 720, 200));
  vi.spyOn(rail, 'getBoundingClientRect').mockReturnValue(rect(50, 40, 1000, 122));
  table.querySelector('td:last-child')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  await new Promise(resolve => requestAnimationFrame(resolve));
  const column = rail.querySelector<HTMLButtonElement>('.table-edge-insert-button--column')!;
  const row = rail.querySelector<HTMLButtonElement>('.table-edge-insert-button--row')!;
  expect(column.hidden).toBe(false);
  expect(column.style.left).toBe('378px'); // right edge 374 + 4px gap
  expect(column.style.top).toBe('14px'); // aligned with the table top
  expect(column.style.width).toBe('24px');
  expect(column.style.height).toBe('24px');
  expect(row.hidden).toBe(false);
  expect(row.style.left).toBe('14px'); // aligned with the table left
  expect(row.style.top).toBe('118px'); // bottom edge 114 + 4px gap
  expect(row.style.width).toBe('24px');
  expect(row.style.height).toBe('24px');
  // Both bridges follow their full gutter; CSS puts the row bridge below the
  // horizontal scrollbar's track/thumb so the scrollbar keeps hit priority.
  const columnZone = rail.querySelector<HTMLElement>('.table-edge-insert-hover-zone--column')!;
  const rowZone = rail.querySelector<HTMLElement>('.table-edge-insert-hover-zone--row')!;
  expect(columnZone.style.left).toBe('374px');
  expect(columnZone.style.top).toBe('14px');
  expect(columnZone.style.width).toBe('28px');
  expect(columnZone.style.height).toBe('100px');
  expect(rowZone.style.left).toBe('14px');
  expect(rowZone.style.top).toBe('114px');
  expect(rowZone.style.width).toBe('360px');
  expect(rowZone.style.height).toBe('28px');
  // A nested scroll must clear controls, rather than leaving them at stale cell positions.
  root.querySelector('.tableWrapper')!.dispatchEvent(new Event('scroll'));
  expect(row.hidden).toBe(true);
  expect(column.hidden).toBe(true);
});

it('keeps the control while hovering its button and hides after leaving', async () => {
  host = document.createElement('div'); document.body.append(host);
  editor = new Editor({ element: host, extensions: [StarterKit, createTablePlugin()], content: '<table><tr><td>x</td><td>y</td></tr></table>' });
  vi.spyOn(editor.view, 'posAtCoords').mockReturnValue(null);
  editor.view.dom.querySelector('td:last-child')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  await new Promise(resolve => requestAnimationFrame(resolve));
  const button = host.querySelector<HTMLButtonElement>('.table-edge-insert-button--column')!;
  expect(button.hidden).toBe(false);
  button.dispatchEvent(new MouseEvent('mouseenter'));
  expect(button.hidden).toBe(false);
  button.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: editor.view.dom }));
  await new Promise(resolve => setTimeout(resolve, 160));
  expect(button.hidden).toBe(true);
});

it('keeps the row control while the horizontal scrollbar band is hovered', async () => {
  host = document.createElement('div'); document.body.append(host);
  editor = new Editor({ element: host, extensions: [StarterKit, createTablePlugin()], content: '<p>before</p><table><tr><td>x</td><td>y</td></tr></table><p>after</p>' });
  vi.spyOn(editor.view, 'posAtCoords').mockReturnValue(null);
  editor.view.dom.querySelector('td:last-child')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  await new Promise(resolve => requestAnimationFrame(resolve));
  const row = host.querySelector<HTMLButtonElement>('.table-edge-insert-button--row')!;
  const zone = host.querySelector<HTMLElement>('.table-edge-insert-hover-zone--row')!;
  const track = host.querySelector<HTMLElement>('.overlay-scrollbar-track--horizontal')!;
  expect(row.hidden).toBe(false);
  // Leaving the bridge starts the 120ms grace timer. Moving onto the scrollbar
  // band cancels it instead of treating the band as an unrelated target.
  zone.dispatchEvent(new MouseEvent('mouseleave'));
  track.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 160));
  expect(row.hidden).toBe(false);
  // Only this table's scrollbar gets the exemption; another horizontal
  // scrollbar elsewhere in the pane is an unrelated target and hides controls.
  const foreign = document.createElement('div');
  foreign.className = 'overlay-scrollbar-track--horizontal';
  host.append(foreign);
  foreign.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  await new Promise(resolve => requestAnimationFrame(resolve));
  expect(row.hidden).toBe(true);
  foreign.remove();
  // A real scroll (i.e. dragging the thumb) still takes priority and clears
  // the edge controls so nothing overlaps the gesture.
  editor.view.dom.querySelector('td:last-child')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  await new Promise(resolve => requestAnimationFrame(resolve));
  expect(row.hidden).toBe(false);
  host.querySelector('.tableWrapper')!.dispatchEvent(new Event('scroll'));
  expect(row.hidden).toBe(true);
});

it('keeps the column button while resizing and document transactions fire', async () => {
  host = document.createElement('div'); document.body.append(host);
  editor = new Editor({ element: host, extensions: [StarterKit, createTablePlugin()], content: '<p>before</p><table><tr><td>x</td><td>y</td></tr></table><p>after</p>' });
  vi.spyOn(editor.view, 'posAtCoords').mockReturnValue(null);
  const cell = editor.view.dom.querySelector('td:last-child')!;
  cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  await new Promise(resolve => requestAnimationFrame(resolve));
  const column = host.querySelector<HTMLButtonElement>('.table-edge-insert-button--column')!;
  expect(column.hidden).toBe(false);
  // prosemirror-tables sets and clears activeHandle with setMeta transactions
  // that leave the document untouched; crossing the 8px resize band must not
  // clear the button before the pointer can reach it.
  const docBefore = editor.state.doc;
  const cellPos = editor.view.posAtDOM(cell, 0) - 1;
  editor.view.dispatch(editor.state.tr.setMeta(columnResizingPluginKey, { setHandle: cellPos }));
  expect(editor.state.doc).toBe(docBefore);
  expect(column.hidden).toBe(false);
  editor.view.dispatch(editor.state.tr.setMeta(columnResizingPluginKey, { setHandle: -1 }));
  expect(column.hidden).toBe(false);
  // Another extension may append a doc-changing transaction mid-gesture: the
  // control re-resolves its cell position instead of disappearing.
  editor.view.dispatch(editor.state.tr.insertText('x', 1));
  expect(editor.state.doc).not.toBe(docBefore);
  expect(column.hidden).toBe(false);
});

it('does not resurrect a pending hover after scrolling', async () => {
  host = document.createElement('div'); document.body.append(host);
  editor = new Editor({ element: host, extensions: [StarterKit, createTablePlugin()], content: '<table><tr><td>x</td></tr></table>' });
  vi.spyOn(editor.view, 'posAtCoords').mockReturnValue(null);
  editor.view.dom.querySelector('td')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  editor.view.dom.querySelector('.tableWrapper')!.dispatchEvent(new Event('scroll'));
  await new Promise(resolve => requestAnimationFrame(resolve));
  expect(host.querySelector('.table-edge-insert-button:not([hidden])')).toBeNull();
});

it('recognizes the last logical row even when a cell spans into it', async () => {
  host = document.createElement('div'); document.body.append(host);
  editor = new Editor({ element: host, extensions: [StarterKit, createTablePlugin()], content: '<table><tr><td rowspan="2">Spanning</td><td>Top</td></tr><tr><td>Bottom</td></tr></table>' });
  vi.spyOn(editor.view, 'posAtCoords').mockReturnValue(null);
  editor.view.dom.querySelector('td')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  await new Promise(resolve => requestAnimationFrame(resolve));
  const row = host.querySelector<HTMLButtonElement>('.table-edge-insert-button--row')!;
  expect(row.hidden).toBe(false);
  expect(host.querySelector<HTMLButtonElement>('.table-edge-insert-button--column')!.hidden).toBe(true);
});
