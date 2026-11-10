import { describe, expect, it } from 'vitest';
import {
  resolveDocumentBreadcrumb,
  resolveDocumentBreadcrumbItems,
  resolveFileBrowserBreadcrumbItems,
  resolveFileBrowserBreadcrumbs,
} from './file-browser-breadcrumb';

describe('resolveFileBrowserBreadcrumbs', () => {
  it('uses the root directory name and relative file path', () => {
    expect(resolveFileBrowserBreadcrumbs(
      '/Users/rop/Desktop/vibe/flowix-main',
      '/Users/rop/Desktop/vibe/flowix-main/app/src/index.ts',
    )).toEqual(['flowix-main', 'app', 'src', 'index.ts']);
  });

  it('normalizes Windows separators', () => {
    expect(resolveFileBrowserBreadcrumbs(
      'C:\\work\\flowix-main',
      'C:\\work\\flowix-main\\app\\src\\index.ts',
    )).toEqual(['flowix-main', 'app', 'src', 'index.ts']);
  });

  it('shows only the root before a file is selected', () => {
    expect(resolveFileBrowserBreadcrumbs('/workspace/flowix-main', null))
      .toEqual(['flowix-main']);
  });

  it('keeps the exact folder path for each clickable breadcrumb', () => {
    expect(resolveFileBrowserBreadcrumbItems(
      '/workspace/flowix-main',
      '/workspace/flowix-main/app/src/index.ts',
    )).toEqual([
      { label: 'flowix-main', path: '/workspace/flowix-main', type: 'folder' },
      { label: 'app', path: '/workspace/flowix-main/app', type: 'folder' },
      { label: 'src', path: '/workspace/flowix-main/app/src', type: 'folder' },
      { label: 'index.ts', path: '/workspace/flowix-main/app/src/index.ts', type: 'file' },
    ]);
  });
});

describe('resolveDocumentBreadcrumbItems', () => {
  it('drops the note suffix on the current file only, like the file tree', () => {
    expect(resolveDocumentBreadcrumbItems(
      '/notebooks/小红书运营知识库',
      '/notebooks/小红书运营知识库/08 原则/番茄笔记.md',
    )).toEqual([
      { label: '小红书运营知识库', path: '/notebooks/小红书运营知识库', type: 'folder' },
      { label: '08 原则', path: '/notebooks/小红书运营知识库/08 原则', type: 'folder' },
      { label: '番茄笔记', path: '/notebooks/小红书运营知识库/08 原则/番茄笔记.md', type: 'file' },
    ]);
  });

  it('also hides html and table suffixes, and keeps unknown extensions', () => {
    const labels = (file: string) => {
      const items = resolveDocumentBreadcrumbItems('/space', `/space/${file}`);
      return items[items.length - 1]!.label;
    };
    expect(labels('report.html')).toBe('report');
    expect(labels('数据.table.yaml')).toBe('数据');
    expect(labels('config.json')).toBe('config.json');
  });

  it('falls back to the real filename when stripping leaves nothing', () => {
    const items = resolveDocumentBreadcrumbItems('/space', '/space/.index.yaml');
    expect(items[items.length - 1]!.label).toBe('.index.yaml');
  });

  it('never rewrites folder segments that look like files', () => {
    expect(resolveDocumentBreadcrumbItems('/space', '/space/docs.md/readme.md')).toEqual([
      { label: 'space', path: '/space', type: 'folder' },
      { label: 'docs.md', path: '/space/docs.md', type: 'folder' },
      { label: 'readme', path: '/space/docs.md/readme.md', type: 'file' },
    ]);
  });
});

describe('resolveDocumentBreadcrumb', () => {
  const note = '/notebooks/知识库/08 原则/番茄笔记.md';

  it('skips collections, which keep their own tabbed shell', () => {
    expect(resolveDocumentBreadcrumb({
      filePath: '/notebooks/知识库/.index.yaml',
      collectionIndexPath: '/notebooks/知识库/.index.yaml',
      scopeRoots: ['/notebooks/知识库'],
    })).toBeNull();
  });

  it('prefers the first explicit scope root', () => {
    expect(resolveDocumentBreadcrumb({
      filePath: note,
      scopeRoots: [null, '  ', '/notebooks/知识库'],
      notebookRoots: ['/notebooks'],
    })?.map((item) => item.label)).toEqual(['知识库', '08 原则', '番茄笔记']);
  });

  it('derives ownership from the notebook list when the surface carries no scope', () => {
    expect(resolveDocumentBreadcrumb({
      filePath: note,
      scopeRoots: [null],
      notebookRoots: ['/notebooks', '/notebooks/知识库'],
    })?.map((item) => item.label)).toEqual(['知识库', '08 原则', '番茄笔记']);
  });

  it('falls back to the tree root, then gives up', () => {
    expect(resolveDocumentBreadcrumb({
      filePath: note,
      treeRoot: '/notebooks/知识库/08 原则',
    })?.map((item) => item.label)).toEqual(['08 原则', '番茄笔记']);
    expect(resolveDocumentBreadcrumb({ filePath: note })).toBeNull();
    expect(resolveDocumentBreadcrumb({ filePath: null, treeRoot: '/notebooks' })).toBeNull();
  });
});
