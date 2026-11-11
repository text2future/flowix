import { describe, expect, it } from 'vitest';

import type { DocTreeItem } from '@platform/tauri/client';

import {
  addPinnedTreeItems,
  buildNotebookTreeRenderModel,
} from './use-notebook-tree-derived';
import { buildLoadedTreeIndex } from './use-folder-tree';

function dir(path: string, name: string, children: DocTreeItem[] = []): DocTreeItem {
  return {
    id: `file-${path}`, fullPath: path, name, type: 'folder', parentId: null,
    children, sizeBytes: null, modifiedMs: null, createdMs: null, memoCreatedMs: null,
  };
}

function file(path: string, name: string): DocTreeItem {
  return {
    id: `file-${path}`, fullPath: path, name, type: 'document', parentId: null,
    children: null, sizeBytes: 0, modifiedMs: null, createdMs: null, memoCreatedMs: null,
  };
}

describe('buildLoadedTreeIndex', () => {
  it('uses loaded children over the root placeholder and fills every table at once', () => {
    const placeholder = dir('/root/sub', 'sub');
    const loaded = dir('/root/sub', 'sub', [file('/root/sub/note.md', 'note.md')]);

    const index = buildLoadedTreeIndex({
      rootChildren: [placeholder],
      nodes: new Map([[placeholder.fullPath, loaded]]),
    });

    expect(index.items.map((item) => item.fullPath)).toEqual(['/root/sub', '/root/sub/note.md']);
    // 索引与 items 同源，命中同一批节点。
    expect([...index.itemByPath.keys()]).toEqual(['/root/sub', '/root/sub/note.md']);
    expect(index.itemByPath.get('/root/sub')).toBe(loaded);
    expect([...index.folderPaths]).toEqual(['/root/sub']);
  });

  it('still indexes nodes that watcher reconcile detached from their parent', () => {
    const index = buildLoadedTreeIndex({
      rootChildren: [dir('/root/filled', 'filled')],
      nodes: new Map([['/root/lost.md', file('/root/lost.md', 'lost.md')]]),
    });

    expect(index.items.map((item) => item.fullPath)).toEqual(['/root/filled', '/root/lost.md']);
    expect(index.folderPaths.has('/root/lost.md')).toBe(false);
  });
});

describe('addPinnedTreeItems', () => {
  it('keeps the loaded node when a pinned row shares its path', () => {
    const loadedItem = file('/root/note.md', 'note.md');
    const index = buildLoadedTreeIndex({
      rootChildren: [loadedItem],
      nodes: new Map([[loadedItem.fullPath, loadedItem]]),
    });
    const pinnedRow: DocTreeItem = { ...file('/root/note.md', 'note.md'), pinned: true };

    const merged = addPinnedTreeItems(index, [pinnedRow]);

    // 置顶行多出的渲染字段不该盖掉树里的基础节点。
    expect(merged.itemByPath.get('/root/note.md')).toBe(loadedItem);
    // 没有新路径 → 引用不变，下游 memo 不重算。
    expect(merged).toBe(index);
  });

  it('adds a pinned entry whose folder was never expanded', () => {
    const index = buildLoadedTreeIndex({ rootChildren: [], nodes: new Map() });
    const pinnedFolder = dir('/root/late', 'late');

    const merged = addPinnedTreeItems(index, [pinnedFolder]);

    expect(merged).not.toBe(index);
    expect(merged.itemByPath.get('/root/late')).toBe(pinnedFolder);
    expect(merged.folderPaths.has('/root/late')).toBe(true);
    // 原索引不被就地改写，否则 memo 缓存会带着陈旧内容继续用。
    expect(index.itemByPath.size).toBe(0);
  });
});

describe('buildNotebookTreeRenderModel', () => {
  it('indexes node rows and leaves the draft row out', () => {
    const folder = dir('/root/folder', 'folder');
    const model = buildNotebookTreeRenderModel(
      [{ item: folder, depth: 0 }],
      '/root',
      { requestId: 7, parentPath: '/root', value: '草案' },
    );

    expect(model.rows.map((row) => row.kind)).toEqual(['draft', 'node']);
    expect([...model.rowIndexByPath.keys()]).toEqual(['/root/folder']);
    expect(model.rowIndexByPath.get('/root/folder')).toBe(1);
  });
});
