import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { CellSelection } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import { createTablePlugin } from './table-plugin';
import { TableStyleControls } from './table-style-controls';
import { TABLE_TEMPLATE_OPTIONS } from './table-templates';
import { translate } from '@/lib/i18n';
import { setTableCellBorder } from './table-style-commands';

let editor: Editor;
let root: Root;
let container: HTMLDivElement;

async function renderControls() {
  const table: JSONContent = {
    type: 'table',
    content: ['项目|本期', '收入|25,500', '成本|(9,700)'].map((row, index) => ({
      type: 'tableRow',
      attrs: { role: index === 2 ? 'total' : 'body' },
      content: row.split('|').map((text, column) => ({
        type: index === 0 ? 'tableHeader' : 'tableCell',
        attrs: { columnRole: column === 0 ? 'label' : 'amount' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      })),
    })),
  };
  editor = new Editor({ extensions: [StarterKit, createTablePlugin()], content: { type: 'doc', content: [table] } });
  editor.commands.setTextSelection(cellPosition(1, 1) + 2);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<I18nProvider language="zh-CN"><TableStyleControls editor={editor} /></I18nProvider>));
}

function cellPosition(row: number, column: number) {
  const table = editor.state.doc.firstChild!;
  let position = 2;
  for (let index = 0; index < row; index += 1) position += table.child(index).nodeSize;
  for (let index = 0; index < column; index += 1) position += table.child(row).child(index).nodeSize;
  return position;
}

function trigger(label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  return button!;
}

function option(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('.table-style-menu button')]
    .find(item => item.textContent === label);
  expect(button).toBeDefined();
  return button!;
}

afterEach(() => {
  if (root) act(() => root.unmount());
  editor?.destroy();
  container?.remove();
});

describe('table style toolbar menus', () => {
  it.each(TABLE_TEMPLATE_OPTIONS)('applies $styleId without losing content, cell roles, or custom borders', async ({ styleId, labelKey }) => {
    await renderControls();
    await act(async () => {
      setTableCellBorder(editor, 'top', 'double');
      setTableCellBorder(editor, 'bottom', 'none');
    });
    const expected = editor.getJSON();
    expected.content![0].attrs = { ...expected.content![0].attrs, styleId };
    await act(async () => trigger('表格样式: 默认网格').click());
    expect(document.querySelectorAll('.table-style-menu button')).toHaveLength(TABLE_TEMPLATE_OPTIONS.length);
    await act(async () => option(translate('zh-CN', labelKey)).click());
    expect(editor.getJSON()).toEqual(expected);
    expect(trigger(`表格样式: ${translate('zh-CN', labelKey)}`)).toBeDefined();
  });

  it('uses the shared dropdown to change the current table style without changing its text', async () => {
    await renderControls();
    const text = editor.state.doc.textContent;
    expect(container.querySelector('select')).toBeNull();
    await act(async () => trigger('表格样式: 默认网格').click());
    expect(option('默认网格').classList.contains('is-active')).toBe(true);
    await act(async () => option('港股财报式').click());
    expect(editor.state.doc.firstChild?.attrs.styleId).toBe('hk-financial');
    expect(editor.state.doc.textContent).toBe(text);
    expect(trigger('表格样式: 港股财报式').getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.table-style-menu')).toBeNull();
  });

  it('allows mixed row and column selections to be unified through their menus', async () => {
    await renderControls();
    const text = editor.state.doc.textContent;
    await act(async () => editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(
      editor.state.doc, cellPosition(1, 0), cellPosition(2, 1),
    ))));
    await act(async () => trigger('选中行: 混合格式').click());
    expect(document.querySelector('.table-style-menu-heading')?.textContent).toContain('混合格式');
    expect(option('总计').disabled).toBe(false);
    await act(async () => option('总计').click());
    expect(editor.state.doc.firstChild?.child(0).attrs.role).toBe('body');
    for (const row of [1, 2]) expect(editor.state.doc.firstChild?.child(row).attrs.role).toBe('total');

    await act(async () => trigger('选中列: 混合格式').click());
    await act(async () => option('附注').click());
    editor.state.doc.firstChild!.forEach(row => row.forEach(cell => {
      expect(cell.attrs.columnRole).toBe('note');
    }));
    expect(editor.state.doc.textContent).toBe(text);
  });

  it('edits both cell edges through native menus and resets a removed template border', async () => {
    await renderControls();
    const text = editor.state.doc.textContent;
    await act(async () => trigger('上边框: 恢复模板默认').click());
    await act(async () => option('单线').click());
    expect(editor.state.doc.firstChild?.child(1).child(1).attrs.borderTop).toBe('single');
    expect(trigger('上边框: 单线').getAttribute('aria-expanded')).toBe('false');
    await act(async () => trigger('下边框: 恢复模板默认').click());
    await act(async () => option('双线').click());
    expect(editor.state.doc.firstChild?.child(1).child(1).attrs.borderBottom).toBe('double');
    await act(async () => trigger('下边框: 双线').click());
    expect(option('双线').classList.contains('is-active')).toBe(true);
    await act(async () => option('去掉边框').click());
    expect(editor.state.doc.firstChild?.child(1).child(1).attrs.borderBottom).toBe('none');
    await act(async () => trigger('下边框: 去掉边框').click());
    await act(async () => option('恢复模板默认').click());
    expect(editor.state.doc.firstChild?.child(1).child(1).attrs.borderBottom).toBe('auto');
    expect(editor.state.doc.firstChild?.child(1).child(1).attrs.borderTop).toBe('single');
    expect(editor.state.doc.textContent).toBe(text);
  });

  it('shows mixed edges and applies a border to multiple selected cells without losing selection', async () => {
    await renderControls();
    await act(async () => trigger('下边框: 恢复模板默认').click());
    await act(async () => option('双线').click());
    await act(async () => editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(
      editor.state.doc, cellPosition(1, 0), cellPosition(1, 1),
    ))));
    await act(async () => trigger('下边框: 混合格式').click());
    await act(async () => option('单线').click());
    expect(editor.state.selection).toBeInstanceOf(CellSelection);
    expect(trigger('下边框: 单线')).toBeDefined();
    for (const column of [0, 1]) expect(editor.state.doc.firstChild?.child(1).child(column).attrs.borderBottom).toBe('single');
  });

  it('explains when a merged neighbor extends a border beyond the selected cell', async () => {
    await renderControls();
    await act(async () => {
      editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(
        editor.state.doc, cellPosition(2, 0), cellPosition(2, 1),
      )));
      editor.commands.mergeCells();
      editor.commands.setTextSelection(cellPosition(1, 1) + 2);
    });
    await act(async () => trigger('下边框: 恢复模板默认').click());
    expect(document.querySelector('.table-style-menu')?.textContent).toContain('合并单元格共用整条边框');
    await act(async () => option('双线').click());
    for (const column of [0, 1]) expect(editor.state.doc.firstChild?.child(1).child(column).attrs.borderBottom).toBe('double');
  });
});
