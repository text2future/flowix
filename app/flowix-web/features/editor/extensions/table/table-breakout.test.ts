import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, expect, it, vi } from 'vitest';
import { createTablePlugin } from './table-plugin';

const editors: Editor[] = [];
const panes: HTMLElement[] = [];
function rect(left: number, width: number) {
  return { left, right: left + width, top: 0, bottom: 600, width, height: 600, x: left, y: 0, toJSON: () => ({}) };
}
function setup() {
  const pane = document.createElement('div');
  pane.className = 'editor-content';
  const element = document.createElement('div');
  pane.append(element);
  document.body.append(pane);
  panes.push(pane);
  const editor = new Editor({ element, extensions: [StarterKit, createTablePlugin()], content: '<p>Text</p>' });
  editors.push(editor);
  const root = editor.view.dom;
  root.style.padding = '0 96px';
  Object.defineProperties(pane, { clientWidth: { configurable: true, value: 1200 }, offsetWidth: { configurable: true, value: 1200 } });
  Object.defineProperty(root, 'clientWidth', { value: 680 });
  vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(rect(160, 1200));
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(420, 680));
  return { editor, root, pane };
}
afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy());
  panes.splice(0).forEach(pane => pane.remove());
  vi.restoreAllMocks();
});
it('measures the pane and prose origin without changing stored column widths', async () => {
  const { editor, root } = setup();
  editor.commands.insertTable({ rows: 2, cols: 3 });
  const before = editor.getJSON();
  await expect.poll(() => root.dataset.tableBreakout).toBe('true');
  expect(root.style.getPropertyValue('--markdown-table-pane-width')).toBe('1200px');
  expect(root.style.getPropertyValue('--markdown-table-leading-space')).toBe('356px');
  expect(root.style.getPropertyValue('--markdown-table-content-width')).toBe('488px');
  expect(editor.getJSON()).toEqual(before);
  expect(root.querySelector('.markdown-table-scrollbar > .tableWrapper > .markdown-table-rail > table')).not.toBeNull();
});
it('updates the viewport when a split pane changes width and cleans up on destroy', async () => {
  const { editor, root, pane } = setup();
  await expect.poll(() => root.dataset.tableBreakout).toBe('true');
  Object.defineProperties(pane, { clientWidth: { value: 740 }, offsetWidth: { value: 740 } });
  vi.mocked(pane.getBoundingClientRect).mockReturnValue(rect(160, 740));
  vi.mocked(root.getBoundingClientRect).mockReturnValue(rect(190, 680));
  root.style.padding = '0 48px';
  editor.commands.setTextSelection(1);
  await expect.poll(() => root.style.getPropertyValue('--markdown-table-pane-width')).toBe('740px');
  expect(root.style.getPropertyValue('--markdown-table-leading-space')).toBe('78px');
  expect(root.style.getPropertyValue('--markdown-table-content-width')).toBe('584px');
  editor.destroy();
  editors.splice(editors.indexOf(editor), 1);
  expect(root.dataset.tableBreakout).toBeUndefined();
  expect(root.style.getPropertyValue('--markdown-table-pane-width')).toBe('');
});
it('does not activate outside the document scroller', async () => {
  const element = document.createElement('div');
  document.body.append(element);
  panes.push(element);
  const editor = new Editor({ element, extensions: [StarterKit, createTablePlugin()] });
  editors.push(editor);
  await new Promise(resolve => requestAnimationFrame(resolve));
  expect(editor.view.dom.dataset.tableBreakout).toBeUndefined();
});
