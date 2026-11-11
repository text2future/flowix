import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, expect, it, vi } from 'vitest';
import { createMarkdownEditorExtensions, serializeEditorMarkdown } from '../markdown-editor-extensions';
import type { EditorImageContext } from '../editor-image-source';

const editors: Editor[] = [];
function createEditor(content: string, getImageContext?: () => EditorImageContext | undefined) {
  const editor = new Editor({
    extensions: createMarkdownEditorExtensions({
      getOwnerPath: () => undefined, getAttachmentNotebookId: () => undefined,
      workspaceHost: 'column-1', getPlaceholder: () => '', getImageContext,
    }), content, contentType: 'markdown',
  });
  editors.push(editor);
  return editor;
}
function htmlSources(node: JSONContent): string[] {
  return node.type?.startsWith('preservedHtml') ? [node.attrs!.html] : (node.content ?? []).flatMap(htmlSources);
}
afterEach(() => editors.splice(0).forEach(editor => editor.destroy()));

it.each([
  '<img src="./docs/images/home-write.png" width="100%" alt="Flowix" />',
  '<p align="center">\n  <img src="./docs/images/app-icon.png" width="120" alt="Flowix" />\n</p>',
  '<p>before <img src="a.png" width="60%" /> after</p>',
  '| Preview |\n| --- |\n| <img src="a.png" width="60%" alt="pic" /><br/>*Caption* |',
  '<picture><source media="(prefers-color-scheme: dark)" srcset="dark.png"><img src="light.png" /></picture>',
  'Before\n\n<!-- keep me -->\n\nAfter',
  'before <img src="a.png" alt="a > b" /> after',
  'before <!-- keep inline --> after',
  '<p>before <!-- keep nested --> after</p>',
  '# Before <img src="a.png" width="120" /> after',
  '> before <img src="a.png" width="120" /> after',
  '- before <img src="a.png" width="120" /> after',
  '[<img src="a.png" width="120" />](https://example.com)',
  'before <picture><img src="a.png" alt="</picture>" /></picture> after',
  '  <img src="indented.png" width="120" />',
  '<table><tr><td><p>One</p><p><img src="a.png" width="120" /></p></td></tr></table>',
])('keeps HTML media/comments verbatim and document structure valid: %s', source => {
  const editor = createEditor(source);
  expect(() => editor.state.doc.check()).not.toThrow();
  const html = htmlSources(editor.getJSON());
  expect(html.length).toBeGreaterThan(0);
  const saved = serializeEditorMarkdown(editor);
  // The host may edit unrelated text; the HTML source must still survive.
  editor.commands.insertContentAt(editor.state.doc.content.size, '<p>New text</p>');
  const edited = serializeEditorMarkdown(editor);
  for (const value of html) {
    // Complex tables may use HTML wrappers with escaped source attributes.
    if (!saved.includes('<table')) expect(saved).toContain(value);
  }
  for (const markdown of [saved, edited]) {
    const reopened = createEditor(markdown);
    expect(() => reopened.state.doc.check()).not.toThrow();
    expect(htmlSources(reopened.getJSON())).toEqual(html);
  }
  if (source.startsWith('|')) expect(createEditor(saved).state.doc.textContent).toContain('Caption');
  if (source.startsWith('before ')) expect(editor.state.doc.firstChild!.type.name).toBe('paragraph');
});

it('does not tokenize HTML examples in code or swallow adjacent content', () => {
  const editor = createEditor('`<img src="inline.png">`\n\n```html\n<img src="block.png">\n```\n\nAfter');
  expect(htmlSources(editor.getJSON())).toEqual([]);
  expect(editor.state.doc.textContent).toContain('After');
});

it('keeps Flowix metadata routed to the existing media parser', () => {
  const editor = createEditor('<!-- flowix:media {"flowix":"media","version":1,"style":{"widthPercent":60}} -->\n![photo](a.png)');
  expect(htmlSources(editor.getJSON())).toEqual([]);
  expect(editor.state.doc.firstChild!.type.name).toBe('image');
  expect(editor.state.doc.firstChild!.attrs.widthPercent).toBe(60);
});

it('resolves relative previews without persisting resolved URLs or executing authored HTML', async () => {
  const readImage = vi.fn().mockResolvedValue('data:image/png;base64,AA==');
  const context = { documentPath: '/book/README.md', scopePath: '/book', readImage };
  const source = '<p align="center"><img src="./docs/a.png" width="120" onload="alert(1)" /><script>alert(2)</script></p>';
  const editor = createEditor(source, () => context);
  await Promise.resolve();
  expect(readImage).toHaveBeenCalledWith('/book/docs/a.png', '/book');
  const image = editor.view.dom.querySelector('img')!;
  expect(image.getAttribute('src')).toBe('data:image/png;base64,AA==');
  expect(image.style.width).toBe('120px');
  expect(image.hasAttribute('onload')).toBe(false);
  expect(editor.view.dom.querySelector('script')).toBeNull();
  expect(serializeEditorMarkdown(editor)).toBe(source);
});
