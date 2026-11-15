import pathContract from '../../../../../../test-fixtures/note-reference-paths.json';
import { describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';

const navigation = vi.hoisted(() => ({
  openNoteByNotebookPath: vi.fn(async () => undefined),
  openNoteByPhysicalPath: vi.fn(async () => undefined),
}));
vi.mock('@platform/tauri/client', async importOriginal => {
  const actual = await importOriginal<typeof import('@platform/tauri/client')>();
  return { ...actual, files: { ...actual.files, resolveLocation: vi.fn(async (path: string) => ({
    path, isDirectory: false, notebookId: null, notebookPath: null,
  })) } };
});
vi.mock('@features/memo/public/note-navigation-api', () => navigation);
import { createNoteReferenceExtension } from './view-note';
import { noteReferenceWikiMarkdown, wikiReferencePath, normalizeNoteReferenceDocument, renderNoteReferenceMarkdown } from './note-reference-path';
import { attrsFromWikiNoteLink, parseWikiNoteLinkAtStart, type NoteReferenceAttrs } from './note-reference-markdown';
import { samePath } from '@/lib/path';
import { MarkdownLink } from '../markdown-link';
import { toNoteReferenceAttrs } from '../note-mention/note-mention-data';

function reference(path: string): NoteReferenceAttrs {
  return { notebookId: null, notebookName: '', title: 'Title', relativePath: null,
    originalPath: path, linkStyle: 'flowix', linkTarget: null, heading: null, stale: false };
}

const cases = [
  ['/book/sub/source.md', '/book/资料/中文 空格.md', '/book', '../资料/中文 空格.md'],
  ['/book/source.md', '/outside/中文.md', '/book', '/outside/中文.md'],
  ['/outside/source.md', '/book/target.md', '/book', '/book/target.md'],
  ['C:\\Book\\sub\\source.md', 'c:\\book\\资料\\中文 空格.md', 'C:/Book', '../资料/中文 空格.md'],
  ['C:/source.md', 'C:/目标.md', 'C:/', './目标.md'],
  ['C:/Book/source.md', 'D:\\资料\\目标.md', 'C:/Book', 'D:/资料/目标.md'],
  ['C:/Book/source.md', '\\\\server\\share\\目标.md', 'C:/Book', 'file://server/share/目标.md'],
  ['\\\\server\\share\\Book\\sub\\source.md', '\\\\server\\share\\Book\\目标.md', '//server/share/Book', '../目标.md'],
  ['//server/share/Book/source.md', '//other/share/目标.md', '//server/share/Book', 'file://other/share/目标.md'],
  ['/book/source.md', '/book/a#b?c%20[d]|e.md', '/book', './a%23b%3Fc%2520%5Bd%5D%7Ce.md'],
] as const;

describe('wiki note path persistence', () => {
  it.each(cases)('round trips %s → %s', (documentPath, path, root, destination) => {
    const context = { documentPath, notebooks: [{ id: 'book', name: 'Book', path: root }] };
    const markdown = noteReferenceWikiMarkdown(reference(path), context);
    if (!destination.startsWith('.')) {
      expect(markdown).toBeNull();
      const normalized = normalizeNoteReferenceDocument({ type: 'noteReference', attrs: reference(path) }, context);
      expect(normalized.type).toBe('text');
      expect(normalized.marks?.[0].type).toBe('link');
      expect(renderNoteReferenceMarkdown(reference(path), context)).toMatch(/^\[Title\]\(/);
      return;
    }
    expect(markdown).toBe(`[[${destination}]]`);
    const parsed = parseWikiNoteLinkAtStart(markdown!)!;
    const attrs = attrsFromWikiNoteLink(parsed);
    expect(samePath(wikiReferencePath(attrs, documentPath)!, path)).toBe(true);
    expect(noteReferenceWikiMarkdown(attrs, context)).toBe(markdown);
  });

  it.each(['[[C:\\Notes\\中文.md]]', '[[C:/Notes/中文.md]]', '[[file:///C:/Notes/中文.md]]'])(
    'reads Windows drive syntax %s', markdown => {
      expect(wikiReferencePath(attrsFromWikiNoteLink(parseWikiNoteLinkAtStart(markdown)!), '/book/n.md'))
        .toBe('C:/Notes/中文.md');
    },
  );
  it('reads a copied Windows UNC path', () => {
    const attrs = attrsFromWikiNoteLink(parseWikiNoteLinkAtStart('[[\\\\server\\share\\中文.md]]')!);
    expect(wikiReferencePath(attrs)).toBe('//server/share/中文.md');
  });

  it('persists a mention and reopens the same Windows document after parsing', async () => {
    const attrs = toNoteReferenceAttrs({ notebookId: 'book', notebookName: 'Book', notebookPath: 'C:\\Notes',
      relativePath: '资料/目标.md', filename: '目标.md', title: '目标', updatedAt: 0, originalPath: null });
    const extensions = () => [StarterKit.configure({ link: false }), Markdown,
      createNoteReferenceExtension('document', { getReferenceContext: () => ({ documentPath: 'C:/Notes/sub/source.md', notebookId: 'book',
        notebooks: [{ id: 'book', name: 'Book', path: 'C:/Notes' }] }) }), MarkdownLink];
    const editor = new Editor({ extensions: extensions(), content: '<p></p>' });
    editor.commands.insertContent({ type: 'noteReference', attrs });
    const saved = editor.markdown!.serialize(normalizeNoteReferenceDocument(editor.getJSON(), {
      documentPath: 'C:/Notes/sub/source.md', notebookId: 'book',
      notebooks: [{ id: 'book', name: 'Book', path: 'C:/Notes' }],
    }));
    expect(saved).toBe('[[../资料/目标.md]]');
    const reopened = new Editor({ extensions: extensions(), content: saved, contentType: 'markdown' });
    expect(reopened.state.doc.firstChild?.firstChild?.type.name).toBe('noteReference');
    reopened.view.dom.querySelector('.note-reference__card')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(navigation.openNoteByPhysicalPath).toHaveBeenLastCalledWith('C:/Notes/资料/目标.md', null));
    reopened.commands.setContent('[目标](../资料/目标.md)', { contentType: 'markdown' });
    expect(reopened.state.doc.firstChild?.firstChild?.type.name).toBe('text');
    expect(reopened.state.doc.firstChild?.firstChild?.marks[0]?.type.name).toBe('link');
    reopened.destroy();
    editor.destroy();
  });
});


describe('shared frontend/backend path contract', () => {
  it.each(pathContract)('$reference under $root', fixture => {
    const context = { documentPath: `${fixture.root}/${fixture.source}`, notebookId: 'book',
      notebooks: [{ id: 'book', name: 'Book', path: fixture.root }] };
    const attrs = attrsFromWikiNoteLink(parseWikiNoteLinkAtStart(fixture.reference)!);
    expect(samePath(wikiReferencePath(attrs, context.documentPath)!, fixture.absolutePath)).toBe(true);
    expect(noteReferenceWikiMarkdown(attrs, context)).toBe(fixture.notebookRelativePath === null ? null : fixture.persisted);
  });
});

it.each(['[[target]]', '[[./target]]', '[[folder/target]]'])('uses the same implicit .md extension for %s', source => {
  const attrs = attrsFromWikiNoteLink(parseWikiNoteLinkAtStart(source)!);
  expect(wikiReferencePath(attrs, '/book/source.md')).toBe(source.includes('folder/') ? '/book/folder/target.md' : '/book/target.md');
});
