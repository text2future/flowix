import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import {
  createNoteReferenceExtension,
  isRelativeNoteDestination,
  NoteReference,
  parseWikiNoteLinkAtStart,
  splitObsidianTarget,
} from './view-note';
import { MarkdownLink } from '../markdown-link';

describe('Obsidian note links', () => {
  it('shows an inserted note with a notebook and path as valid immediately', () => {
    const editor = new Editor({
      extensions: [StarterKit, Markdown, NoteReference, MarkdownLink],
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
      extensions: [StarterKit, Markdown, NoteReference, MarkdownLink],
      content: `[Plan](${link})`,
      contentType: 'markdown',
    });
    const node = editor.state.doc.firstChild?.firstChild;
    expect(node?.attrs).toMatchObject({ notebookName: 'Work', relativePath: 'Projects/Plan.md' });
    expect(editor.getMarkdown()).toContain(link);
    editor.destroy();
  });
  it('uses the target filename as an internal link display name', () => {
    const editor = new Editor({
      extensions: [StarterKit, Markdown, NoteReference, MarkdownLink],
      content: '[Custom label](flowix://open?b=Work&f=Projects%2FPlan.md)',
      contentType: 'markdown',
    });
    expect(editor.view.dom.querySelector('.note-reference__title')?.textContent).toBe('Plan');
    expect(editor.getMarkdown()).toContain('[Plan](flowix://open?b=Work&f=Projects%2FPlan.md)');
    editor.destroy();
  });
  it('rewrites an ID-based path link to the canonical id + f form', () => {
    const link = 'flowix://open?notebookId=unloaded-book&relativePath=Projects%2FPlan.md';
    const editor = new Editor({
      extensions: [StarterKit, Markdown, NoteReference, MarkdownLink],
      content: `[Plan](${link})`,
      contentType: 'markdown',
    });
    expect(editor.getMarkdown()).toContain('flowix://open?notebookId=unloaded-book&f=Projects%2FPlan.md');
    editor.destroy();
  });
  it('keeps a Flowix notebook path link as a note reference', () => {
    const link = 'flowix://open?b=MyVault&f=Projects%2FPlan.md';
    const editor = new Editor({
      extensions: [StarterKit, Markdown, NoteReference, MarkdownLink],
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
      extensions: [StarterKit, Markdown, NoteReference, MarkdownLink],
      content: '[Old label](flowix://open?book=MyVault&file=Projects%2FPlan.md)',
      contentType: 'markdown',
    });
    expect(editor.getMarkdown()).toContain('[Plan](flowix://open?b=MyVault&f=Projects%2FPlan.md)');
    editor.destroy();
  });
  it('does not parse legacy memo ID links as note references', () => {
    const link = 'flowix://memo/abc12345';
    const editor = new Editor({
      extensions: [StarterKit, Markdown, NoteReference, MarkdownLink],
      content: `[Plan](${link})`,
      contentType: 'markdown',
    });
    const node = editor.state.doc.firstChild?.firstChild;
    expect(node?.type.name).not.toBe('noteReference');
    editor.destroy();
  });
  it('keeps ordinary relative Markdown links lightweight', () => {
    const editor = new Editor({
      extensions: [StarterKit, Markdown, NoteReference, MarkdownLink],
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
    expect(parseWikiNoteLinkAtStart('[[笔记名称.md]] rest')).toEqual({
      raw: '[[笔记名称.md]]',
      target: '笔记名称.md',
      heading: null,
      title: '笔记名称',
    });
    expect(parseWikiNoteLinkAtStart('[[文件夹/笔记.md|显示名称]]')).toEqual({
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

  it('decodes relative Markdown note destinations without claiming web links', () => {
    expect(splitObsidianTarget('笔记名称%20with%20spaces')).toEqual({
      target: '笔记名称 with spaces',
      heading: null,
    });
    expect(isRelativeNoteDestination('笔记名称.md')).toBe(true);
    expect(isRelativeNoteDestination('笔记名称%20with%20spaces')).toBe(true);
    expect(isRelativeNoteDestination('https://example.com/note.md')).toBe(false);
    expect(isRelativeNoteDestination('#二级标题')).toBe(false);
  });
});

describe('notebook identity in note links', () => {
  function editorInside(ownerNotebookId: string | null) {
    return new Editor({
      extensions: [
        StarterKit,
        Markdown,
        createNoteReferenceExtension('document', { getOwnerNotebookId: () => ownerNotebookId }),
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
    expect(editor.getMarkdown()).toContain('[Plan](flowix://open?f=Projects%2FPlan.md)');
    editor.destroy();
  });

  it('writes a cross-notebook reference by ID', () => {
    const editor = editorInside('other');
    editor.commands.insertContent({ type: 'noteReference', attrs: reference });
    expect(editor.getMarkdown()).toContain('[Plan](flowix://open?notebookId=work&f=Projects%2FPlan.md)');
    editor.destroy();
  });

  it('keeps a bare f link unchanged when the notebook is unknown', () => {
    const link = 'flowix://open?f=Projects%2FPlan.md';
    const editor = new Editor({
      extensions: [StarterKit, Markdown, NoteReference, MarkdownLink],
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
    expect(editor.getMarkdown()).toContain('[Plan](flowix://open?f=Projects%2FPlan.md)');
    editor.destroy();
  });

  it('keeps an authored same-notebook link and its heading verbatim', () => {
    const link = 'flowix://open?f=Projects%2FPlan.md#%E7%9B%AE%E6%A0%87';
    const editor = editorInside('work');
    editor.commands.setContent(`[Plan](${link})`, { contentType: 'markdown' });
    expect(editor.state.doc.firstChild?.firstChild?.attrs.heading).toBe('目标');
    expect(editor.getMarkdown()).toContain(link);
    editor.destroy();
  });

  it('keeps a heading anchor when a cross-notebook link becomes same-notebook', () => {
    const editor = editorInside('work');
    editor.commands.setContent(
      '[Plan](flowix://open?notebookId=work&relativePath=Projects%2FPlan.md#%E7%9B%AE%E6%A0%87)',
      { contentType: 'markdown' },
    );
    const markdown = editor.getMarkdown();
    expect(markdown).toContain('f=Projects%2FPlan.md');
    expect(markdown).toContain('heading=%E7%9B%AE%E6%A0%87');
    editor.destroy();
  });
});
