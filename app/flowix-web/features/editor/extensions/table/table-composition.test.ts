import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { createTablePlugin } from './table-plugin';

const editors: Editor[] = [];

function createEditor(tag: 'th' | 'td' = 'th', text = '') {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit, createTablePlugin()],
    content: `<table><tr><${tag}>${text}</${tag}><td></td></tr></table>`,
  });
  editors.push(editor);
  editor.commands.setTextSelection(4 + text.length);
  editor.view.focus();
  return editor;
}

function handleDOMEvent(editor: Editor, event: Event) {
  const plugin = editor.state.plugins.find(plugin => plugin.props.handleDOMEvents?.compositionstart
    && plugin.props.handleDOMEvents?.input)!;
  plugin.props.handleDOMEvents![event.type]!.call(plugin, editor.view, event);
}

function startComposition(editor: Editor) {
  handleDOMEvent(editor, new CompositionEvent('compositionstart'));
}

/** Native WebKit deletes the paragraph, then commits B/text before the cell. */
function malformedCommit(editor: Editor, text: string, wrapper = 'b') {
  const cell = editor.view.dom.querySelector('th,td')!;
  const row = cell.parentNode!;
  const committed = document.createElement(wrapper);
  committed.textContent = text;
  const breakNode = document.createElement('br');
  row.insertBefore(committed, cell);
  row.insertBefore(breakNode, cell);
  cell.replaceChildren(document.createElement('br'));
  window.getSelection()!.collapse(committed.firstChild, text.length);
  return { cell, row, committed, breakNode };
}

function handleCommit(editor: Editor, data: string) {
  handleDOMEvent(editor, new InputEvent('input', {
    inputType: 'insertFromComposition', data,
  }));
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  editors.splice(0).forEach(editor => {
    const element = editor.options.element as HTMLElement;
    editor.destroy();
    element.remove();
  });
});

describe('WebKit empty table cell composition repair', () => {
  it.each(['th', 'td'] as const)('repairs an escaped commit in %s without introducing bold or moving the caret backwards', async tag => {
    const editor = createEditor(tag);
    startComposition(editor);
    editor.commands.insertContent('你好');
    const { cell, row, committed, breakNode } = malformedCommit(editor, '你好');
    handleCommit(editor, '你好');
    expect(cell.innerHTML).toBe('<p>你好</p>');
    expect(row.contains(committed)).toBe(false);
    expect(row.contains(breakNode)).toBe(false);
    const selection = window.getSelection()!;
    expect(selection.anchorNode).toBe(cell.firstChild);
    expect(selection.anchorOffset).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(editor.state.doc.textContent).toBe('你好');
    expect(editor.state.doc.nodeAt(4)!.marks).toEqual([]);
    expect(editor.state.selection.from).toBe(6);
  });

  it('preserves deliberate bold and italic instead of inheriting browser-generated markup', async () => {
    const editor = createEditor();
    editor.commands.toggleBold();
    editor.commands.toggleItalic();
    startComposition(editor);
    editor.commands.insertContent('你好');
    const { cell } = malformedCommit(editor, '你好');
    handleCommit(editor, '你好');
    expect(cell.querySelector('strong em, em strong')?.textContent).toBe('你好');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(editor.state.doc.nodeAt(4)!.marks.map(mark => mark.type.name)).toEqual(['bold', 'italic']);
    expect(editor.state.selection.from).toBe(6);
  });

  it('does not repair compositions that began in a populated header cell', () => {
    const editor = createEditor('th', '已有');
    startComposition(editor);
    const { committed } = malformedCommit(editor, '你好');
    handleCommit(editor, '你好');
    expect(committed.isConnected).toBe(true);
  });

  it('does not move a normal commit that is already inside the paragraph', () => {
    const editor = createEditor();
    startComposition(editor);
    editor.commands.insertContent('你好');
    const cell = editor.view.dom.querySelector('th')!;
    const paragraph = cell.firstChild;
    handleCommit(editor, '你好');
    expect(cell.firstChild).toBe(paragraph);
    expect(editor.state.selection.from).toBe(6);
  });

  it('does not consume mismatched text or unrelated siblings', () => {
    const editor = createEditor();
    startComposition(editor);
    const { cell, row, committed } = malformedCommit(editor, '保留');
    handleCommit(editor, '其他');
    expect(committed.isConnected).toBe(true);
    const unrelated = document.createElement('span');
    row.insertBefore(unrelated, cell);
    handleCommit(editor, '保留');
    expect(committed.isConnected).toBe(true);
    expect(unrelated.isConnected).toBe(true);
  });

  it('only removes direct BR placeholders when composition ends, preserving paragraph-owned breaks', () => {
    const editor = createEditor();
    startComposition(editor);
    const cell = editor.view.dom.querySelector('th')!;
    const paragraph = cell.firstChild!;
    const innerBreak = paragraph.firstChild;
    cell.append(document.createElement('br'));
    handleDOMEvent(editor, new CompositionEvent('compositionend'));
    expect(cell.childNodes).toHaveLength(1);
    expect(paragraph.firstChild).toBe(innerBreak);
    const { committed } = malformedCommit(editor, '你好');
    handleCommit(editor, '你好');
    expect(committed.isConnected).toBe(true);
  });
});
