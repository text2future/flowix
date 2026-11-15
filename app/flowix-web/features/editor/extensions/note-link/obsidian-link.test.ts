import { describe, expect, it } from 'vitest';

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import {
  createNoteReferenceExtension,
  parseWikiNoteLinkAtStart,
  splitObsidianTarget,
} from './view-note';
import { MarkdownLink } from '../markdown-link';

const notebooks = [
  { id: 'work', name: 'Work', path: '/work' },
  { id: 'vault', name: 'MyVault', path: '/vault' },
  { id: 'other', name: 'Other', path: '/other' },
];
const NoteReference = createNoteReferenceExtension('document', {
  getReferenceContext: () => ({ documentPath: '', notebooks }),
});

describe('Obsidian note links', () => {
  it('shows an inserted note with a notebook and path as valid immediately', () => {
    const editor = new Editor({
      extensions: [StarterKit.configure({ link: false }), Markdown, NoteReference, MarkdownLink],
      content: '<p></p>',
    });
    editor.commands.insertContent({
      type: 'noteReference',
      attrs: {
        notebookId: 'work', relativePath: 'Projects/Plan.md', notebookName: 'Work',
        title: 'Plan', originalPath: null, linkStyle: 'flowix',
        linkTarget: null, heading: null, stale: false,
      },
    });
    expect(editor.view.dom.querySelector('.note-reference__card')?.getAttribute('data-stale')).toBe('false');
    editor.destroy();
  });
  it('round trips a child note by notebook and relative path without a memo ID', () => {
    const link = 'flowix://open?b=Work&f=Projects%2FPlan.md';
    const editor = new Editor({
      extensions: [StarterKit.configure({ link: false }), Markdown, NoteReference, MarkdownLink],
      content: `[Plan](${link})`,
      contentType: 'markdown',
    });
    const node = editor.state.doc.firstChild?.firstChild;
    expect(node?.attrs).toMatchObject({ notebookName: 'Work', relativePath: 'Projects/Plan.md' });
    expect(editor.getMarkdown()).toContain('[Plan](/work/Projects/Plan.md)');
    editor.destroy();
  });
  it('uses the target filename as an internal link display name', () => {
    const editor = new Editor({
      extensions: [StarterKit.configure({ link: false }), Markdown, NoteReference, MarkdownLink],
      content: '[Custom label](flowix://open?b=Work&f=Projects%2FPlan.md)',
      contentType: 'markdown',
    });
    expect(editor.view.dom.querySelector('.note-reference__title')?.textContent).toBe('Plan');
    expect(editor.getMarkdown()).toContain('[Custom label](/work/Projects/Plan.md)');
    editor.destroy();
  });
  it('preserves an unresolved legacy ID-based path link', () => {
    const link = 'flowix://open?notebookId=unloaded-book&relativePath=Projects%2FPlan.md';
    const editor = new Editor({
      extensions: [StarterKit.configure({ link: false }), Markdown, NoteReference, MarkdownLink],
      content: `[Plan](${link})`,
      contentType: 'markdown',
    });
    expect(editor.getMarkdown()).toContain(link);
    editor.destroy();
  });
  it('keeps a Flowix notebook path link as a note reference', () => {
    const link = 'flowix://open?b=MyVault&f=Projects%2FPlan.md';
    const editor = new Editor({
      extensions: [StarterKit.configure({ link: false }), Markdown, NoteReference, MarkdownLink],
      content: `[Plan](${link})`,
      contentType: 'markdown',
    });
    const node = editor.state.doc.firstChild?.firstChild;
    expect(node?.type.name).toBe('noteReference');
    expect(node?.attrs.linkTarget).toBe(link);
    editor.destroy();
  });
  it('normalizes an existing book/file link when saved', () => {
    const editor = new Editor({
      extensions: [StarterKit.configure({ link: false }), Markdown, NoteReference, MarkdownLink],
      content: '[Old label](flowix://open?book=MyVault&file=Projects%2FPlan.md)',
      contentType: 'markdown',
    });
    expect(editor.getMarkdown()).toContain('[Old label](/vault/Projects/Plan.md)');
    editor.destroy();
  });
  it('does not parse legacy memo ID links as note references', () => {
    const link = 'flowix://memo/abc12345';
    const editor = new Editor({
      extensions: [StarterKit.configure({ link: false }), Markdown, NoteReference, MarkdownLink],
      content: `[Plan](${link})`,
      contentType: 'markdown',
    });
    const node = editor.state.doc.firstChild?.firstChild;
    expect(node?.type.name).not.toBe('noteReference');
    editor.destroy();
  });
  it('keeps ordinary relative Markdown links lightweight', () => {
    const editor = new Editor({
      extensions: [StarterKit.configure({ link: false }), Markdown, NoteReference, MarkdownLink],
      content: '[Install](docs/install.md)',
      contentType: 'markdown',
    });

    expect(editor.state.doc.textContent).toBe('Install');
    expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe('text');
    expect(editor.state.doc.firstChild?.firstChild?.marks[0]?.type.name).toBe('link');
    expect(editor.state.doc.firstChild?.firstChild?.marks[0]?.attrs.href).toBe('docs/install.md');
    editor.destroy();
  });

  it('parses wiki targets and aliases', () => {
    expect(parseWikiNoteLinkAtStart('[[笔记名称.md]] rest')).toMatchObject({
      raw: '[[笔记名称.md]]',
      target: '笔记名称.md',
      heading: null,
      title: '笔记名称',
    });
    expect(parseWikiNoteLinkAtStart('[[文件夹/笔记.md|显示名称]]')).toMatchObject({
      raw: '[[文件夹/笔记.md|显示名称]]',
      target: '文件夹/笔记.md',
      heading: null,
      title: '显示名称',
    });
  });

  it('accepts Obsidian headings and the double-hash compatibility form', () => {
    expect(splitObsidianTarget('笔记名称#二级标题')).toEqual({
      target: '笔记名称',
      heading: '二级标题',
    });
    expect(splitObsidianTarget('笔记名称## 二级标题')).toEqual({
      target: '笔记名称',
      heading: '二级标题',
    });
  });

  it('decodes percent-encoded legacy wiki names', () => {
    expect(splitObsidianTarget('笔记名称%20with%20spaces')).toEqual({
      target: '笔记名称 with spaces',
      heading: null,
    });
  });
});

