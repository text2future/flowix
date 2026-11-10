import { act } from 'react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSlashMenuOpen, SlashMenu } from '../slash-menu';
import { createTablePlugin } from './table-plugin';
import { insertTableTemplate } from './table-templates';
import { SLASH_MENU_ITEMS } from '../../components/slash-menu-dropdown';

vi.mock('@features/agent/public/runtime-status-api', () => ({
  getAgentRuntimeStatusSnapshot: () => ({ hasChecked: true, isChecking: false, statusByType: {} }),
  getAvailableAgentTypes: () => [],
  subscribeAgentRuntimeStatus: () => () => {},
  refreshAgentRuntimeStatusIfStale: async () => {},
}));

const editors: Editor[] = [];

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
  it.each(['表格', 'table', 'biaoge'])('inserts the default grid with one Enter for %s', async query => {
    const editor = createEditor();
    await act(async () => { type(editor, '/'); type(editor, query); });
    expect(isSlashMenuOpen(editor.view)).toBe(true);
    expect(slashOption('表格').hasAttribute('aria-haspopup')).toBe(false);
    expect(slashOption('表格').querySelector('svg')).not.toBeNull();
    await act(async () => { press(editor, 'Enter'); });
    expect(isSlashMenuOpen(editor.view)).toBe(false);
    expect(editor.state.doc.child(0).textContent).toBe('before');
    expect(editor.state.doc.child(1).type.name).toBe('table');
    expect(editor.state.doc.child(1).attrs.styleId).toBe('default');
    expect(editor.state.doc.child(1).childCount).toBe(3);
    expect(editor.state.doc.child(1).firstChild?.childCount).toBe(3);
    expect(editor.state.doc.child(2).textContent).toBe('after');
    expect(editor.getMarkdown()).not.toContain(`/${query}`);
  });

  it('inserts directly on click without exposing a table style submenu', async () => {
    const editor = createEditor();
    await act(async () => { type(editor, '/'); });
    expect(document.querySelector('[aria-label="返回插入菜单"]')).toBeNull();
    await act(async () => { clickSlashOption('表格'); });
    expect(isSlashMenuOpen(editor.view)).toBe(false);
    expect(editor.state.doc.child(1).attrs.styleId).toBe('default');
  });

  it.each(['TAIL', '正文🙂保留'])('preserves trailing text "%s" and supports undo/redo', async trailingText => {
    const editor = createEditor(`<p>before</p><p>${trailingText}</p><p>after</p>`);
    const original = editor.getJSON();
    await act(async () => { type(editor, '/'); type(editor, '表格'); press(editor, 'Enter'); });
    expect(editor.state.doc.childCount).toBe(4);
    expect(editor.state.doc.child(1).attrs.styleId).toBe('default');
    expect(editor.state.doc.child(2).textContent).toBe(trailingText);
    expect(editor.state.doc.child(3).textContent).toBe('after');
    const inserted = editor.getJSON();
    await act(async () => { expect(editor.commands.undo()).toBe(true); });
    expect(editor.getJSON()).toEqual(original);
    await act(async () => { expect(editor.commands.redo()).toBe(true); });
    expect(editor.getJSON()).toEqual(inserted);
  });

  it('cancels without modifying the slash query', async () => {
    const editor = createEditor();
    await act(async () => { type(editor, '/'); type(editor, '表格'); });
    const original = editor.getJSON();
    await act(async () => { press(editor, 'Escape'); });
    expect(isSlashMenuOpen(editor.view)).toBe(false);
    expect(editor.getJSON()).toEqual(original);
  });

  it('keeps non-table commands and multidimensional table entries at the root', async () => {
    const editor = createEditor();
    await act(async () => { type(editor, '/'); type(editor, 'h1'); press(editor, 'Enter'); });
    expect(isSlashMenuOpen(editor.view)).toBe(false);
    expect(editor.state.doc.child(1).type.name).toBe('heading');
    expect(editor.state.doc.child(1).attrs.level).toBe(1);
    expect(SLASH_MENU_ITEMS.filter(item => ['table-reference', 'table-kanban-view', 'table-calendar-view', 'table-gallery-view'].includes(item.id)))
      .toHaveLength(4);
  });

  it('preserves slash text if the editor becomes read-only before the click', async () => {
    const editor = createEditor();
    await act(async () => { type(editor, '/'); type(editor, '表格'); });
    const original = editor.getJSON();
    await act(async () => { editor.setEditable(false); });
    await act(async () => { clickSlashOption('表格'); });
    expect(editor.getJSON()).toEqual(original);
    expect(isSlashMenuOpen(editor.view)).toBe(false);
  });

  it('does not delete slash text or insert a nested table inside an existing table', async () => {
    const editor = createEditor();
    insertTableTemplate(editor, 'default');
    await act(async () => { type(editor, '/'); type(editor, '表格'); });
    const original = editor.getJSON();
    await act(async () => { press(editor, 'Enter'); });
    expect(editor.getJSON()).toEqual(original);
    expect(isSlashMenuOpen(editor.view)).toBe(false);
  });
});
