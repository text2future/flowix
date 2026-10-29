import { describe, expect, it } from 'vitest';

import { displayTitleFromFilename } from './utils';

describe('displayTitleFromFilename', () => {
  it('剥掉 Markdown 后缀（大小写不敏感）', () => {
    expect(displayTitleFromFilename('笔记.md')).toBe('笔记');
    expect(displayTitleFromFilename('/a/b/Note.MD')).toBe('Note');
    expect(displayTitleFromFilename('Doc.Markdown')).toBe('Doc');
  });

  it('剥掉多维表格 / 媒体库 / 集合索引后缀', () => {
    expect(displayTitleFromFilename('任务.table.yaml')).toBe('任务');
    expect(displayTitleFromFilename('素材.lib.yml')).toBe('素材');
    expect(displayTitleFromFilename('集合.index.yaml')).toBe('集合');
  });

  it('网页文件（html / htm / xhtml）也剥掉后缀', () => {
    expect(displayTitleFromFilename('index.html')).toBe('index');
    expect(displayTitleFromFilename('/Users/rop/Desktop/report.HTM')).toBe('report');
    expect(displayTitleFromFilename('网页.Html')).toBe('网页');
    expect(displayTitleFromFilename('a/b/带空格 的网页.htm')).toBe('带空格 的网页');
    // classifyFileContent 把 xhtml 也归为 html 图标，展示口径保持一致。
    expect(displayTitleFromFilename('page.xhtml')).toBe('page');
  });

  it('不误剥多后缀 / 无后缀', () => {
    expect(displayTitleFromFilename('foo.md.bak')).toBe('foo.md.bak');
    expect(displayTitleFromFilename('Makefile')).toBe('Makefile');
    expect(displayTitleFromFilename('目录.html.bak')).toBe('目录.html.bak');
  });

  it('空值原样返回空串', () => {
    expect(displayTitleFromFilename('')).toBe('');
    expect(displayTitleFromFilename(null)).toBe('');
    expect(displayTitleFromFilename(undefined)).toBe('');
  });
});
