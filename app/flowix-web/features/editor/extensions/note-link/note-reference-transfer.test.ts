import { afterEach, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { MarkdownLink } from '../markdown-link';
import ManagedPasteRules from '../paste-rules';

const navigation = vi.hoisted(() => ({ openNoteByPhysicalPath: vi.fn(async () => undefined) }));
vi.mock('@platform/tauri/client', async importOriginal => {
  const actual = await importOriginal<typeof import('@platform/tauri/client')>();
  return { ...actual, files: { ...actual.files, resolveLocation: vi.fn(async (path: string) => ({
    path, isDirectory: false, notebookId: null, notebookPath: null,
  })) } };
});
vi.mock('@features/memo/public/note-navigation-api', () => navigation);
import { createNoteReferenceExtension } from './view-note';
import { normalizeNoteReferenceDocument, type NoteReferenceContext } from './note-reference-path';
import * as mentionData from '../note-mention/note-mention-data';

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function createEditor(context: NoteReferenceContext, content = '') {
  const editor = new Editor({
    extensions: [StarterKit.configure({ link: false }), Markdown, MarkdownLink, ManagedPasteRules,
      createNoteReferenceExtension('document', { getReferenceContext: () => context })],
    content: content || '<p></p>', ...(content ? { contentType: 'markdown' as const } : {}),
  });
  editors.push(editor);
  return editor;
}

it.each([
  ['/book/a/source.md', '[[target]]', '/book/b/dest.md', '/book', '/book', '[[../a/target.md]]', '/book/a/target.md', null],
  ['/book/sub/source.md', '[[../target.md#Heading]]', '/book/other/dest.md', '/book', '/book', '[[../target.md#Heading]]', '/book/target.md', 'Heading'],
  ['/book/sub/source.md', '[[../target.md]]', '/other/dest.md', '/book', '/other', '[target](/book/target.md)', '/book/target.md', null],
  ['C:/Book/sub/source.md', '[[../资料/a%23b%25.md#Heading]]', 'D:/Other/dest.md', 'C:/Book', 'D:/Other', '[a#b%](C:/Book/%E8%B5%84%E6%96%99/a%23b%25.md#Heading)', 'C:/Book/资料/a#b%.md', 'Heading'],
  ['//server/share/Book/sub/source.md', '[[../目标.md]]', '/outside/dest.md', '//server/share/Book', '/other', '[目标](file://server/share/Book/%E7%9B%AE%E6%A0%87.md)', '//server/share/Book/目标.md', null],
])('keeps the target when transferring %s (%s)', async (sourcePath, markdown, destinationPath, sourceRoot, destinationRoot, saved, physicalPath, heading) => {
  const notebooks = [{ id: 'source', name: 'Source', path: sourceRoot }, { id: 'destination', name: 'Destination', path: destinationRoot }];
  // A same-root transfer has one owner, just as the actual notebook registry does.
  if (sourceRoot === destinationRoot) notebooks.pop();
  const sourceContext = { documentPath: sourcePath, notebookId: 'source', notebooks };
  const destinationContext = { documentPath: destinationPath, notebooks };
  const source = createEditor(sourceContext, markdown);
  const destination = createEditor(destinationContext);
  source.commands.setNodeSelection(1);
  const clipboard = source.view.serializeForClipboard(source.state.selection.content());
  expect(destination.view.pasteHTML(clipboard.dom.innerHTML, new Event('paste') as ClipboardEvent)).toBe(true);
  expect(destination.markdown!.serialize(normalizeNoteReferenceDocument(destination.getJSON(), destinationContext))).toBe(saved);
  if (!saved.startsWith('[[')) {
    await vi.waitFor(() => expect(destination.view.dom.querySelector('a')).not.toBeNull());
    const href = destination.view.dom.querySelector('a')!.getAttribute('href')!;
    expect(decodeURIComponent(href)).toContain(physicalPath.startsWith('//') ? `file:${physicalPath}` : physicalPath);
    return;
  }
  destination.view.dom.querySelector<HTMLElement>('.note-reference__card')!.click();
  await vi.waitFor(() => expect(navigation.openNoteByPhysicalPath).toHaveBeenCalledWith(physicalPath, heading));
});

it('decodes a historical wiki name before querying the note picker', async () => {
  const query = vi.spyOn(mentionData, 'listNoteReferenceCandidates').mockResolvedValue([{
    relativePath: 'My Note.md', filename: 'My Note.md', title: 'My Note', updatedAt: 0,
    notebookId: 'book', notebookName: 'Book', notebookPath: '/book', originalPath: null,
  }]);
  const editor = createEditor({ documentPath: '/book/source.md', notebookId: 'book', notebooks: [{ id: 'book', name: 'Book', path: '/book' }] }, '[[My%20Note]]');
  editor.view.dom.querySelector<HTMLElement>('.note-reference__card')!.click();
  await vi.waitFor(() => expect(navigation.openNoteByPhysicalPath).toHaveBeenCalledWith('/book/My Note.md', null));
  expect(query).toHaveBeenCalledWith('My Note', 'book');
});

it('keeps an ambiguous historical name unresolved instead of opening the first match', async () => {
  vi.spyOn(mentionData, 'listNoteReferenceCandidates').mockResolvedValue(['one', 'two'].map(folder => ({
    relativePath: `${folder}/Same.md`, filename: 'Same.md', title: 'Same', updatedAt: 0,
    notebookId: 'book', notebookName: 'Book', notebookPath: '/book', originalPath: null,
  })));
  const editor = createEditor({ documentPath: '/book/source.md', notebookId: 'book', notebooks: [{ id: 'book', name: 'Book', path: '/book' }] }, '[[Same]]');
  editor.view.dom.querySelector<HTMLElement>('.note-reference__card')!.click();
  await vi.waitFor(() => expect(editor.view.dom.querySelector('.note-reference__card')?.getAttribute('data-stale')).toBe('true'));
  expect(navigation.openNoteByPhysicalPath).not.toHaveBeenCalled();
});
