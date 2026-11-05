import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, expect, it, vi } from 'vitest';
import { createTablePlugin } from './table-plugin';

let editor: Editor | undefined;
let host: HTMLElement | undefined;
afterEach(() => { editor?.destroy(); host?.remove(); vi.restoreAllMocks(); });
function rect(left: number, top: number, width: number, height: number) {
  return { left, right: left + width, top, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) };
}
it('anchors controls to a short table rather than its wider scroll viewport', async () => {
  host = document.createElement('div');
  document.body.append(host);
  editor = new Editor({ element: host, extensions: [StarterKit, createTablePlugin()], content: '<table><tr><td>x</td><td>y</td></tr></table>' });
  vi.spyOn(editor.view, 'posAtCoords').mockReturnValue(null);
  const root = editor.view.dom;
  const table = root.querySelector('table')!;
  const rail = root.querySelector<HTMLElement>('.markdown-table-rail')!;
  Object.defineProperties(table, {
    offsetLeft: { value: 50 }, offsetTop: { value: 0 },
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
  expect(column.style.left).toBe('414px');
  expect(column.style.height).toBe('100px');
  expect(row.hidden).toBe(false);
  expect(row.style.left).toBe('50px');
  expect(row.style.top).toBe('104px');
  expect(row.style.width).toBe('360px');
  // A nested scroll must clear controls, rather than leaving them at stale cell positions.
  root.querySelector('.tableWrapper')!.dispatchEvent(new Event('scroll'));
  expect(row.hidden).toBe(true);
  expect(column.hidden).toBe(true);
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
