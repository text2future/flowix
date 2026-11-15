import { describe, expect, it } from 'vitest';
import { decodeEditorHref, isRelativePathHref, resolveEditorLocalHref } from './editor-link-resolution';

// 案例文档：课程与实验/水循环D组材料复试/任务记录.md
const DOCUMENT_PATH = '/Notes/开发任务管理/个人流程选题/科学课程/课程与实验/水循环D组材料复试/任务记录.md';

describe('resolveEditorLocalHref', () => {
  it('resolves a same-directory strict markdown link', () => {
    expect(resolveEditorLocalHref('水循环D组材料复试结果.md', DOCUMENT_PATH))
      .toEqual({
        path: '/Notes/开发任务管理/个人流程选题/科学课程/课程与实验/水循环D组材料复试/水循环D组材料复试结果.md',
        anchor: null,
      });
  });

  it('resolves a single-parent relative link', () => {
    expect(resolveEditorLocalHref('../资料/水循环D组材料复试依据.md', DOCUMENT_PATH))
      .toEqual({
        path: '/Notes/开发任务管理/个人流程选题/科学课程/课程与实验/资料/水循环D组材料复试依据.md',
        anchor: null,
      });
  });

  it('resolves a two-parent relative link', () => {
    expect(resolveEditorLocalHref('../../公共/科学课程与实验方案.md', DOCUMENT_PATH))
      .toEqual({
        path: '/Notes/开发任务管理/个人流程选题/科学课程/公共/科学课程与实验方案.md',
        anchor: null,
      });
  });

  it('decodes percent-encoded hrefs produced by the markdown parser', () => {
    expect(resolveEditorLocalHref('../../%E5%85%AC%E5%85%B1/%E6%96%B9%E6%A1%88.md', DOCUMENT_PATH))
      .toEqual({
        path: '/Notes/开发任务管理/个人流程选题/科学课程/公共/方案.md',
        anchor: null,
      });
  });

  it('resolves an explicit relative reference without a file extension', () => {
    expect(resolveEditorLocalHref('./子目录', DOCUMENT_PATH))
      .toEqual({
        path: '/Notes/开发任务管理/个人流程选题/科学课程/课程与实验/水循环D组材料复试/子目录',
        anchor: null,
      });
  });

  it('keeps a trailing heading anchor as a decoded fragment', () => {
    expect(resolveEditorLocalHref('./任务记录.md#%E5%AE%9E%E9%AA%8C%E6%AD%A5%E9%AA%A4', DOCUMENT_PATH))
      .toEqual({
        path: '/Notes/开发任务管理/个人流程选题/科学课程/课程与实验/水循环D组材料复试/任务记录.md',
        anchor: '实验步骤',
      });
    expect(resolveEditorLocalHref('./任务记录.md#实验步骤', DOCUMENT_PATH))
      .toEqual({
        path: '/Notes/开发任务管理/个人流程选题/科学课程/课程与实验/水循环D组材料复试/任务记录.md',
        anchor: '实验步骤',
      });
  });

  it('treats a literal # as a fragment delimiter (CommonMark semantics)', () => {
    expect(resolveEditorLocalHref('a#b.md', DOCUMENT_PATH)).toMatchObject({
      notebookNoteName: 'a', anchor: 'b.md',
    });
  });

  it('keeps a percent-encoded # inside a filename intact', () => {
    expect(resolveEditorLocalHref('%E8%AE%A1%E5%88%92%E8%A1%A8%232.md', DOCUMENT_PATH))
      .toEqual({
        path: '/Notes/开发任务管理/个人流程选题/科学课程/课程与实验/水循环D组材料复试/计划表#2.md',
        anchor: null,
      });
  });

  it('passes absolute posix and windows drive paths through', () => {
    expect(resolveEditorLocalHref('/Users/rop/Notes/计划表.csv', DOCUMENT_PATH))
      .toEqual({ path: '/Users/rop/Notes/计划表.csv', anchor: null });
    expect(resolveEditorLocalHref('D:\\Notes\\数据\\实验观察.csv', DOCUMENT_PATH))
      .toEqual({ path: 'D:/Notes/数据/实验观察.csv', anchor: null });
  });

  it('keeps web and protocol semantics for non-local targets', () => {
    expect(resolveEditorLocalHref('https://example.com/a.md', DOCUMENT_PATH)).toBeNull();
    expect(resolveEditorLocalHref('flowix://memo/abc', DOCUMENT_PATH)).toBeNull();
    expect(resolveEditorLocalHref('asset://image/1', DOCUMENT_PATH)).toBeNull();
    expect(resolveEditorLocalHref('mailto:a@b.com', DOCUMENT_PATH)).toBeNull();
    expect(resolveEditorLocalHref('#标题', DOCUMENT_PATH)).toBeNull();
    expect(resolveEditorLocalHref('//example.com/a.md', DOCUMENT_PATH)).toBeNull();
  });

  it('treats scheme-less Markdown destinations as relative paths', () => {
    expect(resolveEditorLocalHref('example.com', DOCUMENT_PATH)).not.toBeNull();
    expect(resolveEditorLocalHref('example.com/docs', DOCUMENT_PATH)).not.toBeNull();
  });

  it('requires a document path for relative targets', () => {
    expect(resolveEditorLocalHref('../计划表.csv', null)).toBeNull();
  });

  it('rejects relative targets escaping the filesystem root', () => {
    expect(resolveEditorLocalHref('../../../../../../../etc/passwd', DOCUMENT_PATH)).toBeNull();
  });

  it('normalizes dot segments in the resolved path', () => {
    expect(resolveEditorLocalHref('../课程与实验/../公共/方案.md', DOCUMENT_PATH))
      .toEqual({
        path: '/Notes/开发任务管理/个人流程选题/科学课程/课程与实验/公共/方案.md',
        anchor: null,
      });
  });
});

