import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createMarkdownEditorExtensions } from '../markdown-editor-extensions';

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
});

function createEditor(content: string): Editor {
  const editor = new Editor({
    extensions: createMarkdownEditorExtensions({
      getOwnerPath: () => undefined,
      getAttachmentNotebookId: () => undefined,
      workspaceHost: 'column-1',
      getPlaceholder: () => '',
    }),
    content,
    contentType: 'markdown',
  });
  editors.push(editor);
  return editor;
}

/** Tag names of the elements carrying `.editor-first-block` / `.editor-leading-block`. */
function markOf(editor: Editor, className: string): string[] {
  const marked: string[] = [];
  editor.view.dom.querySelectorAll(`.${className}`).forEach((element) => {
    marked.push(element.tagName.toLowerCase());
  });
  return marked;
}

const FRONTMATTER_AND_BODY = [
  '---',
  'title: frontmatter is chrome',
  '---',
  '',
  '## First body block',
  '',
  'Second block.',
].join('\n');

describe('EditorFirstBlockMark', () => {
  it('marks one content block after the frontmatter', () => {
    const editor = createEditor(FRONTMATTER_AND_BODY);

    expect(markOf(editor, 'editor-first-block')).toEqual(['h2']);
    expect(markOf(editor, 'editor-leading-block')).toEqual(['h2']);
  });

  it('marks a code block that opens the document', () => {
    const editor = createEditor(['```ts', 'const value = 1;', '```', '', 'After.'].join('\n'));

    expect(markOf(editor, 'editor-first-block')).toEqual(['pre']);
  });

  it('treats a leading agent card as chrome for content but as a block for the caret', () => {
    const editor = createEditor('');
    const card = editor.schema.nodes.agentThreadCard.create({ threadId: 'thread-1' });
    editor.commands.setContent({
      type: 'doc',
      content: [card.toJSON(), { type: 'paragraph', content: [{ type: 'text', text: 'After the card.' }] }],
    });

    // The card owns its own top offset, so the content offset skips it…
    expect(markOf(editor, 'editor-first-block')).toEqual(['p']);
    // …while the gap above the card still needs the caret compensation.
    expect(markOf(editor, 'editor-leading-block')).toEqual(['section']);
  });

  it('moves the mark when the first block is removed', () => {
    const editor = createEditor(['# First', '', 'Second.', '', 'Third.'].join('\n'));
    expect(markOf(editor, 'editor-first-block')).toEqual(['h1']);

    editor.commands.setContent('Second.\n\nThird.', { contentType: 'markdown' });

    expect(markOf(editor, 'editor-first-block')).toEqual(['p']);
  });

  it('marks the implicit empty paragraph of an empty document', () => {
    // ProseMirror always keeps one textblock; the stylesheet excludes
    // `h1`-`p` from the first-block offsets, so marking it is harmless.
    const editor = createEditor('');

    expect(markOf(editor, 'editor-first-block')).toEqual(['p']);
  });
});
