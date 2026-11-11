import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { CellSelection } from '@tiptap/pm/tables';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import { TableAxisMenu } from './table-axis-menu';
import { createTablePlugin } from './table-plugin';

let editor: Editor;
let root: Root;
let container: HTMLDivElement;
let mount: HTMLDivElement;

beforeEach(() => {
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
});

afterEach(() => {
  if (root) act(() => root.unmount());
  editor?.destroy();
  container?.remove();
  mount?.remove();
});

async function setup() {
  mount = document.createElement('div');
  container = document.createElement('div');
  document.body.append(mount, container);
  editor = new Editor({ element: mount, extensions: [StarterKit, createTablePlugin()], content: {
    type: 'doc', content: [
      { type: 'table', content: [0, 1, 2].map(row => ({ type: 'tableRow', content: [0, 1].map(column => ({
        type: row === 0 ? 'tableHeader' : 'tableCell',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: `${row}:${column}` }] }],
      })) })) },
      { type: 'paragraph' },
    ],
  } });
  root = createRoot(container);
  await act(async () => root.render(<I18nProvider language="zh-CN"><TableAxisMenu editor={editor} /></I18nProvider>));
}

async function open(axis: 'row' | 'column') {
  const cell = editor.view.dom.querySelector<HTMLTableCellElement>('td')!;
  await act(async () => {
    cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    const handle = [...editor.view.dom.querySelectorAll<HTMLButtonElement>(`.table-reorder-handle--${axis}`)].find(item => !item.hidden)!;
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  });
}

function button(label: string, root: ParentNode = document) {
  const result = [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label);
  expect(result, label).toBeDefined();
  return result!;
}