describe('notebook identity in note links', () => {
  function editorInside(ownerNotebookId: string | null) {
    return new Editor({
      extensions: [
        StarterKit.configure({ link: false }),
        Markdown,
        createNoteReferenceExtension('document', {
          getOwnerNotebookId: () => ownerNotebookId,
          getReferenceContext: () => ({ documentPath: ownerNotebookId ? `/${ownerNotebookId}/sub/source.md` : '',
            notebookId: ownerNotebookId ?? undefined, notebooks }),
        }),
        MarkdownLink,
      ],
      content: '<p></p>',
    });
  }

  const reference = {
    notebookId: 'work', relativePath: 'Projects/Plan.md', notebookName: 'Work',
    title: 'Plan', originalPath: null, linkStyle: 'flowix' as const,
    linkTarget: null, heading: null, stale: false,
  };

  it('writes a same-notebook reference without any notebook key', () => {
    const editor = editorInside('work');
    editor.commands.insertContent({ type: 'noteReference', attrs: reference });
    // No name and no ID: renaming or moving the notebook cannot break it.
    expect(editor.getMarkdown()).toContain('[[../Projects/Plan.md]]');
    editor.destroy();
  });

  it('writes a cross-notebook reference as an absolute Markdown link', () => {
    const editor = editorInside('other');
    editor.commands.insertContent({ type: 'noteReference', attrs: reference });
    expect(editor.getMarkdown()).toContain('[Plan](/work/Projects/Plan.md)');
    editor.destroy();
  });

  it('keeps a bare f link unchanged when the notebook is unknown', () => {
    const link = 'flowix://open?f=Projects%2FPlan.md';
    const editor = new Editor({
      extensions: [StarterKit.configure({ link: false }), Markdown, NoteReference, MarkdownLink],
      content: `[Plan](${link})`,
      contentType: 'markdown',
    });
    expect(editor.state.doc.firstChild?.firstChild?.attrs.relativePath).toBe('Projects/Plan.md');
    expect(editor.getMarkdown()).toContain(link);
    editor.destroy();
  });

  it('resolves a bare f link against the owning notebook', () => {
    const link = 'flowix://open?f=Projects%2FPlan.md';
    const editor = editorInside('work');
    editor.commands.setContent(`[Plan](${link})`, { contentType: 'markdown' });
    expect(editor.getMarkdown()).toContain('[[../Projects/Plan.md]]');
    editor.destroy();
  });

  it('migrates a same-notebook deep link while preserving its heading', () => {
    const link = 'flowix://open?f=Projects%2FPlan.md#%E7%9B%AE%E6%A0%87';
    const editor = editorInside('work');
    editor.commands.setContent(`[Plan](${link})`, { contentType: 'markdown' });
    expect(editor.state.doc.firstChild?.firstChild?.attrs.heading).toBe('目标');
    expect(editor.getMarkdown()).toContain('[[../Projects/Plan.md#%E7%9B%AE%E6%A0%87]]');
    editor.destroy();
  });

  it('keeps a heading anchor when a cross-notebook link becomes same-notebook', () => {
    const editor = editorInside('work');
    editor.commands.setContent(
      '[Plan](flowix://open?notebookId=work&relativePath=Projects%2FPlan.md#%E7%9B%AE%E6%A0%87)',
      { contentType: 'markdown' },
    );
    const markdown = editor.getMarkdown();
    expect(markdown).toContain('[[../Projects/Plan.md#%E7%9B%AE%E6%A0%87]]');
    editor.destroy();
  });
});


it('reads legacy note attributes without confusing relativePath with path', () => {
  const editor = new Editor({
    extensions: [StarterKit.configure({ link: false }), Markdown, NoteReference],
    content: '<note notebook="work" relativePath="Projects/Plan.md">Work/Plan</note>', contentType: 'markdown',
  });
  try {
    expect(editor.state.doc.firstChild?.firstChild?.attrs).toMatchObject({
      notebookId: 'work', relativePath: 'Projects/Plan.md', originalPath: null,
    });
    expect(editor.getMarkdown()).toBe('[Plan](/work/Projects/Plan.md)');
  } finally { editor.destroy(); }
});
