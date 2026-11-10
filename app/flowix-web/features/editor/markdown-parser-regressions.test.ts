import { Editor, type JSONContent } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { OrderedList, TaskList } from '@tiptap/extension-list';
import { afterEach, describe, expect, it } from 'vitest';
import { createMarkdownEditorExtensions } from './markdown-editor-extensions';
import { FLOWIX_AGENT_THREAD_CARD_MARKER } from '@features/agent/thread-card/agent-thread-card-markdown';

const editorContext = {
  getOwnerPath: () => undefined,
  getAttachmentNotebookId: () => undefined,
  workspaceHost: 'column-1' as const,
  getPlaceholder: () => '',
};

/**
 * Parse through the same registry the editor mounts, but as JSON only: the
 * manager never builds views, so cases that need a Tauri-backed NodeView
 * (images) can still be asserted here.
 */
const manager = new MarkdownManager({
  extensions: createMarkdownEditorExtensions(editorContext),
  markedOptions: { gfm: true, breaks: true },
});

const editors: Editor[] = [];

afterEach(() => editors.splice(0).forEach(editor => editor.destroy()));

function parseMarkdown(markdown: string): JSONContent {
  return manager.parse(markdown);
}

function createEditor(content: string | JSONContent): Editor {
  const editor = new Editor({
    extensions: createMarkdownEditorExtensions(editorContext),
    content,
    contentType: typeof content === 'string' ? 'markdown' : 'json',
  });
  editors.push(editor);
  return editor;
}

function nodeTypes(document: JSONContent): string[] {
  return (document.content ?? []).map(node => node.type ?? '');
}

function documentText(node: JSONContent | undefined): string {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(child => documentText(child)).join('');
}

const cardMetadata = JSON.stringify({
  version: 1,
  threadId: 'thread-1',
  agentType: 'codex',
  collapsed: false,
  fullscreen: false,
});

describe('Markdown parsing of constructs that previously needed the browser parser', () => {
  it('registers guarded list tokenizers instead of the stock ones', () => {
    const extensions = createMarkdownEditorExtensions(editorContext);
    const ordered = extensions.filter(extension => extension.name === 'orderedList');
    const task = extensions.filter(extension => extension.name === 'taskList');
    // Registering both the stock and the guarded extension runs the expensive
    // tokenizer twice, which is slower than not guarding at all.
    expect(ordered).toHaveLength(1);
    expect(task).toHaveLength(1);
    expect(ordered[0]).not.toBe(OrderedList);
    expect(task[0]).not.toBe(TaskList);
  });

  it('keeps a new-form Agent Thread Card as a node', () => {
    const document = parseMarkdown(
      `Before\n\n<!-- ${FLOWIX_AGENT_THREAD_CARD_MARKER} ${cardMetadata} -->\n\nAfter`,
    );
    const card = document.content?.find(node => node.type === 'agentThreadCard');
    expect(card).toBeDefined();
    expect(JSON.stringify(card)).toContain('thread-1');
  });

  it('keeps a legacy Agent Thread Card as a node', () => {
    const document = parseMarkdown(
      'Before\n\n::agent-thread-card{threadId="thread-legacy" agentType="codex"}\n\nAfter',
    );
    const card = document.content?.find(node => node.type === 'agentThreadCard');
    expect(card).toBeDefined();
    expect(JSON.stringify(card)).toContain('thread-legacy');
  });

  it.each<[string, string, { types?: string[]; text?: string[] }]>([
    ['block html', 'Before\n\n<div>keep me</div>\n\nAfter', { text: ['keep me'] }],
    ['inline html', 'a <span class="x">keep</span> b', { text: ['a keep b'] }],
    ['hard break', 'line one\n<br>\nline two', { text: ['line one', 'line two'] }],
    ['void html', 'Before\n\n<img src="a.png" alt="pic">\n\nAfter', { types: ['paragraph', 'paragraph', 'paragraph'] }],
    ['html comment', 'Before\n\n<!-- secret -->\n\nAfter', { types: ['paragraph', 'paragraph', 'paragraph'] }],
    ['escaped html table', 'Before\n\n&lt;table&gt;&lt;tbody&gt;&lt;tr&gt;&lt;td&gt;&lt;p&gt;&lt;/p&gt;&lt;p&gt;哈哈好&lt;/p&gt;&lt;/td&gt;&lt;/tr&gt;&lt;/tbody&gt;&lt;/table&gt;\n\nAfter', { types: ['paragraph', 'table', 'paragraph'], text: ['哈哈好'] }],
    ['html table', 'Before\n\n<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>\n\nAfter', { types: ['paragraph', 'table', 'paragraph'] }],
    ['styled html table', '<table data-flowix-table-style="hk-financial"><tr data-flowix-row-role="total"><td data-flowix-column-role="amount"><p>(9,700)</p><p>unchanged</p></td></tr></table>', { types: ['table'], text: ['(9,700)', 'unchanged'] }],
    ['html table borders', '<table><tr><th colspan="2" data-flowix-border-top="double" data-flowix-border-bottom="none"><p>Header</p></th></tr><tr><td data-flowix-border-bottom="single"><p>01</p></td><td data-flowix-border-top="invalid" data-flowix-border-bottom="double"><p>(9,700)</p></td></tr></table>', { types: ['table'], text: ['Header', '01', '(9,700)'] }],
  ])('parses raw HTML (%s) instead of rejecting the note', (_name, source, expected) => {
    const document = parseMarkdown(source);
    if (expected.types) expect(nodeTypes(document)).toEqual(expected.types);
    for (const fragment of expected.text ?? []) {
      expect(documentText(document)).toContain(fragment);
    }
  });

  it('still parses flowix reference markers', () => {
    const document = parseMarkdown([
      'Before',
      '',
      '<!-- flowix:table-reference {"version":1,"path":"a.md"} -->',
      '',
      '<!-- flowix:media-library-reference {"version":1,"path":"a.png"} -->',
      '',
      'After',
    ].join('\n'));
    expect(nodeTypes(document)).toContain('tableReference');
    expect(nodeTypes(document)).toContain('mediaLibraryReference');
  });

  // The guarded tokenizers bound each block's `start()` scan to a prefix of the
  // remaining document. These cases guard that every construct is still found.
  it.each([
    ['math block', 'Before\n\n$$\nx^2 + y^2\n$$\n\nAfter', ['paragraph', 'mathBlock', 'paragraph']],
    ['web card', 'Before\n\n::webcard {"url":"https://example.com","title":"Example"}\n\nAfter', ['paragraph', 'webCard', 'paragraph']],
    ['table metadata', '<!-- flowix:table {"version":1,"columns":[{"width":120}]} -->\n\n| a |\n| --- |\n| 1 |', ['table']],
    ['table presentation', '<!-- flowix:table {"version":1,"columns":[{"width":120}],"styleId":"three-line","rows":["body","total"],"cells":[["amount"],["amount"]]} -->\n\n| a |\n| --- |\n| (9,700) |', ['table']],
    ['table borders without a row header', '<!-- flowix:table {"version":1,"columns":[{"width":120}],"rowHeader":false,"borders":[[{"top":"none","bottom":"double"}],[{"top":"single"}]]} -->\n\n|  |\n| --- |\n| (9,700) |\n| 01 |', ['table']],
    ['table widths', '<!-- flowix:table-widths=120,80 -->\n\n| a | b |\n| --- | --- |\n| 1 | 2 |', ['table']],
    ['table reference', 'Before\n\n<!-- flowix:table-reference {"version":1,"path":"a.md"} -->\n\nAfter', ['paragraph', 'tableReference', 'paragraph']],
    ['media reference', 'Before\n\n<!-- flowix:media-library-reference {"version":1,"path":"a.png"} -->\n\nAfter', ['paragraph', 'mediaLibraryReference', 'paragraph']],
    ['task list', '- [ ] todo\n- [x] done', ['taskList']],
    ['bullet list', '- one\n- two\n\nplain', ['bulletList', 'paragraph']],
    ['ordered list', '1. one\n2. two', ['orderedList']],
  ])('parses %s', (_name, source, expectedTypes) => {
    expect(nodeTypes(parseMarkdown(source))).toEqual(expectedTypes);
  });

  it('finds media style comments ahead of an image', () => {
    const document = parseMarkdown(
      'Before\n\n<!-- flowix:media {"flowix":"media","version":1,"style":{"width":"60%"}} -->\n![x](asset://image-key)\n\nAfter',
    );
    expect(JSON.stringify(document)).toContain('"image"');
  });

  it('finds inline note references', () => {
    const document = parseMarkdown('See [[wiki note]] inline.');
    expect(JSON.stringify(document)).toContain('noteReference');
  });
});

