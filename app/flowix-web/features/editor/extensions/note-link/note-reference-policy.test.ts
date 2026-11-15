import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';

const location = vi.hoisted(() => vi.fn(async (path: string) => ({ path, isDirectory: path.endsWith('/folder.md') || path.endsWith('/资料') ? true
  : path.endsWith('/target.md') || path.endsWith('/LICENSE') ? false : null })));
vi.mock('@platform/tauri/client', () => ({ files: { resolveLocation: location }, notes: {} }));
vi.mock('@features/memo/public/note-navigation-api', () => ({ openNoteByPhysicalPath: vi.fn() }));
import { createNoteReferenceExtension } from './view-note';
import { noteReferenceMarkdownNode } from './note-reference-path';
import { attrsFromWikiNoteLink, parseWikiNoteLinkAtStart } from './note-reference-markdown';
import { MarkdownLink } from '../markdown-link';

const editors: Editor[] = [];
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()); vi.clearAllMocks(); });
function editorFor(content: string) {
  const editor = new Editor({ extensions: [StarterKit.configure({ link: false }), Markdown, MarkdownLink,
    createNoteReferenceExtension('document', { getReferenceContext: () => ({
      documentPath: '/book/sub/source.md', notebookId: 'book',
      notebooks: [{ id: 'book', name: 'Book', path: '/book' }],
    }) })], content, contentType: 'markdown' });
  editors.push(editor);
  return editor;
}

describe('Wiki and Markdown destination policy', () => {
  it.each([
    ['[[/book/target.md]]', '../target.md', 'target'],
    ['[[/other/note.md|外部]]', '/other/note.md', '外部'],
    ['[[../../other/note.md]]', '/other/note.md', 'note'],
    ['[[https://example.com|网页]]', 'https://example.com', '网页'],
    ['[[./资料/]]', './%E8%B5%84%E6%96%99/', './资料/'],
    ['[[./data.custom]]', './data.custom', 'data.custom'],
  ])('converts %s into an ordinary link', async (source, href, title) => {
    const editor = editorFor(source);
    await vi.waitFor(() => expect(editor.view.dom.querySelector('a')).not.toBeNull());
    const node = editor.getJSON().content![0].content![0];
    expect(node.type).toBe('text');
    expect(node.marks?.[0]).toMatchObject({ type: 'link', attrs: { href } });
    if (!source.includes('资料')) expect(node).toMatchObject({ text: title });
    expect(editor.getMarkdown()).not.toContain('[[');
  });

  it('keeps notebook-local relative notes as Wiki references', async () => {
    const editor = editorFor('[[../target.md#Heading]]');
    await vi.waitFor(() => expect(location).toHaveBeenCalled());
    expect(editor.getJSON().content![0].content![0].type).toBe('noteReference');
    expect(editor.getMarkdown()).toBe('[[../target.md#Heading]]');
  });

  it.each(['[[./folder.md]]', '[[资料]]', '[[LICENSE]]'])('converts an actual directory even without a trailing slash: %s', async source => {
    const editor = editorFor(source);
    await vi.waitFor(() => expect(editor.view.dom.querySelector('a')).not.toBeNull());
    expect(editor.getMarkdown()).not.toContain('[[');
  });
});

it('uses ordinary links for a source document outside every notebook', () => {
  const attrs = attrsFromWikiNoteLink(parseWikiNoteLinkAtStart('[[./target.md]]')!);
  expect(noteReferenceMarkdownNode(attrs, { documentPath: '/outside/source.md', notebooks: [] }))
    .toMatchObject({ type: 'text', marks: [{ type: 'link', attrs: { href: '/outside/target.md' } }] });
});

it('converts a bare Wiki folder into an explicit relative Markdown path', async () => {
  const editor = editorFor('[[资料]]');
  await vi.waitFor(() => expect(editor.view.dom.querySelector('a')).not.toBeNull());
  expect(editor.view.dom.querySelector('a')?.getAttribute('href')).toBe('./%E8%B5%84%E6%96%99/');
});
