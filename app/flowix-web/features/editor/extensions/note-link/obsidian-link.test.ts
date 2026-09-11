import { describe, expect, it } from 'vitest';
import {
  isRelativeNoteDestination,
  parseWikiNoteLinkAtStart,
  splitObsidianTarget,
} from './view-note';

describe('Obsidian note links', () => {
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
