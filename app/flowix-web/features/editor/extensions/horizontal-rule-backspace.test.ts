import { Editor, type JSONContent } from '@tiptap/core';
import { act } from 'react';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { closeHistory } from '@tiptap/pm/history';
import { TextSelection } from '@tiptap/pm/state';
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

function pressBackspace(editor: Editor) {
  editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
}

/** Simulates one typed character so input rules see the same pipeline as typing. */
function type(editor: Editor, text: string) {
  const { from, to } = editor.state.selection;
  const handled = editor.view.someProp('handleTextInput', handler => handler(
    editor.view, from, to, text, () => editor.state.tr.insertText(text, from, to),
  ));
  if (!handled) editor.view.dispatch(editor.state.tr.insertText(text, from, to));
}

function nodePos(editor: Editor, type: string): number {
  let pos = -1;
  editor.state.doc.descendants((node, position) => {
    if (pos === -1 && node.type.name === type) pos = position;
  });
  expect(pos).toBeGreaterThanOrEqual(0);
  return pos;
}

const blockTypes = (editor: Editor) => editor.getJSON().content?.map(node => node.type);

describe('divider Backspace', () => {
  it('crosses a divider created by the `---` input rule instead of reverting it to text', () => {
    act(() => {
      const editor = createEditor([
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'paragraph' },
      ]);
      // Caret at the start of the trailing empty paragraph where the rule fires.
      editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 1);
      '---'.split('').forEach(char => type(editor, char));
      expect(blockTypes(editor)).toEqual(['paragraph', 'horizontalRule', 'paragraph']);
      expect(editor.state.selection.from).toBe(10);

      // Close the input-rule history group so undo isolates this Backspace.
      editor.view.dispatch(closeHistory(editor.state.tr));
      pressBackspace(editor);

      // The empty block collapses and the divider survives as a divider.
      expect(blockTypes(editor)).toEqual(['paragraph', 'horizontalRule']);
      expect(editor.state.doc.firstChild?.textContent).toBe('before');
      expect(editor.state.selection.from).toBe(7);

      editor.commands.undo();
      expect(blockTypes(editor)).toEqual(['paragraph', 'horizontalRule', 'paragraph']);
    });
  });

  it('keeps a divider that opens the document and parks the caret before it', () => {
    act(() => {
      const editor = createEditor([{ type: 'horizontalRule' }, { type: 'paragraph' }]);
      editor.commands.setTextSelection(2);

      pressBackspace(editor);

      expect(blockTypes(editor)).toEqual(['horizontalRule']);
      expect(editor.state.selection).toBeInstanceOf(GapCursor);
      expect(editor.state.selection.from).toBe(0);
    });
  });

  it('removes only the empty block and keeps what follows the divider', () => {
    act(() => {
      const editor = createEditor([
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'horizontalRule' },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
      ]);
      editor.commands.setTextSelection(nodePos(editor, 'horizontalRule') + 2);

      pressBackspace(editor);

      expect(blockTypes(editor)).toEqual(['paragraph', 'horizontalRule', 'paragraph']);
      expect(editor.state.doc.textContent).toBe('ax');
      expect(editor.state.selection.from).toBe(2);
    });
  });

  it('crosses the divider from the start of a paragraph that has text', () => {
    act(() => {
      const editor = createEditor([
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'horizontalRule' },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ]);
      const before = editor.getJSON();
      editor.commands.setTextSelection(nodePos(editor, 'horizontalRule') + 2);

      pressBackspace(editor);

      expect(editor.getJSON()).toEqual(before);
      expect(editor.state.selection.from).toBe(2);
    });
  });

  it('leaves the divider alone when the caret is not at the block start', () => {
    act(() => {
      const editor = createEditor([
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'horizontalRule' },
        { type: 'paragraph', content: [{ type: 'text', text: 'bc' }] },
      ]);
      const before = editor.getJSON();
      // Between "b" and "c": the native character deletion path owns this key.
      editor.commands.setTextSelection(nodePos(editor, 'horizontalRule') + 3);

      pressBackspace(editor);

      expect(editor.getJSON()).toEqual(before);
      expect(editor.state.selection.from).toBe(nodePos(editor, 'horizontalRule') + 3);
    });
  });

  it('crosses the divider from the gap directly below it without throwing', () => {
    act(() => {
      const editor = createEditor([
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'i' }] }] }] },
        { type: 'horizontalRule' },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ]);
      const dividerPos = nodePos(editor, 'horizontalRule');
      // Clicked into the boundary between the divider and the block below it.
      editor.view.dispatch(editor.state.tr.setSelection(new GapCursor(editor.state.doc.resolve(dividerPos + 1))));
      pressBackspace(editor);

      expect(blockTypes(editor)).toEqual(['bulletList', 'horizontalRule', 'paragraph']);
      expect(editor.state.selection).toBeInstanceOf(TextSelection);
      // Caret lands at the end of the list text above the divider.
      expect(editor.state.selection.$from.parent.textContent).toBe('i');
      expect(editor.state.selection.$from.parentOffset).toBe(1);
    });
  });

  it('deletes a divider that is selected on purpose', () => {
    act(() => {
      const editor = createEditor([
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'horizontalRule' },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ]);
      editor.commands.setNodeSelection(nodePos(editor, 'horizontalRule'));

      pressBackspace(editor);

      expect(blockTypes(editor)).not.toContain('horizontalRule');
      expect(editor.state.doc.textContent.includes('---')).toBe(false);
    });
  });
});
