import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigationMocks = vi.hoisted(() => ({
  openNoteByNotebookPath: vi.fn(async () => undefined),
  openNoteByPhysicalPath: vi.fn(async () => undefined),
}));

vi.mock('@platform/tauri/client', async importOriginal => {
  const actual = await importOriginal<typeof import('@platform/tauri/client')>();
  return { ...actual, files: { ...actual.files, resolveLocation: vi.fn(async (path: string) => ({
    path, isDirectory: false, notebookId: null, notebookPath: null,
  })) } };
});
vi.mock('@features/memo/public/note-navigation-api', () => navigationMocks);

import { toast } from '@/lib/toast';
import { createNoteReferenceExtension } from './view-note';

const notebooks = [
  { id: 'work', name: 'Work', path: '/work' },
  { id: 'owner-book', name: 'Owner', path: '/owner' },
];
const NoteReference = createNoteReferenceExtension('document', {
  getReferenceContext: () => ({ documentPath: '/work/source.md', notebooks }),
});
beforeEach(() => vi.clearAllMocks());

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
      getReferenceContext: () => ({ documentPath: '/owner/source.md', notebookId: ownerNotebookId ?? undefined, notebooks }),
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

    expect(navigationMocks.openNoteByPhysicalPath).toHaveBeenCalledWith('/work/Projects/Plan.md', null);
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

    expect(navigationMocks.openNoteByPhysicalPath).toHaveBeenCalledTimes(1);
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

    expect(navigationMocks.openNoteByPhysicalPath).toHaveBeenCalledWith('/owner/Projects/Plan.md', null);
    editor.destroy();
  });

  it('marks a legacy reference without an owning notebook as stale', async () => {
    navigationMocks.openNoteByNotebookPath.mockClear();
    navigationMocks.openNoteByPhysicalPath.mockClear();
    const editor = createEditorWithRelativeReference(null);

    cardOf(editor).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // An unresolved notebook-relative target stays stale and never opens another note.
    expect(navigationMocks.openNoteByNotebookPath).not.toHaveBeenCalled();
    expect(navigationMocks.openNoteByPhysicalPath).not.toHaveBeenCalled();
    expect(cardOf(editor).getAttribute('data-stale')).toBe('true');
    editor.destroy();
  });
});

it('notifies on a Wiki self-reference without reopening the document', async () => {
  const notice = vi.spyOn(toast, 'info').mockReturnValue(1);
  const editor = createEditorWithReference();
  try {
    editor.commands.setContent('<p><note path="/work/source.md">source</note></p>');
    cardOf(editor).click();
    await vi.waitFor(() => expect(notice).toHaveBeenCalledOnce());
    expect(navigationMocks.openNoteByPhysicalPath).not.toHaveBeenCalled();
  } finally { editor.destroy(); notice.mockRestore(); }
});

it('routes Wiki clicks through the same document host callback as Markdown links', async () => {
  const openLocalPath = vi.fn(async () => {});
  const editor = new Editor({ extensions: [StarterKit, createNoteReferenceExtension('document', {
    getReferenceContext: () => ({ documentPath: '/work/source.md', notebooks }),
    getLinkContext: () => ({ documentPath: '/work/source.md', openLocalPath }),
  })], content: '<p><note path="/work/target.md">target</note></p>' });
  try {
    cardOf(editor).click();
    await vi.waitFor(() => expect(openLocalPath).toHaveBeenCalledWith({ path: '/work/target.md', anchor: null }));
    expect(navigationMocks.openNoteByPhysicalPath).not.toHaveBeenCalled();
  } finally { editor.destroy(); }
});
