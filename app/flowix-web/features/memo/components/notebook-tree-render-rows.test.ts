import { describe, expect, it } from 'vitest';

import { parentDirectoryPath } from '@/lib/path';
import type { DocTreeItem } from '@platform/tauri/client';

import { buildNotebookTreeRenderModel } from './notebook-tree-render-rows';

function item(fullPath: string, type: 'folder' | 'document' = 'document'): DocTreeItem {
  return {
    id: `i:${fullPath}`,
    fullPath,
    name: fullPath.split('/').pop() ?? fullPath,
    type,
    parentId: null,
    children: type === 'folder' ? [] : null,
    sizeBytes: null,
    modifiedMs: null,
    createdMs: null,
    memoCreatedMs: null,
  };
}

function parentOf(fullPath: string, notebookPath: string): string {
  const model = buildNotebookTreeRenderModel([{ item: item(fullPath), depth: 0 }], notebookPath, null);
  return (model.rows[0] as { parentPath: string }).parentPath;
}

describe('buildNotebookTreeRenderModel', () => {
  it('derives the same parent as parentDirectoryPath, including Windows drive roots', () => {
    const cases: [string, string][] = [
      ['/notes/a.md', '/notes'],
      ['/notes/folder/a.md', '/notes'],
      ['/notes/folder/deep/a.md', '/notes'],
      ['C:/notes/a.md', 'C:/notes'],
      ['C:/notes/deep/a.md', 'C:/notes'],
      ['c:/notes/a.md', 'c:/notes'],
      ['//server/share/a.md', '//server/share'],
      ['/notes/messy//a.md', '/notes'],
    ];

    for (const [fullPath, notebookPath] of cases) {
      expect(parentOf(fullPath, notebookPath)).toBe(parentDirectoryPath(fullPath, notebookPath));
    }
  });

  it('numbers siblings and indexes rows in the same pass', () => {
    const model = buildNotebookTreeRenderModel([
      { item: item('/notes/a', 'folder'), depth: 0 },
      { item: item('/notes/b.md'), depth: 0 },
      { item: item('/notes/a/c.md'), depth: 1 },
    ], '/notes', null);

    expect(model.rows.map((row) => row.kind)).toEqual(['node', 'node', 'node']);
    expect(model.rows.map((row) => (row as { posInSet?: number }).posInSet)).toEqual([1, 2, 1]);
    expect(model.rows.map((row) => (row as { setSize?: number }).setSize)).toEqual([2, 2, 1]);
    expect([...model.rowIndexByPath]).toEqual([['/notes/a', 0], ['/notes/b.md', 1], ['/notes/a/c.md', 2]]);
  });

  it('shifts row indexes past the draft row and keeps the draft out of setSize', () => {
    const model = buildNotebookTreeRenderModel([
      { item: item('/notes/a', 'folder'), depth: 0 },
      { item: item('/notes/b.md'), depth: 0 },
    ], '/notes', { requestId: 3, parentPath: '/notes', value: '新文件夹' });

    expect(model.rows.map((row) => row.kind)).toEqual(['draft', 'node', 'node']);
    expect(model.rowIndexByPath.get('/notes/a')).toBe(1);
    expect(model.rowIndexByPath.get('/notes/b.md')).toBe(2);
    // 草稿行不参与兄弟计数（与合并前行为一致）。
    expect((model.rows[1] as { setSize?: number }).setSize).toBe(2);
  });
});
