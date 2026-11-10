import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createMarkdownEditorExtensions, serializeEditorMarkdown } from './markdown-editor-extensions';

const editors: Editor[] = [];

afterEach(() => editors.splice(0).forEach(editor => editor.destroy()));

function createEditor(content: string | JSONContent): Editor {
  const editor = new Editor({
    extensions: createMarkdownEditorExtensions({
      getOwnerPath: () => undefined,
      getAttachmentNotebookId: () => undefined,
      workspaceHost: 'column-1',
      getPlaceholder: () => '',
    }),
    content,
    contentType: typeof content === 'string' ? 'markdown' : 'json',
  });
  editors.push(editor);
  return editor;
}

function tableSource(value: string): string {
  return `Before\n\n| ${value} | H |\n| --- | --- |\n| ${value} | value |\n\nAfter`;
}

describe('Markdown parsing and browser compatibility', () => {
  it.each([' ', '\u00a0', '&nbsp;', '&amp;nbsp;', '&NBSP;', '&nbsp; &amp;nbsp;'])
    ('opens and saves empty table headers and cells without placeholders: %s', marker => {
      const source = tableSource(marker);
      const editor = createEditor(source);
      const parsedTable = (editor.getJSON() as JSONContent).content?.find(node => node.type === 'table');
      for (const row of parsedTable!.content!) {
        const cellParagraph = row.content?.[0].content?.[0];
        expect(cellParagraph?.type).toBe('paragraph');
        expect(cellParagraph?.content ?? []).toHaveLength(0);
      }

      const expected = editor.getJSON();
      const saved = serializeEditorMarkdown(editor);
      expect(saved).not.toMatch(/&(?:amp;)*nbsp;/i);
      expect(saved).toContain('Before');
      expect(saved).toContain('After');
      editor.commands.setContent(saved, { contentType: 'markdown' });
      expect(editor.getJSON()).toEqual(expected);
      expect(createEditor(saved).getJSON()).toEqual(expected);
    });

  it.each([
    ['&amp;amp;nbsp;', '&amp;nbsp;', undefined],
    ['**&nbsp;**', '&nbsp;', 'bold'],
    ['`&nbsp;`', '&nbsp;', 'code'],
    ['text &nbsp;', 'text &nbsp;', undefined],
  ])('preserves non-placeholder table content: %s', (source, text, mark) => {
    const editor = createEditor(tableSource(source!));
    const expected = editor.getJSON();
    const table = editor.state.doc.child(1);
    expect(table.child(1).child(0).textContent).toBe(text);
    if (mark) expect(table.child(1).child(0).firstChild?.firstChild?.marks[0].type.name).toBe(mark);
    const saved = serializeEditorMarkdown(editor);
    expect(createEditor(saved).getJSON()).toEqual(expected);
  });

  it('parses escaped pipes without changing adjacent placeholders', () => {
    const editor = createEditor(tableSource('left \\| &nbsp;'));
    expect(editor.state.doc.child(1).child(1).child(0).textContent).toBe('left | &nbsp;');
  });

  it.each([
    ['A\n\n&nbsp;\n\n&nbsp;\n\nB', 2],
    ['A\n\n&amp;nbsp;\n\nB', 1],
    ['A\n\n\n\nB', 1],
    ['\n\nA\n\n', 2],
    ['A\n\nB', 0],
  ])('preserves document empty paragraphs across save and reopen: %s', (source, emptyCount) => {
    const editor = createEditor(source);
    const document = editor.getJSON();
    expect(document.content?.filter(node => node.type === 'paragraph' && !node.content?.length))
      .toHaveLength(emptyCount);
    const saved = serializeEditorMarkdown(editor);
    expect(createEditor(saved).getJSON()).toEqual(document);
  });

  it('leaves table-like lines inside a code block untouched', () => {
    const code = '| &nbsp; | &amp;nbsp; |';
    const source = `\`\`\`text\n${code}\n\`\`\``;
    const document = createEditor(source).getJSON() as JSONContent;
    expect(document.content?.[0].content?.[0].text).toBe(code);
  });
});
