import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { AsteriskOnlyBold } from '@features/editor/extensions/asterisk-only-bold';
import { LiteralUnderscoreStrong } from '@features/editor/extensions/literal-underscore-markdown';
import { executeManagedPasteRules } from '@features/editor/extensions/paste-rules/rules';

function createEditor(): Editor {
  return new Editor({
    extensions: [
      // Mirrors the production editor: asterisk-only bold plus the literal
      // underscore tokenizer, without the stock underscore rules.
      StarterKit.configure({ bold: false }),
      AsteriskOnlyBold,
      LiteralUnderscoreStrong,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    ],
    content: '',
    contentType: 'markdown',
  });
}

function parseInline(markdown: string) {
  const editor = createEditor();
  const json = editor.markdown?.parse(markdown);
  const serialized = json ? editor.markdown?.serialize(json) : undefined;
  editor.destroy();
  return { json, serialized };
}

function firstParagraphContent(markdown: string) {
  const { json } = parseInline(markdown);
  return json?.content?.[0]?.content ?? [];
}

describe('literal underscore markdown', () => {
  it('keeps double underscores as plain text', () => {
    const content = firstParagraphContent('__pycache__');

    expect(content).toHaveLength(1);
    expect(content[0].text).toBe('__pycache__');
    expect(content[0].marks).toBeUndefined();
  });

  it('keeps dunder identifiers intact inside a path and next to a suffix', () => {
    expect(firstParagraphContent('app/__pycache__/module.py').map(node => node.text).join(''))
      .toBe('app/__pycache__/module.py');
    expect(firstParagraphContent('__init__.py').map(node => node.text).join(''))
      .toBe('__init__.py');
  });

  it('still parses asterisk bold and italic', () => {
    const bold = firstParagraphContent('**加粗**');
    expect(bold).toEqual([{ type: 'text', text: '加粗', marks: [{ type: 'bold' }] }]);

    const italic = firstParagraphContent('*斜体*');
    expect(italic).toEqual([{ type: 'text', text: '斜体', marks: [{ type: 'italic' }] }]);
  });

  it('round-trips literal underscores without rewriting them to bold', () => {
    const { serialized } = parseInline('__pycache__ 与 **重点**');

    expect(serialized).toBe('__pycache__ 与 **重点**');
  });

  it('leaves underscores alone inside code spans and fenced blocks', () => {
    const { serialized } = parseInline('`__pycache__`\n\n```bash\nrm -rf __pycache__\n```');

    expect(serialized).toContain('`__pycache__`');
    expect(serialized).toContain('rm -rf __pycache__');
  });

  it('does not route a plain-text paste of __x__ through the Markdown parser', () => {
    const editor = createEditor();
    const paste = (text: string) => executeManagedPasteRules({
      editor,
      view: editor.view,
      event: new Event('paste') as ClipboardEvent,
      types: ['text/plain'],
      markdown: '',
      text,
      html: '',
      uriList: [],
      files: [],
      sourceMime: 'text/plain',
    });

    // No managed rule claims the identifier, so the native paste keeps it as
    // typed. Asterisk Markdown is still claimed and parsed.
    expect(paste('__pycache__')).toBe('continue');
    expect(paste('**重点**')).toBe('handled');
    expect(editor.getText()).toBe('重点');
    editor.destroy();
  });
});
