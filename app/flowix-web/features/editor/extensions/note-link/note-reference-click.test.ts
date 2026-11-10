import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it, vi } from 'vitest';

const navigationMocks = vi.hoisted(() => ({
  openNoteByNotebookPath: vi.fn(async () => undefined),
  openNoteByPhysicalPath: vi.fn(async () => undefined),
}));

vi.mock('@features/memo/public/note-navigation-api', () => navigationMocks);

import { NoteReference } from './view-note';

function createEditorWithReference(): Editor {
  const editor = new Editor({
    extensions: [StarterKit, NoteReference],
    content: '<p></p>',
  });
  editor.commands.insertContent({
    type: 'noteReference',
    attrs: {
      notebookId: 'work',
      relativePath: 'Projects/Plan.md',
      notebookName: 'Work',
      title: 'Plan',
      originalPath: null,
      linkStyle: 'flowix',
      linkTarget: null,
      heading: null,
      stale: false,
    },
  });
  return editor;
}

function cardOf(editor: Editor): HTMLElement {
  const card = editor.view.dom.querySelector<HTMLElement>('.note-reference__card');
  if (!card) throw new Error('note reference card missing');
  return card;
}

describe('note reference interaction in the document body', () => {
  it('opens the target note on a single click', async () => {
    navigationMocks.openNoteByNotebookPath.mockClear();
    const editor = createEditorWithReference();

    cardOf(editor).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(navigationMocks.openNoteByNotebookPath).toHaveBeenCalledWith(
      'work',
      'Projects/Plan.md',
      null,
    );
    editor.destroy();
  });

  it('opens only once for a real double click (two clicks + dblclick)', async () => {
    navigationMocks.openNoteByNotebookPath.mockClear();
    const editor = createEditorWithReference();

    // 浏览器双击的完整序列: click → click → dblclick。单击即打开后, 第二次
    // click 不能把同一篇文档再打开一遍。
    const card = cardOf(editor);
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(navigationMocks.openNoteByNotebookPath).toHaveBeenCalledTimes(1);
    editor.destroy();
  });

  it('does not select the atom on click, so no selection tint flashes', async () => {
    navigationMocks.openNoteByNotebookPath.mockClear();
    const editor = createEditorWithReference();

    cardOf(editor).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const wrapper = editor.view.dom.querySelector('.editor-note-reference');
    expect(wrapper?.classList.contains('is-selected')).toBe(false);
    expect(editor.state.selection).not.toBeNull();
    expect(editor.state.selection.constructor.name).not.toBe('NodeSelection');
    editor.destroy();
  });
});
