import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { CellSelection } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import { createTablePlugin } from './table-plugin';
import { TableStyleControls } from './table-style-controls';
import { createTableTemplate, TABLE_TEMPLATE_OPTIONS } from './table-templates';
import { translate } from '@/lib/i18n';
import { setTableCellBorder, setTableStyle } from './table-style-commands';

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

function option(label: string, sectionLabel?: string) {
  const section = sectionLabel
    ? [...document.querySelectorAll<HTMLElement>('.table-style-menu-section')]
      .find(item => item.querySelector('.table-style-menu-heading')?.textContent?.includes(sectionLabel))
    : undefined;
  const searchRoot = section ?? document;
  const selector = section ? 'button' : '.table-style-menu button';
  const button = [...searchRoot.querySelectorAll<HTMLButtonElement>(selector)]
    .find(item => item.textContent === label);
  expect(button).toBeDefined();
  return button!;
}

afterEach(() => {
  if (root) act(() => root.unmount());
  editor?.destroy();
  container?.remove();
  vi.useRealTimers();
});

describe('table style toolbar menus', () => {
  it('groups content templates after the blank styles and populates an empty table from the theme menu', async () => {
    await renderControls();
    await act(async () => {
      editor.commands.setContent({ type: 'doc', content: [createTableTemplate('default')] });
      editor.commands.setTextSelection(cellPosition(2, 2) + 2);
    });
    await act(async () => trigger('主题: 默认网格').click());
    const separators = [...document.querySelectorAll('.table-style-menu [role="separator"]')];
    expect(separators.map(separator => [separator.previousElementSibling?.textContent, separator.nextElementSibling?.textContent]))
      .toEqual([['重点对比', '财务简报'], ['港股财报式', '标准三线表'], ['标准三线表', '极简细线表'], ['紧凑文献表', '分组横线表']]);
    await act(async () => option('财务简报').click());
    expect(editor.state.doc.firstChild!.eq(editor.schema.nodeFromJSON(createTableTemplate('financial-brief', 'zh-CN')))).toBe(true);
    expect(document.querySelector('.table-style-menu')).toBeNull();
  });

  it.each([
    { label: '上方插入行', expected: [['项目', '本期'], ['', ''], ['收入', '25,500'], ['成本', '(9,700)']] },
    { label: '下方插入行', expected: [['项目', '本期'], ['收入', '25,500'], ['', ''], ['成本', '(9,700)']] },
    { label: '删除行', expected: [['项目', '本期'], ['成本', '(9,700)']] },
    { label: '左侧插入列', expected: [['项目', '', '本期'], ['收入', '', '25,500'], ['成本', '', '(9,700)']] },
    { label: '右侧插入列', expected: [['项目', '本期', ''], ['收入', '25,500', ''], ['成本', '(9,700)', '']] },
    { label: '删除列', expected: [['项目'], ['收入'], ['成本']] },
  ])('applies $label to the selected cell through the grouped operations menu', async ({ label, expected }) => {
    await renderControls();
    const original = editor.getJSON();
    expect(trigger('行列操作').textContent).toBe('');
    await act(async () => trigger('行列操作').click());
    expect([...document.querySelectorAll('.table-style-menu-heading')].map(heading => heading.textContent))
      .toEqual(['行操作', '列操作']);
    expect(document.querySelectorAll('.table-style-menu button')).toHaveLength(6);
    await act(async () => option(label).click());
    const rows: string[][] = [];
    editor.state.doc.firstChild!.forEach(row => {
      const cells: string[] = [];
      row.forEach(cell => cells.push(cell.textContent));
      rows.push(cells);
    });
    expect(rows).toEqual(expected);
    expect(document.querySelector('.table-style-menu')).toBeNull();
    await act(async () => { expect(editor.commands.undo()).toBe(true); });
    expect(editor.getJSON()).toEqual(original);
  });

  it.each(TABLE_TEMPLATE_OPTIONS)('respects the header constraints of $styleId', async ({ styleId }) => {
    await renderControls();
    await act(async () => { setTableStyle(editor, styleId); });
    await act(async () => trigger('字体').click());
    const rowSwitch = document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="标题行"]')!;
    const columnSwitch = document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="标题列"]')!;
    const required = ['business-blue', 'financial-brief', 'hk-financial', 'three-line', 'grouped'].includes(styleId);
    expect(rowSwitch.disabled).toBe(required);
    expect(columnSwitch.disabled).toBe(false);
    if (required) {
      expect(rowSwitch.title).toBe('当前主题需要保留标题行，无法关闭。');
      const original = editor.getJSON();
      await act(async () => rowSwitch.click());
      expect(editor.getJSON()).toEqual(original);
      await act(async () => columnSwitch.click());
      expect(rowSwitch.getAttribute('aria-checked')).toBe('true');
      expect(rowSwitch.disabled).toBe(true);
    } else {
      await act(async () => rowSwitch.click());
      expect(rowSwitch.getAttribute('aria-checked')).toBe('false');
    }
  });

  it.each(['business-blue', 'financial-brief', 'hk-financial', 'three-line', 'grouped'] as const)(
    'allows restoring a missing header in an existing %s table', async styleId => {
      await renderControls();
      await act(async () => {
        editor.commands.toggleHeaderRow();
        setTableStyle(editor, styleId);
      });
      await act(async () => trigger('字体').click());
      const rowSwitch = document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="标题行"]')!;
      expect(rowSwitch.getAttribute('aria-checked')).toBe('false');
      expect(rowSwitch.disabled).toBe(false);
      await act(async () => rowSwitch.click());
      expect(rowSwitch.getAttribute('aria-checked')).toBe('true');
      expect(rowSwitch.disabled).toBe(true);
      await act(async () => { setTableStyle(editor, 'default'); });
      expect(rowSwitch.disabled).toBe(false);
      expect(rowSwitch.title).toBe('');
    },
  );

  it('exposes the product tooltip wording for every table bubble trigger', async () => {
    await renderControls();
    for (const label of ['主题: 默认网格', '边框: 默认', '字体', '颜色', '行列操作']) {
      const button = trigger(label);
      // 产品 Tooltip 挂在真实 DOM 包裹层上, 不再叠一个原生 title。
      expect(button.parentElement?.tagName).toBe('SPAN');
      expect(button.hasAttribute('title')).toBe(false);
    }
    expect([
      translate('zh-CN', 'editor.table.theme'),
      translate('zh-CN', 'editor.table.borderStyle'),
      translate('zh-CN', 'editor.table.rowColumnStyle'),
      translate('zh-CN', 'editor.table.rowColumnBackground'),
      translate('zh-CN', 'editor.table.rowColumnOperations'),
      translate('zh-CN', 'editor.table.deleteTable'),
    ]).toEqual(['主题', '边框样式', '行列样式', '行列背景', '行列操作', '删除表格']);
  });

  it('keeps icon-only triggers to one glyph and drops the border label', async () => {
    await renderControls();
    // 主题是唯一带文案的触发按钮: 图标 + 文案 + 下拉箭头。
    expect(trigger('主题: 默认网格').children.length).toBe(3);
    // 边框 / 字体 / 颜色 / 行列操作只留图标, 既没有可见文案也没有下拉箭头。
    for (const label of ['边框: 默认', '字体', '颜色', '行列操作']) {
      const button = trigger(label);
      expect(button.textContent).toBe('');
      expect(button.children.length).toBe(1);
    }
  });

  // 「颜色」不是列表型菜单: 它复用选区气泡的高亮面板外壳 (固定 160px、两组
  // 色板), 不需要滚动容器, 由下面单独的用例护栏。
  it.each(['主题: 默认网格', '边框: 默认', '字体', '行列操作'])('uses an overlay scrollbar revealed only while scrolling in %s', async label => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] });
    await renderControls();
    await act(async () => trigger(label).click());
    const frame = document.querySelector<HTMLElement>('.table-style-menu .overlay-scrollbar-frame')!;
    const scroller = frame.querySelector<HTMLElement>('.overlay-scrollbar')!;
    expect(frame).not.toBeNull();
    expect(frame.dataset.scrolling).not.toBe('true');
    expect(frame.querySelector('.overlay-scrollbar-thumb--vertical')).not.toBeNull();
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 },
    });
    await act(async () => {
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }));
      scroller.scrollTop = 40;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(frame.dataset.scrolling).toBe('true');
    await act(async () => { vi.advanceTimersByTime(800); });
    expect(frame.dataset.scrolling).not.toBe('true');
  });

  it('renders the color menu in the same panel frame as the selection highlight palette', async () => {
    await renderControls();
    await act(async () => trigger('颜色').click());
    const menu = document.querySelector<HTMLElement>('.table-style-menu.table-style-menu--palette');
    expect(menu).not.toBeNull();
    // 边框 / 圆角 / 底色 / 投影都由内层 .editor-highlight-palette 提供。
    expect(menu!.querySelector('.editor-highlight-palette')).not.toBeNull();
    // 高亮面板没有滚动容器, 也不靠分隔线分组, 两组标题直接分隔。
    expect(menu!.querySelector('.overlay-scrollbar-frame')).toBeNull();
    expect(menu!.querySelector('.table-style-menu-scroll-frame')).toBeNull();
    const sections = [...menu!.querySelectorAll('.table-style-menu-section')];
    expect(sections.map(section => section.querySelector('.table-style-menu-heading')?.textContent))
      .toEqual(['行背景', '列背景']);
    for (const section of sections) {
      expect(section.querySelectorAll('.editor-highlight-palette__swatch')).toHaveLength(10);
    }
  });

  it('toggles header row and column independently inside the font menu without closing it', async () => {
    await renderControls();
    const original = editor.getJSON();
    const selection = editor.state.selection;
    await act(async () => trigger('字体').click());
    const headerSwitch = (label: string) => {
      const button = document.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`);
      expect(button).not.toBeNull();
      return button!;
    };
    expect(headerSwitch('标题行').getAttribute('aria-checked')).toBe('true');
    expect(headerSwitch('标题列').getAttribute('aria-checked')).toBe('false');
    await act(async () => headerSwitch('标题列').click());
    expect(headerSwitch('标题列').getAttribute('aria-checked')).toBe('true');
    editor.state.doc.firstChild!.forEach(row => expect(row.firstChild?.type.name).toBe('tableHeader'));
    await act(async () => headerSwitch('标题行').click());
    expect(headerSwitch('标题行').getAttribute('aria-checked')).toBe('false');
    expect(editor.state.doc.firstChild?.firstChild?.child(0).type.name).toBe('tableHeader');
    expect(editor.state.doc.firstChild?.firstChild?.child(1).type.name).toBe('tableCell');
    expect(editor.state.selection.eq(selection)).toBe(true);
    expect(trigger('字体').getAttribute('aria-expanded')).toBe('true');
    await act(async () => headerSwitch('标题行').click());
    await act(async () => headerSwitch('标题列').click());
    expect(editor.getJSON()).toEqual(original);
  });

  it.each(TABLE_TEMPLATE_OPTIONS)('applies $styleId without losing content, cell roles, or custom borders', async ({ styleId, labelKey }) => {
    await renderControls();
    await act(async () => {
      setTableCellBorder(editor, 'top', 'double');
      setTableCellBorder(editor, 'bottom', 'none');
    });
    const expected = editor.getJSON();
    expected.content![0].attrs = {
      ...expected.content![0].attrs, styleId,
      ...(styleId === 'comparison' ? { comparisonColumn: 1 } : {}),
    };
    await act(async () => trigger('主题: 默认网格').click());
    expect(document.querySelectorAll('.table-style-menu button')).toHaveLength(TABLE_TEMPLATE_OPTIONS.length);
    expect(document.querySelectorAll('.table-style-menu [role="separator"]')).toHaveLength(4);
    await act(async () => option(translate('zh-CN', labelKey)).click());
    expect(editor.getJSON()).toEqual(expected);
    expect(trigger(`主题: ${translate('zh-CN', labelKey)}`)).toBeDefined();
    expect(trigger(`主题: ${translate('zh-CN', labelKey)}`).textContent)
      .toBe(styleId === 'default' ? '主题' : translate('zh-CN', labelKey));
  });

  it('uses the shared dropdown to change the current table style without changing its text', async () => {
    await renderControls();
    const text = editor.state.doc.textContent;
    expect(container.querySelector('select')).toBeNull();
    await act(async () => trigger('主题: 默认网格').click());
    expect(option('默认网格').classList.contains('is-active')).toBe(true);
    await act(async () => option('港股财报式').click());
    expect(editor.state.doc.firstChild?.attrs.styleId).toBe('hk-financial');
    expect(editor.state.doc.textContent).toBe(text);
    expect(trigger('主题: 港股财报式').getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.table-style-menu')).toBeNull();
  });

  it.each(TABLE_TEMPLATE_OPTIONS)('shows only semantic row options for $styleId', async ({ styleId }) => {
    await renderControls();
    await act(async () => { setTableStyle(editor, styleId); });
    const roles = editor.state.doc.firstChild!.toJSON().content!.map((row: JSONContent) => row.attrs?.role);
    await act(async () => trigger('字体').click());
    const sections = [...document.querySelectorAll('.table-style-menu-section')];
    const rowSection = sections.find(section => section.querySelector('.table-style-menu-heading')?.textContent === '行样式');
    if (styleId === 'financial-brief' || styleId === 'hk-financial') {
      expect(rowSection).toBeDefined();
      expect([...rowSection!.querySelectorAll('button')].map(button => button.textContent).filter(Boolean))
        .toEqual(['正文', '分组标题', '小计', '总计']);
    } else if (styleId === 'grouped') {
      expect(rowSection).toBeDefined();
      expect([...rowSection!.querySelectorAll('button')].map(button => button.textContent).filter(Boolean))
        .toEqual(['正文', '分组标题']);
    } else {
      expect(rowSection).toBeUndefined();
    }
    expect(sections.some(section => section.querySelector('.table-style-menu-heading')?.textContent === '列样式')).toBe(true);
    expect(document.querySelector('.table-style-menu .editor-highlight-palette__swatch')).toBeNull();
    expect(editor.state.doc.firstChild!.toJSON().content!.map((row: JSONContent) => row.attrs?.role)).toEqual(roles);
  });

  it('allows mixed row and column selections to be unified through their menus', async () => {
    await renderControls();
    await act(async () => { setTableStyle(editor, 'financial-brief'); });
    const text = editor.state.doc.textContent;
    await act(async () => editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(
      editor.state.doc, cellPosition(1, 0), cellPosition(2, 1),
    ))));
    await act(async () => trigger('字体: 混合格式').click());
    expect(document.querySelector('.table-style-menu-heading')?.textContent).toBe('行样式');
    expect(option('总计').disabled).toBe(false);
    await act(async () => option('总计', '行样式').click());
    expect(editor.state.doc.firstChild?.child(0).attrs.role).toBe('body');
    for (const row of [1, 2]) expect(editor.state.doc.firstChild?.child(row).attrs.role).toBe('total');

    await act(async () => trigger('字体: 混合格式').click());
    await act(async () => option('居中对齐', '列样式').click());
    editor.state.doc.firstChild!.forEach(row => row.forEach(cell => {
      expect(cell.attrs.columnRole).toBe('note');
    }));
    expect(editor.state.doc.textContent).toBe(text);
  });

  it('edits both cell edges through native menus and resets a removed template border', async () => {
    await renderControls();
    const text = editor.state.doc.textContent;
    await act(async () => trigger('边框: 默认').click());
    await act(async () => option('单线', '上边框').click());
    expect(editor.state.doc.firstChild?.child(1).child(1).attrs.borderTop).toBe('single');
    expect(trigger('边框: 混合格式').getAttribute('aria-expanded')).toBe('false');
    await act(async () => trigger('边框: 混合格式').click());
    await act(async () => option('双线', '下边框').click());
    expect(editor.state.doc.firstChild?.child(1).child(1).attrs.borderBottom).toBe('double');
    await act(async () => trigger('边框: 混合格式').click());
    expect(option('双线', '下边框').classList.contains('is-active')).toBe(true);
    await act(async () => option('无边框', '下边框').click());
    expect(editor.state.doc.firstChild?.child(1).child(1).attrs.borderBottom).toBe('none');
    await act(async () => trigger('边框: 混合格式').click());
    await act(async () => option('默认', '下边框').click());
    expect(editor.state.doc.firstChild?.child(1).child(1).attrs.borderBottom).toBe('auto');
    expect(editor.state.doc.firstChild?.child(1).child(1).attrs.borderTop).toBe('single');
    expect(editor.state.doc.textContent).toBe(text);
  });

  it('shows mixed edges and applies a border to multiple selected cells without losing selection', async () => {
    await renderControls();
    await act(async () => trigger('边框: 默认').click());
    await act(async () => option('双线', '下边框').click());
    await act(async () => editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(
      editor.state.doc, cellPosition(1, 0), cellPosition(1, 1),
    ))));
    await act(async () => trigger('边框: 混合格式').click());
    await act(async () => option('单线', '下边框').click());
    expect(editor.state.selection).toBeInstanceOf(CellSelection);
    expect(trigger('边框: 混合格式')).toBeDefined();
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
    await act(async () => trigger('边框: 默认').click());
    expect(document.querySelector('.table-style-menu')?.textContent).toContain('合并单元格共用整条边框');
    await act(async () => option('双线', '下边框').click());
    for (const column of [0, 1]) expect(editor.state.doc.firstChild?.child(1).child(column).attrs.borderBottom).toBe('double');
  });
});


it('sets and clears independent row/column backgrounds through the shared highlight palette', async () => {
  await renderControls();
  const swatch = () => trigger('颜色').querySelector<HTMLElement>('span[aria-hidden]')!;
  expect(swatch().style.backgroundColor).toBe('white');
  await act(async () => trigger('颜色').click());
  expect(document.querySelector('.table-style-menu .editor-highlight-palette__heading')).toBeNull();
  const rowSection = [...document.querySelectorAll<HTMLElement>('.table-style-menu-section')]
    .find(section => section.querySelector('.table-style-menu-heading')?.textContent === '行背景')!;
  await act(async () => rowSection.querySelector<HTMLButtonElement>('button[aria-label="黄色"]')!.click());
  expect(editor.state.doc.firstChild!.child(1).attrs.rowBackground).toBe('yellow');
  expect(swatch().style.backgroundColor).toBe('var(--flowix-highlight-background-yellow)');
  expect(editor.state.doc.firstChild!.child(0).attrs.rowBackground).toBeNull();
  const columnSection = [...document.querySelectorAll<HTMLElement>('.table-style-menu-section')]
    .find(section => section.querySelector('.table-style-menu-heading')?.textContent === '列背景')!;
  await act(async () => columnSection.querySelector<HTMLButtonElement>('button[aria-label="蓝色"]')!.click());
  editor.state.doc.firstChild!.forEach(row => expect(row.child(1).attrs.columnBackground).toBe('blue'));
  expect(swatch().style.backgroundColor).toBe('var(--flowix-highlight-background-yellow)');
  expect(rowSection.querySelector('button[aria-label="黄色"]')?.getAttribute('aria-pressed')).toBe('true');
  await act(async () => rowSection.querySelector<HTMLButtonElement>('button[aria-label="默认背景"]')!.click());
  expect(editor.state.doc.firstChild!.child(1).attrs.rowBackground).toBeNull();
  editor.state.doc.firstChild!.forEach(row => expect(row.child(1).attrs.columnBackground).toBe('blue'));
  expect(swatch().style.backgroundColor).toBe('var(--flowix-highlight-background-blue)');
  await act(async () => columnSection.querySelector<HTMLButtonElement>('button[aria-label="默认背景"]')!.click());
  expect(swatch().style.backgroundColor).toBe('white');
});
