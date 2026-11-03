import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, translate } from '@/lib/i18n';
import { EditorToolbar } from '../../components/editor-toolbar';
import { isSlashMenuOpen, SlashMenu } from '../slash-menu';
import { createTablePlugin } from './table-plugin';
import { insertTableTemplate, TABLE_TEMPLATE_OPTIONS } from './table-templates';
import { SLASH_MENU_ITEMS } from '../../components/slash-menu-dropdown';

vi.mock('@features/agent/public/runtime-status-api', () => ({
  getAgentRuntimeStatusSnapshot: () => ({ hasChecked: true, isChecking: false, statusByType: {} }),
  getAvailableAgentTypes: () => [],
  subscribeAgentRuntimeStatus: () => () => {},
  refreshAgentRuntimeStatusIfStale: async () => {},
}));

const editors: Editor[] = [];
const roots: { root: Root; element: HTMLElement }[] = [];

function createEditor(content = '<p>before</p><p></p><p>after</p>') {
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit, Markdown, createTablePlugin(), SlashMenu],
    content,
  });
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ left: 100, right: 100, top: 100, bottom: 120 });
  editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize + 1);
  editors.push(editor);
  return editor;
}

function type(editor: Editor, text: string) {
  const { from, to } = editor.state.selection;
  const insert = () => editor.state.tr.insertText(text, from, to);
  const handled = editor.view.someProp('handleTextInput', handler => handler(editor.view, from, to, text, insert));
  if (!handled) editor.view.dispatch(insert());
}

function press(editor: Editor, key: string) {
  editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function slashOption(label: string): HTMLButtonElement {
  const option = [...document.querySelectorAll<HTMLButtonElement>('.slash-menu-item[role="option"]')]
    .find(button => button.textContent === label);
  expect(option, `Expected slash menu option ${label}`).toBeTruthy();
  return option!;
}

function clickSlashOption(label: string) {
  slashOption(label).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
}

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach(({ root, element }) => { root.unmount(); element.remove(); });
    editors.splice(0).forEach(editor => {
      const element = editor.options.element as HTMLElement;
      editor.destroy();
      element.remove();
    });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  vi.restoreAllMocks();
});