describe('ordered list continuation text preservation', () => {
  it.each(['1) 第一项\n2) 第二项', '7) 第一项\n8) 第二项'])(
    'continues to parse parenthesized ordered list markers: %s', source => {
      const editor = createEditor(source);
      expect(editor.state.doc.firstChild?.type.name).toBe('orderedList');
      expect(editor.state.doc.firstChild?.attrs.start).toBe(Number.parseInt(source, 10));
      expect(editor.state.doc.textContent).toContain('第一项');
      expect(editor.state.doc.textContent).toContain('第二项');
      expect(createEditor(editor.getMarkdown()).getJSON()).toEqual(editor.getJSON());
    },
  );

  it.each([' ', '\t', '　', '  ', '   '].flatMap(indent =>
    ['\n', '\r\n'].map(newline => ({ indent, newline })),
  ))('preserves Chinese initials with $indent indentation and $newline endings', ({ indent, newline }) => {
    const lines = ['业务组件：凭证引擎', '能力中心：表单', '基础框架：门户'];
    const source = ['3. 三大稳态', ...lines.map(line => indent + line)].join(newline);
    const editor = createEditor(source);
    for (const line of lines) expect(editor.state.doc.textContent).toContain(line);
    const saved = editor.getMarkdown();
    const restored = createEditor(saved);
    expect(restored.getJSON()).toEqual(editor.getJSON());
    for (const line of lines) expect(saved).toContain(line);
  });

  it('keeps multi-digit numbering, mixed nested lists and fenced code indentation', () => {
    const source = [
      '10. 父级',
      '    1. 子级',
      '       业务组件',
      '       - 无序子级',
      '    2. 第二子级',
      '11. 代码',
      '',
      '    ```text',
      '        保留四空格',
      '    ```',
    ].join('\n');
    const editor = createEditor(source);
    const first = editor.state.doc.firstChild!;
    expect(first.attrs.start).toBe(10);
    expect(first.firstChild!.lastChild!.type.name).toBe('orderedList');
    expect(editor.state.doc.textContent).toContain('业务组件');
    expect(editor.state.doc.textContent).toContain('无序子级');
    let code = '';
    editor.state.doc.descendants(node => {
      if (node.type.name === 'codeBlock') code = node.textContent;
    });
    expect(code).toBe('    保留四空格');
    expect(createEditor(editor.getMarkdown()).getJSON()).toEqual(editor.getJSON());
  });
});
