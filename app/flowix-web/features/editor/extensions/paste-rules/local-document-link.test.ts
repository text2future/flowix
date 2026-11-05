import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import ManagedPasteRules, { pasteClipboardSnapshot } from './index';
import { AttachmentLink } from '../attachment-link';

function setup() {
  const editor = new Editor({ extensions: [StarterKit, AttachmentLink, Markdown, ManagedPasteRules.configure({
    ownerPath: '/book/sub/current.md',
    getLinkContext: (documentPath) => documentPath ? { documentPath, notebooks: [{ id: 'a', name: 'Book', path: '/book' }] } : undefined,
  })], content: '<p></p>' });
  const paste = (text: string, html = '') => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: {
      types: ['text/plain', ...(html ? ['text/html'] : [])], files: [],
      getData: (type: string) => type === 'text/plain' ? text : type === 'text/html' ? html : '',
    } });
    editor.view.dom.dispatchEvent(event);
  };
  return { editor, paste };
}
describe('local address native paste', () => {
  it.each(['', '<a href="flowix://open?b=Book&f=report.pdf">flowix://open?b=Book&amp;f=report.pdf</a>'])('inserts a relative link with clipboard HTML %s', html => {
    const { editor, paste } = setup();
    try {
      paste('flowix://open?b=Book&f=report.pdf', html);
      expect(editor.getJSON().content?.[0].content?.[0]).toMatchObject({ type: 'text', text: 'report.pdf', marks: [{ type: 'link', attrs: { href: '../report.pdf' } }] });
      expect(editor.getMarkdown()).toContain('[report.pdf](../report.pdf)');
      editor.commands.undo();
      expect(editor.getText()).toBe('');
    } finally { editor.destroy(); }
  });
  it.each(['/book/picture.PNG', 'file:///book/picture.PNG', 'flowix://open?b=Book&f=picture.PNG'])('embeds a local image address %s', address => {
    const { editor, paste } = setup();
    try {
      paste(address);
      expect(editor.getJSON().content?.find(node => node.type === 'image')).toMatchObject({
        type: 'image', attrs: { src: '../picture.PNG', alt: 'picture.PNG' },
      });
      expect(editor.getMarkdown()).toContain('![picture.PNG](../picture.PNG)');
      editor.commands.undo();
      expect(editor.getJSON().content?.some(node => node.type === 'image')).toBe(false);
    } finally { editor.destroy(); }
  });
  it.each(['chart]final.png', 'chart[final].png', 'chart(1).png', '图 #1%.PNG'])('round trips the image filename %s', name => {
    const { editor, paste } = setup();
    try {
      paste(`/book/${name}`);
      const saved = editor.getMarkdown();
      editor.commands.setContent(saved, { contentType: 'markdown' });
      expect(editor.getJSON().content?.find(node => node.type === 'image')?.attrs?.alt).toBe(name);
      expect(editor.getMarkdown()).toBe(saved);
    } finally { editor.destroy(); }
  });
  it('uses the same typed document context for programmatic pastes', () => {
    const { editor } = setup();
    try {
      expect(pasteClipboardSnapshot(editor, { types: ['text/plain'], markdown: '', text: '/book/a.png', html: '', uriList: [], files: [], sourceMime: 'text/plain' })).toBe(true);
      expect(editor.getJSON().content?.find(node => node.type === 'image')?.attrs?.src).toBe('../a.png');
    } finally { editor.destroy(); }
  });
  it('keeps foreign addresses and code blocks literal', () => {
    const { editor, paste } = setup();
    try {
      paste('flowix://open?b=Other&f=a.md');
      expect(editor.getText()).toBe('flowix://open?b=Other&f=a.md');
      editor.commands.setContent('<pre><code></code></pre>');
      editor.commands.setTextSelection(1);
      paste('flowix://open?b=Book&f=a.md');
      expect(editor.state.doc.firstChild?.textContent).toBe('flowix://open?b=Book&f=a.md');
      expect(editor.getJSON().content?.[0].type).toBe('codeBlock');
    } finally { editor.destroy(); }
  });
});