describe('table templates in the real editor menus', () => {
  it.each([
    { query: 'grid', styleId: 'default' },
    { query: '商务蓝', styleId: 'business-blue' },
    { query: '灰白', styleId: 'striped' },
    { query: '对比', styleId: 'comparison' },
    { query: '简报', styleId: 'financial-brief' },
    { query: '三线', styleId: 'three-line' },
    { query: '港股', styleId: 'hk-financial' },
    { query: '分组', styleId: 'grouped' },
    { query: '极简', styleId: 'minimal' },
    { query: '文献', styleId: 'literature' },
  ])('inserts $styleId through the searchable slash menu', async ({ query, styleId }) => {
    const editor = createEditor();
    await act(async () => { type(editor, '/'); type(editor, query); });
    expect(isSlashMenuOpen(editor.view)).toBe(true);
    expect(editor.state.doc.child(1).textContent).toBe(`/${query}`);
    await act(async () => { press(editor, 'Enter'); });
    expect(isSlashMenuOpen(editor.view)).toBe(true);
    expect(editor.state.doc.child(1).textContent).toBe(`/${query}`);
    await act(async () => { press(editor, 'Enter'); });
    expect(isSlashMenuOpen(editor.view)).toBe(false);
    expect(editor.state.doc.child(0).textContent).toBe('before');
    expect(editor.state.doc.child(1).type.name).toBe('table');
    expect(editor.state.doc.child(1).attrs.styleId).toBe(styleId);
    expect(editor.state.doc.child(2).textContent).toBe('after');
    expect(editor.getMarkdown()).not.toContain(`/${query}`);
  });

  it.each(['TAIL', '正文🙂保留'])('preserves trailing text "%s" when inserting at a paragraph-start slash and undoing', async trailingText => {
    const editor = createEditor(`<p>before</p><p>${trailingText}</p><p>after</p>`);
    const original = editor.getJSON();
    await act(async () => { type(editor, '/'); type(editor, '港股'); });
    expect(editor.state.doc.child(1).textContent).toBe(`/港股${trailingText}`);
    await act(async () => { press(editor, 'Enter'); });
    await act(async () => { press(editor, 'Enter'); });
    expect(isSlashMenuOpen(editor.view)).toBe(false);
    expect(editor.state.doc.childCount).toBe(4);
    expect(editor.state.doc.child(0).textContent).toBe('before');
    expect(editor.state.doc.child(1).attrs.styleId).toBe('hk-financial');
    expect(editor.state.doc.child(2).textContent).toBe(trailingText);
    expect(editor.state.doc.child(3).textContent).toBe('after');
    const inserted = editor.getJSON();
    await act(async () => { expect(editor.commands.undo()).toBe(true); });
    expect(editor.getJSON()).toEqual(original);
    await act(async () => { expect(editor.commands.redo()).toBe(true); });
    expect(editor.getJSON()).toEqual(inserted);
  });

  it('keeps the slash text untouched when returning from the submenu and cancelling', async () => {
    const editor = createEditor();
    await act(async () => { type(editor, '/'); type(editor, '港股'); });
    const original = editor.getJSON();
    await act(async () => { press(editor, 'Enter'); });
    await act(async () => { press(editor, 'Escape'); });
    expect(isSlashMenuOpen(editor.view)).toBe(true);
    expect(slashOption('表格').getAttribute('aria-haspopup')).toBe('listbox');
    expect(editor.getJSON()).toEqual(original);
    await act(async () => { press(editor, 'Escape'); });
    expect(isSlashMenuOpen(editor.view)).toBe(false);
    expect(editor.getJSON()).toEqual(original);
  });

  it('opens with Right, navigates children, and goes back with Left without moving the editor selection', async () => {
    const editor = createEditor();
    await act(async () => { type(editor, '/'); type(editor, '表格'); });
    const selection = editor.state.selection;
    await act(async () => { press(editor, 'ArrowRight'); });
    expect(document.querySelectorAll('.slash-menu-item[role="option"]')).toHaveLength(10);
    await act(async () => { press(editor, 'ArrowDown'); });
    expect(editor.state.selection.eq(selection)).toBe(true);
    expect(editor.state.doc.child(1).textContent).toBe('/表格');
    expect(slashOption('商务蓝').getAttribute('aria-selected')).toBe('true');
    await act(async () => { press(editor, 'ArrowLeft'); });
    expect(slashOption('表格').getAttribute('aria-selected')).toBe('true');
    expect(editor.state.selection.eq(selection)).toBe(true);
    await act(async () => { press(editor, 'ArrowRight'); press(editor, 'ArrowUp'); });
    expect(slashOption('紧凑文献表').getAttribute('aria-selected')).toBe('true');
    await act(async () => { press(editor, 'Enter'); });
    expect(editor.state.doc.child(1).attrs.styleId).toBe('literature');
  });

  it('opens the parent by mouse and inserts only after choosing a child', async () => {
    const editor = createEditor();
    await act(async () => { type(editor, '/'); type(editor, '表格'); });
    const original = editor.getJSON();
    expect(document.querySelector('[aria-label="返回插入菜单"]')).toBeNull();
    expect(SLASH_MENU_ITEMS.filter(item => item.id.startsWith('table-style-'))).toHaveLength(0);
    await act(async () => { clickSlashOption('表格'); });
    expect(editor.getJSON()).toEqual(original);
    expect(document.querySelectorAll('.slash-menu-item[role="option"]')).toHaveLength(TABLE_TEMPLATE_OPTIONS.length);
    const back = document.querySelector<HTMLButtonElement>('[aria-label="返回插入菜单"]')!;
    await act(async () => { back.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); });
    expect(editor.getJSON()).toEqual(original);
    await act(async () => { clickSlashOption('表格'); });
    await act(async () => { clickSlashOption('港股财报式'); });
    expect(isSlashMenuOpen(editor.view)).toBe(false);
    expect(editor.state.doc.child(1).attrs.styleId).toBe('hk-financial');
  });

  it('filters a financial query to matching children and preserves arrow navigation', async () => {
    const editor = createEditor();
    await act(async () => { type(editor, '/'); type(editor, '财报'); press(editor, 'Enter'); });
    expect([...document.querySelectorAll('.slash-menu-item[role="option"]')].map(item => item.textContent))
      .toEqual(['财务简报', '港股财报式']);
    await act(async () => { press(editor, 'ArrowDown'); press(editor, 'Enter'); });
    expect(editor.state.doc.child(1).attrs.styleId).toBe('hk-financial');
  });

  it('keeps live filtering inside the table submenu without consuming the slash query', async () => {
    const editor = createEditor();
    await act(async () => { type(editor, '/'); });
    await act(async () => { clickSlashOption('表格'); type(editor, '科研'); });
    expect(editor.state.doc.child(1).textContent).toBe('/科研');
    expect([...document.querySelectorAll('.slash-menu-item[role="option"]')].map(item => item.textContent))
      .toEqual(['标准三线表', '分组横线表', '极简细线表', '紧凑文献表']);
    await act(async () => { press(editor, 'Enter'); });
    expect(editor.state.doc.child(1).attrs.styleId).toBe('three-line');
  });

  it('keeps non-table slash commands and multidimensional table entries at the root', async () => {
    const editor = createEditor();
    await act(async () => { type(editor, '/'); type(editor, 'h1'); press(editor, 'Enter'); });
    expect(isSlashMenuOpen(editor.view)).toBe(false);
    expect(editor.state.doc.child(1).type.name).toBe('heading');
    expect(editor.state.doc.child(1).attrs.level).toBe(1);
    expect(SLASH_MENU_ITEMS.filter(item => ['table-reference', 'table-kanban-view', 'table-calendar-view', 'table-gallery-view'].includes(item.id)))
      .toHaveLength(4);
  });

  it('preserves slash text when the editor becomes read-only before confirmation', async () => {
    const editor = createEditor();
    await act(async () => { type(editor, '/'); type(editor, '港股'); });
    expect(isSlashMenuOpen(editor.view)).toBe(true);
    await act(async () => { press(editor, 'Enter'); });
    const original = editor.getJSON();
    await act(async () => { editor.setEditable(false); });
    const option = slashOption('港股财报式');
    await act(async () => { option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); });
    expect(editor.getJSON()).toEqual(original);
    expect(isSlashMenuOpen(editor.view)).toBe(false);
  });

  it('does not delete slash text or insert a nested table inside an existing table', async () => {
    const editor = createEditor();
    insertTableTemplate(editor, 'default');
    await act(async () => { type(editor, '/'); type(editor, '港股'); });
    expect(isSlashMenuOpen(editor.view)).toBe(true);
    const original = editor.getJSON();
    await act(async () => { press(editor, 'Enter'); });
    expect(editor.getJSON()).toEqual(original);
    expect(isSlashMenuOpen(editor.view)).toBe(false);
  });

  it('inserts a financial template through the actual toolbar dropdown', async () => {
    const editor = createEditor();
    const element = document.createElement('div');
    document.body.appendChild(element);
    const root = createRoot(element);
    roots.push({ root, element });
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><EditorToolbar editor={editor} /></I18nProvider>);
    });
    const trigger = element.querySelector<HTMLButtonElement>('[aria-label="插入表格"]')!;
    await act(async () => { trigger.click(); });
    for (const option of TABLE_TEMPLATE_OPTIONS) {
      expect([...document.querySelectorAll('button')].some(button => button.textContent === translate('zh-CN', option.labelKey))).toBe(true);
    }
    const option = [...document.querySelectorAll('button')].find(button => button.textContent === '港股财报式')!;
    await act(async () => { option.click(); });
    expect(editor.state.doc.child(1).type.name).toBe('table');
    expect(editor.state.doc.child(1).attrs.styleId).toBe('hk-financial');
    expect(editor.state.doc.child(1).lastChild?.attrs.role).toBe('total');
    expect(trigger.disabled).toBe(true);
    expect(editor.state.doc.child(0).textContent).toBe('before');
    expect(editor.state.doc.child(2).textContent).toBe('after');
    await act(async () => { editor.commands.undo(); });
    expect(editor.state.doc.child(1).type.name).toBe('paragraph');
    expect(editor.state.doc.childCount).toBe(3);
    expect(trigger.disabled).toBe(false);
    await act(async () => { editor.setEditable(false); });
    expect(trigger.disabled).toBe(true);
  });
});
