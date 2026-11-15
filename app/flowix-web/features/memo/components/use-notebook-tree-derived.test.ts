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
  it('resolves a root placeholder to the loaded node and still indexes unregistered children', () => {
    const loaded = dir('/root/sub', 'sub', [file('/root/sub/note.md', 'note.md')]);
    const nodes = new Map<string, DocTreeItem>([['/root/sub', loaded]]);

    const index = buildLoadedTreeIndex({ rootChildren: [dir('/root/sub', 'sub')], nodes });

    expect(index.itemByPath.get('/root/sub')).toBe(loaded);
    // 子项没单独登记进 nodes 也要能查到：flatten 是按父节点 children 下钻的，
    // 这类行渲染得出来，选/删/拖都得按路径找得到它。
    expect(index.itemByPath.get('/root/sub/note.md')).toBe(loaded.children![0]);
    expect([...index.folderPaths]).toEqual(['/root/sub']);
  });

  it('still reaches root items that have not been reconciled into nodes yet', () => {
    // 首次读取前后、watcher 重建后的瞬时窗口：根项还不在 nodes 里。
    const placeholder = dir('/root/filled', 'filled');

    const index = buildLoadedTreeIndex({ rootChildren: [placeholder], nodes: new Map() });

    expect(index.itemByPath.get('/root/filled')).toBe(placeholder);
    expect(index.folderPaths.has('/root/filled')).toBe(true);
  });

  it('indexes nodes that watcher reconcile detached from their parent', () => {
    const index = buildLoadedTreeIndex({
      rootChildren: [dir('/root/filled', 'filled')],
      nodes: new Map([['/root/lost.md', file('/root/lost.md', 'lost.md')]]),
    });

    expect(index.itemByPath.has('/root/lost.md')).toBe(true);
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