describe('table axis action menu', () => {
  it.each([
    { axis: 'row' as const, label: '上方插入行', rows: 4, columns: 2 },
    { axis: 'row' as const, label: '下方插入行', rows: 4, columns: 2 },
    { axis: 'row' as const, label: '删除行', rows: 2, columns: 2 },
    { axis: 'column' as const, label: '左侧插入列', rows: 3, columns: 3 },
    { axis: 'column' as const, label: '右侧插入列', rows: 3, columns: 3 },
    { axis: 'column' as const, label: '删除列', rows: 3, columns: 1 },
  ])('selects the $axis and applies $label', async ({ axis, label, rows, columns }) => {
    await setup();
    await open(axis);
    expect(editor.state.selection).toBeInstanceOf(CellSelection);
    expect(axis === 'row' ? (editor.state.selection as CellSelection).isRowSelection() : (editor.state.selection as CellSelection).isColSelection()).toBe(true);
    await act(async () => button(label, document.querySelector('.table-axis-menu')!).click());
    expect(editor.state.doc.firstChild!.childCount).toBe(rows);
    expect(editor.state.doc.firstChild!.firstChild!.childCount).toBe(columns);
    expect(document.querySelector('.table-axis-menu')).toBeNull();
  });

  it('uses the bubble border options and applies the edge to the selected row', async () => {
    await setup();
    await open('row');
    await act(async () => button('边框样式', document.querySelector('.table-axis-menu')!).click());
    const section = [...document.querySelectorAll<HTMLElement>('.table-style-menu-section')].find(item => item.textContent?.includes('上边框'))!;
    await act(async () => button('双线', section).click());
    expect(editor.state.doc.firstChild!.child(1).child(0).attrs.borderTop).toBe('double');
    expect(editor.state.doc.firstChild!.child(1).child(1).attrs.borderTop).toBe('double');
  });

  it('applies a background to the selected column', async () => {
    await setup();
    await open('column');
    await act(async () => button('列背景', document.querySelector('.table-axis-menu')!).click());
    const swatch = document.querySelector<HTMLButtonElement>('.table-style-menu--palette button[aria-label="红色"]')!;
    expect(swatch).not.toBeNull();
    await act(async () => swatch.click());
    expect(editor.state.doc.firstChild!.child(0).child(0).attrs.columnBackground).toBe('red');
    expect(editor.state.doc.firstChild!.child(2).child(0).attrs.columnBackground).toBe('red');
    expect(editor.state.doc.firstChild!.child(2).child(1).attrs.columnBackground).toBeNull();
  });

  it('opens submenus on hover and keeps them open while crossing into the submenu', async () => {
    await setup();
    await open('row');
    const panel = document.querySelector<HTMLElement>('.table-axis-menu')!;
    const border = button('边框样式', panel);
    const background = button('行背景', panel);
    await act(async () => border.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(border.getAttribute('aria-expanded')).toBe('true');
    await act(async () => border.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    expect(border.getAttribute('aria-expanded')).toBe('true');
    const submenu = document.querySelector<HTMLElement>('.table-style-menu')!;
    await act(async () => {
      border.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: submenu }));
      submenu.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: border }));
      await new Promise(resolve => setTimeout(resolve, 180));
    });
    expect(border.getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      submenu.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: background }));
      background.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: submenu }));
    });
    expect(border.getAttribute('aria-expanded')).toBe('false');
    expect(background.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.table-style-menu--palette')).not.toBeNull();
    await act(async () => button('上方插入行', panel).dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: background })));
    expect(document.querySelector('.table-style-menu--palette')).toBeNull();
  });

  it('places the submenu against its trigger item', async () => {
    await setup();
    await open('row');
    const trigger = button('边框样式', document.querySelector('.table-axis-menu')!);
    trigger.getBoundingClientRect = () => new DOMRect(50, 20, 190, 28);
    await act(async () => trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(document.querySelector<HTMLElement>('.table-style-menu')?.style.left).toBe('240px');
  });

  it('positions the main menu two pixels from its anchor', async () => {
    await setup();
    await act(async () => editor.view.dom.dispatchEvent(new CustomEvent('flowix:table-axis-menu', {
      detail: { axis: 'row', anchor: new DOMRect(50, 20, 20, 20) },
    })));
    expect(document.querySelector<HTMLElement>('.table-axis-menu')?.style.left).toBe('72px');
  });

  it('offers alignment instead of borders for columns and applies it to the selected column', async () => {
    await setup();
    await open('column');
    const panel = document.querySelector<HTMLElement>('.table-axis-menu')!;
    expect(panel.textContent).not.toContain('边框样式');
    await act(async () => button('对齐', panel).dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    const submenu = document.querySelector<HTMLElement>('.table-style-menu')!;
    await act(async () => button('居中对齐', submenu).click());
    expect(editor.state.doc.firstChild!.child(0).child(0).attrs.columnRole).toBe('note');
    expect(editor.state.doc.firstChild!.child(2).child(0).attrs.columnRole).toBe('note');
    expect(editor.state.doc.firstChild!.child(2).child(1).attrs.columnRole).not.toBe('note');
  });

  it('supports keyboard navigation and Escape', async () => {
    await setup();
    await open('row');
    const panel = document.querySelector<HTMLElement>('.table-axis-menu')!;
    expect(document.activeElement).toBe(button('上方插入行', panel));
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement).toBe(button('下方插入行', panel));
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('.table-axis-menu')).toBeNull();
  });

  it('offers row and column menus for a single-cell table', async () => {
    await setup();
    await act(async () => editor.commands.setContent({ type: 'doc', content: [
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph' }] }] }] },
      { type: 'paragraph' },
    ] }));
    const cell = editor.view.dom.querySelector('td')!;
    await act(async () => cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
    expect([...editor.view.dom.querySelectorAll<HTMLButtonElement>('.table-reorder-handle')].filter(handle => !handle.hidden)).toHaveLength(2);
  });

  it('does not open a menu for a drag gesture', async () => {
    await setup();
    const cell = editor.view.dom.querySelector<HTMLTableCellElement>('td')!;
    await act(async () => {
      cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      const handle = [...editor.view.dom.querySelectorAll<HTMLButtonElement>('.table-reorder-handle--row')].find(item => !item.hidden)!;
      handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(document.querySelector('.table-axis-menu')).toBeNull();
  });
});
