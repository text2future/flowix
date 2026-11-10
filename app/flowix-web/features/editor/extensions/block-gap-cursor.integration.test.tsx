import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor, Node } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { TextSelection } from '@tiptap/pm/state';
import { TabCharacter } from './tab-character';
import { TabAgentRun } from './tab-agent-run';
import { BlockGapCursor } from './block-gap-cursor';
import { SlashMenu, isSlashMenuOpen } from './slash-menu';
import ManagedPasteRules from './paste-rules';
import { handleFileUpload } from './attachment-link/upload/plugin';
import { insertUploadContent } from './attachment-link/upload/build-content';

vi.mock('./attachment-link/upload/plugin', () => ({ handleFileUpload: vi.fn() }));
vi.mock('@features/agent/public/runtime-status-api', () => ({
  getAgentRuntimeStatusSnapshot: () => ({ hasChecked: true, isChecking: false, statusByType: {} }),
  getAvailableAgentTypes: () => [],
  subscribeAgentRuntimeStatus: () => () => {},
  refreshAgentRuntimeStatusIfStale: async () => {},
}));
// Render only the selected index; keep the real menu state, lifecycle, items,
// and key handlers so these tests exercise arbitration with the native cursor.
vi.mock('@features/editor/components/slash-menu-dropdown', async importOriginal => {
  const original = await importOriginal<typeof import('@features/editor/components/slash-menu-dropdown')>();
  return {
    ...original,
    SlashMenuDropdown: ({ selectedIndex }: { selectedIndex: number }) => <div data-testid="slash-selection">{selectedIndex}</div>,
  };
});

const editors: Editor[] = [];

function createEditor(content: JSONContent[] = [{ type: 'card' }, { type: 'card' }]) {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ gapcursor: false, trailingNode: false }),
      Markdown,
      Node.create({ name: 'card', group: 'block', atom: true, selectable: false, renderHTML: () => ['section'] }),
      Node.create({ name: 'fileAttachment', group: 'inline', inline: true, atom: true, renderHTML: () => ['span'] }),
      ManagedPasteRules,
      BlockGapCursor,
      SlashMenu,
      TabCharacter,
      TabAgentRun,
    ],
    content: { type: 'doc', content },
  });
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ left: 100, right: 100, top: 100, bottom: 120 });
  vi.spyOn(editor.view, 'endOfTextblock').mockReturnValue(true);
  editors.push(editor);
  return editor;
}

function selectGap(editor: Editor) {
  editor.view.dispatch(editor.state.tr.setSelection(new GapCursor(editor.state.doc.resolve(1))));
}

function type(editor: Editor, text: string) {
  const { from, to } = editor.state.selection;
  const insert = () => editor.state.tr.insertText(text, from, to);
  const handled = editor.view.someProp('handleTextInput', handler => handler(editor.view, from, to, text, insert));
  if (!handled) editor.view.dispatch(insert());
}

/**
 * 原生输入路径：字符由浏览器直接落进文档 (WebKit 的 DOMObserver 回读、
 * IME 合成提交)，ProseMirror 不会再调 handleTextInput。
 */
function typeNative(editor: Editor, text: string, meta?: Record<string, unknown>) {
  const { from, to } = editor.state.selection;
  let tr = editor.state.tr.insertText(text, from, to);
  for (const [key, value] of Object.entries(meta ?? {})) tr = tr.setMeta(key, value);
  editor.view.dispatch(tr);
}

function press(editor: Editor, key: string) {
  editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function paste(editor: Editor, text: string, files: File[] = []) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: {
    types: files.length ? ['Files'] : ['text/plain'], files,
    getData: (type: string) => type === 'text/plain' ? text : '',
  } });
  editor.view.dom.dispatchEvent(event);
  return event;
}

