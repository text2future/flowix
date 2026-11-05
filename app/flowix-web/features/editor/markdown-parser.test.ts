import { Editor, type JSONContent } from '@tiptap/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMarkdownEditorExtensions, serializeEditorMarkdown } from './markdown-editor-extensions';

type Request = { id: number; markdown: string };
type Reply = { ok: boolean; document?: JSONContent; error?: string };
let receive: (event: MessageEvent<Request>) => void;
let reply: Reply;
const editors: Editor[] = [];

beforeAll(async () => {
  vi.stubGlobal('self', {
    addEventListener: (_type: string, callback: typeof receive) => { receive = callback; },
    postMessage: (value: Reply) => { reply = value; },
  });
  await import('./markdown-parser.worker');
});

afterEach(() => editors.splice(0).forEach(editor => editor.destroy()));
afterAll(() => vi.unstubAllGlobals());

function parseInWorker(markdown: string): JSONContent {
  receive({ data: { id: 1, markdown } } as MessageEvent<Request>);
  expect(reply.ok, reply.error).toBe(true);
  return reply.document!;
}

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

describe('Markdown worker and browser compatibility', () => {
  it.each([' ', '\u00a0', '&nbsp;', '&amp;nbsp;', '&NBSP;', '&nbsp; &amp;nbsp;'])
    ('opens and saves empty table headers and cells without placeholders: %s', marker => {
      const source = tableSource(marker);
      const workerDocument = parseInWorker(source);
      const workerTable = workerDocument.content?.find(node => node.type === 'table');
      for (const row of workerTable!.content!) {
        expect(row.content?.[0].content).toEqual([{ type: 'paragraph', content: [] }]);
      }

      const editor = createEditor(workerDocument);
      expect(editor.getJSON()).toEqual(createEditor(source).getJSON());
      const expected = editor.getJSON();
      const saved = serializeEditorMarkdown(editor);
      expect(saved).not.toMatch(/&(?:amp;)*nbsp;/i);
      expect(saved).toContain('Before');
      expect(saved).toContain('After');
      editor.commands.setContent(saved, { contentType: 'markdown' });
      expect(editor.getJSON()).toEqual(expected);
      expect(createEditor(parseInWorker(saved)).getJSON()).toEqual(expected);
    });

  it.each([
    ['&amp;amp;nbsp;', '&amp;nbsp;', undefined],
    ['**&nbsp;**', '&nbsp;', 'bold'],
    ['`&nbsp;`', '&nbsp;', 'code'],
    ['text &nbsp;', 'text &nbsp;', undefined],
  ])('preserves non-placeholder table content: %s', (source, text, mark) => {
    const editor = createEditor(parseInWorker(tableSource(source!)));
    const expected = createEditor(tableSource(source!)).getJSON();
    expect(editor.getJSON()).toEqual(expected);
    const table = editor.state.doc.child(1);
    expect(table.child(1).child(0).textContent).toBe(text);
    if (mark) expect(table.child(1).child(0).firstChild?.firstChild?.marks[0].type.name).toBe(mark);
    const saved = serializeEditorMarkdown(editor);
    expect(createEditor(saved).getJSON()).toEqual(expected);
    expect(createEditor(parseInWorker(saved)).getJSON()).toEqual(expected);
  });

  it('parses escaped pipes without changing adjacent placeholders', () => {
    const source = tableSource('left \\| &nbsp;');
    const editor = createEditor(parseInWorker(source));
    expect(editor.state.doc.child(1).child(1).child(0).textContent).toBe('left | &nbsp;');
    expect(editor.getJSON()).toEqual(createEditor(source).getJSON());
  });

  it.each([
    ['A\n\n&nbsp;\n\n&nbsp;\n\nB', 2],
    ['A\n\n&amp;nbsp;\n\nB', 1],
    ['A\n\n\n\nB', 1],
    ['\n\nA\n\n', 2],
    ['A\n\nB', 0],
  ])('preserves document empty paragraphs across save and reopen: %s', (source, emptyCount) => {
    const document = parseInWorker(source);
    expect(document.content?.filter(node => node.type === 'paragraph' && !node.content?.length))
      .toHaveLength(emptyCount);
    const editor = createEditor(document);
    expect(editor.getJSON()).toEqual(createEditor(source).getJSON());
    const saved = serializeEditorMarkdown(editor);
    expect(createEditor(parseInWorker(saved)).getJSON()).toEqual(editor.getJSON());
  });

  it('leaves table-like lines inside a code block untouched', () => {
    const code = '| &nbsp; | &amp;nbsp; |';
    const source = `\`\`\`text\n${code}\n\`\`\``;
    const document = parseInWorker(source);
    expect(document.content?.[0].content?.[0].text).toBe(code);
    expect(createEditor(source).getJSON()).toEqual(createEditor(document).getJSON());
  });
});
