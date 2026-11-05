import { Editor, type JSONContent } from '@tiptap/core';
import { act } from 'react';
import { NodeSelection } from '@tiptap/pm/state';
import { Slice } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownEditorExtensions } from '../markdown-editor-extensions';

const editors: Editor[] = [];

afterEach(() => {
  act(() => { editors.splice(0).forEach(editor => editor.destroy()); });
  vi.restoreAllMocks();
});

function createEditor(content: JSONContent[]) {
  const editor = new Editor({
    extensions: createMarkdownEditorExtensions({
      getOwnerPath: () => undefined,
      getAttachmentNotebookId: () => undefined,
      workspaceHost: 'column-1',
      getPlaceholder: () => '',
    }),
    content: { type: 'doc', content },
  });
  editors.push(editor);
  return editor;
}
function press(editor: Editor) {
  editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
}

function nodes(editor: Editor, type: string) {
  const found: unknown[] = [];
  editor.state.doc.descendants(node => { if (node.type.name === type) found.push(node.toJSON()); });
  return found;
}

const embeds = ['agentThreadCard', 'tableReference', 'mediaLibraryReference'];
describe('embedded block Backspace with production extensions', () => {
  for (const container of ['doc', 'blockquote', 'listItem']) {
    it.each(embeds)(`preserves %s and removes only its empty paragraph in ${container}`, type => {
      act(() => {
        const blocks: JSONContent[] = [
          { type, attrs: { relativePath: 'example.yaml', threadId: 'review-thread' } },
          { type: 'paragraph' },
        ];
        const content = container === 'doc' ? blocks : container === 'blockquote'
          ? [{ type: 'blockquote', content: blocks }]
          : [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }, ...blocks] }] }];
        const editor = createEditor(content);
        let pos = 0;
        editor.state.doc.descendants((node, position) => {
          if (node.type.name === type) pos = position + node.nodeSize + 1;
        });
        editor.commands.setTextSelection(pos);
        editor.view.dispatch(closeHistory(editor.state.tr));
        const before = editor.state.doc;
        const embedded = nodes(editor, type);
        press(editor);
        expect(nodes(editor, type)).toEqual(embedded);
        expect(editor.state.doc.eq(before.replace(pos - 1, pos + 1, Slice.empty))).toBe(true);
        editor.state.doc.check();
        const deleted = editor.state.doc;
        press(editor);
        expect(editor.state.doc.eq(deleted)).toBe(true);
        expect(nodes(editor, type)).toEqual(embedded);
        editor.commands.undo();
        expect(editor.state.doc.eq(before)).toBe(true);
        editor.commands.redo();
        expect(editor.state.doc.eq(deleted)).toBe(true);
      });
    });
  }

  it.each([
    { type: 'videoAttachment' },
    { type: 'image' },
    { type: 'videoEmbed', attrs: { sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } },
    { type: 'videoEmbed', attrs: { sourceUrl: 'https://www.bilibili.com/video/BV1xx411c7mD/' } },
  ])('removes the empty paragraph after $type $attrs without requesting a scroll', ({ type, attrs }) => {
    act(() => {
      vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
      const editor = createEditor([{ type, attrs }, { type: 'paragraph' }]);
      editor.commands.setTextSelection(2);
      vi.spyOn(editor.view, 'endOfTextblock').mockReturnValue(true);
      const media = nodes(editor, type);
      // Observe the public transaction flag rather than EditorView internals.
      const transactions: boolean[] = [];
      editor.on('transaction', ({ transaction }) => { transactions.push(transaction.scrolledIntoView); });
      press(editor);
      expect(nodes(editor, type)).toEqual(media);
      expect(editor.state.doc.childCount).toBe(1);
      expect(editor.state.selection).toBeInstanceOf(NodeSelection);
      expect(transactions.length).toBeGreaterThan(0);
      expect(transactions.every(requested => !requested)).toBe(true);
    });
  });

  it('keeps normal paragraph merging', () => {
    act(() => {
      const editor = createEditor([
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'paragraph' },
      ]);
      editor.commands.setTextSelection(9);
      vi.spyOn(editor.view, 'endOfTextblock').mockReturnValue(true);
      press(editor);
      expect(editor.state.doc.childCount).toBe(1);
      expect(editor.state.doc.textContent).toBe('before');
    });
  });
});
