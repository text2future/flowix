import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { AsteriskOnlyBold } from '@features/editor/extensions/asterisk-only-bold';
import { LiteralUnderscoreStrong } from '@features/editor/extensions/literal-underscore-markdown';
import MarkdownPaste from '@features/editor/extensions/markdown-paste';

const pasteEvent = { clipboardData: null } as unknown as ClipboardEvent;

/**
 * The managed paste rules handle most clipboard payloads, but a rich-HTML paste
 * (or any paste they decline) still lands on the native ProseMirror path. These
 * cases pin down what that fallback does with Markdown-looking text.
 */
function pasteHtml(html: string): Editor {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ bold: false }),
      AsteriskOnlyBold,
      LiteralUnderscoreStrong,
      MarkdownPaste,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    ],
    content: '',
    contentType: 'markdown',
  });
  editor.view.pasteHTML(html, pasteEvent);
  return editor;
}

function appliedMarks(editor: Editor): string[] {
  const paragraph = editor.getJSON().content?.[0];
  return (paragraph?.content ?? []).flatMap(node => (node.marks ?? []).map(mark => mark.type ?? ''));
}

describe('markdown paste rules on the native paste path', () => {
  it('keeps dunder identifiers as plain text', () => {
    const editor = pasteHtml('<p>__pycache__</p>');

    expect(editor.getText()).toBe('__pycache__');
    expect(appliedMarks(editor)).toEqual([]);
    expect(editor.markdown?.serialize(editor.getJSON())).toBe('__pycache__');
    editor.destroy();
  });

  it('keeps a dunder identifier inside a sentence', () => {
    const editor = pasteHtml('<p>删除 __pycache__ 目录</p>');

    expect(editor.getText()).toBe('删除 __pycache__ 目录');
    expect(appliedMarks(editor)).toEqual([]);
    editor.destroy();
  });

  it('still applies asterisk bold, asterisk and underscore italic, code and strike', () => {
    const cases: Array<[string, string]> = [
      ['<p>**重点**</p>', 'bold'],
      ['<p>*斜*</p>', 'italic'],
      ['<p>_斜_</p>', 'italic'],
      ['<p>`code`</p>', 'code'],
      ['<p>~~del~~</p>', 'strike'],
    ];

    for (const [html, mark] of cases) {
      const editor = pasteHtml(html);
      expect({ html, marks: appliedMarks(editor) }).toEqual({ html, marks: [mark] });
      editor.destroy();
    }
  });

  it('skips mark rules the schema does not provide instead of throwing', () => {
    // No bold mark in this schema: the old rule resolution reached
    // `undefined.create()` and broke the paste transaction.
    const editor = new Editor({
      extensions: [StarterKit.configure({ bold: false }), MarkdownPaste, Markdown.configure()],
      content: '',
      contentType: 'markdown',
    });

    expect(() => editor.view.pasteHTML('<p>**重点**</p>', pasteEvent)).not.toThrow();
    editor.destroy();
  });
});