afterEach(async () => {
  await act(async () => {
    for (const editor of editors.splice(0)) {
      const element = editor.options.element as HTMLElement;
      editor.destroy();
      element.remove();
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  vi.clearAllMocks();
});

describe('block gap input integration', () => {
  it('opens the real slash menu when slash is the first input at a gap', async () => {
    const editor = createEditor();
    await act(async () => { selectGap(editor); type(editor, '/'); });
    expect(isSlashMenuOpen(editor.view)).toBe(true);
    expect(editor.state.doc.child(1).textContent).toBe('/');
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    await act(async () => { press(editor, 'Escape'); editor.commands.undo(); });
    expect(editor.state.doc.childCount).toBe(2);
  });

  it.each(['ArrowDown', 'ArrowUp'])('lets the menu own %s next to adjacent cards', async key => {
    const paragraph = { type: 'paragraph' };
    const cards = [{ type: 'card' }, { type: 'card' }];
    const editor = createEditor(key === 'ArrowDown' ? [paragraph, ...cards] : [...cards, paragraph]);
    await act(async () => {
      editor.commands.setTextSelection(key === 'ArrowDown' ? 1 : 3);
      type(editor, '/');
    });
    const before = editor.state.selection;
    expect(document.querySelector('[data-testid="slash-selection"]')?.textContent).toBe('0');
    await act(async () => { press(editor, key); });
    expect(isSlashMenuOpen(editor.view)).toBe(true);
    expect(document.querySelector('[data-testid="slash-selection"]')?.textContent).not.toBe('0');
    expect(editor.state.selection.eq(before)).toBe(true);
    await act(async () => { press(editor, 'Escape'); press(editor, key); });
    expect(isSlashMenuOpen(editor.view)).toBe(false);
    expect(editor.state.selection).toBeInstanceOf(GapCursor);
  });

  it('keeps Tab navigation and Enter selection inside the real menu', async () => {
    const editor = createEditor();
    await act(async () => { selectGap(editor); type(editor, '/'); });
    const before = editor.state.selection;
    await act(async () => { press(editor, 'Tab'); });
    expect(document.querySelector('[data-testid="slash-selection"]')?.textContent).toBe('1');
    expect(editor.state.selection.eq(before)).toBe(true);
    await act(async () => {
      editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[data-testid="slash-selection"]')?.textContent).toBe('0');
    await act(async () => { press(editor, 'Enter'); });
    expect(isSlashMenuOpen(editor.view)).toBe(false);
    expect(editor.state.doc.child(1).type.name).toBe('heading');
    expect(editor.state.doc.child(1).attrs.level).toBe(1);
    expect(editor.state.doc.childCount).toBe(3);
  });

  it('preserves native paste metadata and one-step undo', () => {
    const editor = createEditor();
    selectGap(editor);
    const events: unknown[] = [];
    editor.on('transaction', ({ transaction }) => events.push(transaction.getMeta('uiEvent')));
    editor.view.pasteHTML('<p><strong>pasted</strong></p>', new Event('paste') as ClipboardEvent);
    expect(editor.state.doc.child(1).textContent).toBe('pasted');
    expect(editor.state.doc.child(1).firstChild?.marks[0].type.name).toBe('bold');
    expect(events).toContain('paste');
    editor.commands.undo();
    expect(editor.state.doc.childCount).toBe(2);
  });

  it('routes markdown through managed paste rules', () => {
    const editor = createEditor();
    selectGap(editor);
    paste(editor, '# Heading');
    expect(editor.state.doc.child(1).type.name).toBe('heading');
    expect(editor.state.doc.child(1).textContent).toBe('Heading');
    editor.commands.undo();
    expect(editor.state.doc.childCount).toBe(2);
  });

  it('routes clipboard files to upload at the gap without creating empty paragraphs', () => {
    const editor = createEditor();
    selectGap(editor);
    const file = new File(['image'], 'screenshot.png', { type: 'image/png' });
    const event = paste(editor, '', [file]);
    expect(handleFileUpload).toHaveBeenCalledWith(editor.view, [file], 1, undefined, undefined);
    expect(editor.state.selection).toBeInstanceOf(GapCursor);
    expect(editor.state.doc.childCount).toBe(2);
    expect(event.defaultPrevented).toBe(true);
  });

  it('wraps an uploaded inline attachment at a gap and undoes it atomically', () => {
    const editor = createEditor();
    selectGap(editor);
    const before = editor.getJSON();
    insertUploadContent(editor.view, [{ type: 'fileAttachment' }], 1);
    expect(editor.state.doc.child(1).type.name).toBe('paragraph');
    expect(editor.state.doc.child(1).firstChild?.type.name).toBe('fileAttachment');
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
  });
});

describe('slash trigger on native input paths', () => {
  it('opens the menu when the character bypasses handleTextInput', async () => {
    const editor = createEditor([{ type: 'paragraph' }]);
    await act(async () => { editor.commands.setTextSelection(1); typeNative(editor, '/'); });
    expect(editor.state.doc.textContent).toBe('/');
    expect(isSlashMenuOpen(editor.view)).toBe(true);
  });

  it('opens the menu after an IME composition commit', async () => {
    const editor = createEditor([{ type: 'paragraph' }]);
    await act(async () => {
      editor.commands.setTextSelection(1);
      editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      typeNative(editor, '/');
      editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '/' }));
    });
    expect(isSlashMenuOpen(editor.view)).toBe(true);
  });

  it('ignores slashes typed inside a word', async () => {
    const editor = createEditor([{ type: 'paragraph', content: [{ type: 'text', text: 'ab' }] }]);
    await act(async () => { editor.commands.setTextSelection(4); typeNative(editor, '/'); });
    expect(editor.state.doc.textContent).toBe('ab/');
    expect(isSlashMenuOpen(editor.view)).toBe(false);
  });

  it('does not treat pasted or history-free edits as typing', async () => {
    const editor = createEditor([{ type: 'paragraph' }]);
    await act(async () => { editor.commands.setTextSelection(1); typeNative(editor, '/', { uiEvent: 'paste' }); });
    expect(isSlashMenuOpen(editor.view)).toBe(false);

    await act(async () => { editor.commands.setTextSelection(2); typeNative(editor, '/', { addToHistory: false }); });
    expect(isSlashMenuOpen(editor.view)).toBe(false);
  });

  it('keeps the menu open while the composition buffer is still half-formed', async () => {
    const editor = createEditor([{ type: 'paragraph' }]);
    await act(async () => { editor.commands.setTextSelection(1); type(editor, '/'); });
    expect(isSlashMenuOpen(editor.view)).toBe(true);

    // 合成中的事务会带进半成品文本 (含空格时 query 判定为失效)，不能据此关菜单。
    await act(async () => {
      editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      typeNative(editor, ' ');
    });
    expect(isSlashMenuOpen(editor.view)).toBe(true);

    await act(async () => {
      editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      await new Promise(resolve => window.setTimeout(resolve, 0));
    });
    expect(isSlashMenuOpen(editor.view)).toBe(false);
  });
});
