import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it, vi } from 'vitest';

const navigationMocks = vi.hoisted(() => ({
  openNoteByNotebookPath: vi.fn(async () => undefined),
  openNoteByPhysicalPath: vi.fn(async () => undefined),
}));

vi.mock('@features/memo/public/note-navigation-api', () => navigationMocks);

import { NoteReference, createNoteReferenceExtension } from './view-note';

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

/** Same-notebook reference: no notebook of its own, resolved from the document. */
function createEditorWithRelativeReference(ownerNotebookId: string | null): Editor {
  const editor = new Editor({
    extensions: [StarterKit, createNoteReferenceExtension('document', {
      getOwnerNotebookId: () => ownerNotebookId,
    })],
    content: '<p></p>',
  });
  editor.commands.insertContent({
    type: 'noteReference',
    attrs: {
      notebookId: null,
      relativePath: 'Projects/Plan.md',
      notebookName: '',
      title: 'Plan',
      originalPath: null,
      linkStyle: 'flowix',
      linkTarget: 'flowix://open?f=Projects%2FPlan.md',
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

  it('opens a same-notebook reference inside the owning notebook', async () => {
    navigationMocks.openNoteByNotebookPath.mockClear();
    const editor = createEditorWithRelativeReference('owner-book');

    cardOf(editor).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(navigationMocks.openNoteByNotebookPath).toHaveBeenCalledWith(
      'owner-book',
      'Projects/Plan.md',
      null,
    );
    editor.destroy();
  });

  it('falls back to the deep-link opener when no notebook owns the document', async () => {
    navigationMocks.openNoteByNotebookPath.mockClear();
    navigationMocks.openNoteByPhysicalPath.mockClear();
    const editor = createEditorWithRelativeReference(null);

    cardOf(editor).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // No owner to resolve `f` against: the opener rejects with a clear error,
    // which the card surfaces as a stale reference.
    expect(navigationMocks.openNoteByNotebookPath).not.toHaveBeenCalled();
    expect(navigationMocks.openNoteByPhysicalPath).toHaveBeenCalledWith('flowix://open?f=Projects%2FPlan.md');
    editor.destroy();
  });
});