describe('decodeEditorHref', () => {
  it('decodes valid sequences and keeps malformed ones intact', () => {
    expect(decodeEditorHref('%E8%AE%A1%E5%88%92%E8%A1%A8.csv')).toBe('计划表.csv');
    expect(decodeEditorHref('计划表%2.csv')).toBe('计划表%2.csv');
  });
});

// Markdown 中无协议的地址按相对路径解析；网页地址使用显式协议。
describe('isRelativePathHref', () => {
  it.each([
    'skills/RESOLVER.md',
    'skills/RESOLVER.md#section',
    './notes/a.md',
    '../notes/a.md',
    'README.md',
    'notes/2024.计划/a.md',
    'images/pic.png',
    'skills/',
    'skills',
    'data.custom',
    'example.com',
    'example.com/docs',
  ])('treats a path-shaped reference as a sibling path: %s', href => {
    expect(isRelativePathHref(href)).toBe(true);
  });

  it.each([
    'https://example.com/a.md',
    'http://example.com',
    'mailto:a@b.com',
    'flowix://open?b=Book&f=a.md',
    '//example.com/a.md',
    '/Users/rop/notes/a.md',
    'D:\\notes\\a.md',
    '#heading',
    '?query=1',
    '',
    '   ',
  ])('keeps other hrefs out of the sibling-path rule: %s', href => {
    expect(isRelativePathHref(href)).toBe(false);
  });

  it('ignores query and fragment when classifying the path', () => {
    expect(isRelativePathHref('skills/a.md?v=2')).toBe(true);
    expect(isRelativePathHref('example.com/docs?v=2')).toBe(true);
  });

  // 目录名称包含点号也不会把相对路径变成网页地址。
  it('stays consistent with the editor resolver for host-shaped paths with a file extension', () => {
    expect(isRelativePathHref('example.com/a.md')).toBe(true);
    expect(resolveEditorLocalHref('example.com/a.md', DOCUMENT_PATH)).not.toBeNull();
  });
});

it('keeps bare extensionless destinations editable and probes a notebook note', () => {
  expect(resolveEditorLocalHref('资料#标题', DOCUMENT_PATH)).toMatchObject({ notebookNoteName: '资料', anchor: '标题' });
  expect(resolveEditorLocalHref('folder/data.custom', DOCUMENT_PATH)).not.toBeNull();
});

it('opens a native UNC path as an absolute local link', () => {
  expect(resolveEditorLocalHref(String.raw`\\server\share\资料.md`, DOCUMENT_PATH))
    .toEqual({ path: '//server/share/资料.md', anchor: null });
});
