import { describe, expect, it } from 'vitest';

import type { DocTreeItem } from '@platform/tauri/client';
import {
  buildLoadedTreeIndex,
  flattenVisibleTree,
  type FolderTreeState,
} from '@features/memo/components/use-folder-tree';

/**
 * Pure view-model helpers of the file tree (`flattenVisibleTree` /
 * `buildLoadedTreeIndex`). Split out of `use-folder-tree.test.tsx` when that
 * suite reached the thousand-line gate: these cases need no hook, no mounted
 * probe and no IPC mock, so they do not belong next to the stateful ones.
 */

function dir(path: string, name: string, children: DocTreeItem[] = []): DocTreeItem {
  return { id: `file-${path}`, fullPath: path, name, type: 'folder', parentId: null, children, sizeBytes: null, modifiedMs: null, createdMs: null, memoCreatedMs: null };
}

function file(path: string, name: string): DocTreeItem {
  return { id: `file-${path}`, fullPath: path, name, type: 'document', parentId: null, children: null, sizeBytes: 0, modifiedMs: null, createdMs: null, memoCreatedMs: null };
}

describe('flattenVisibleTree', () => {
  it('只拍平已展开分支, 深度随层级递增', () => {
    const state: FolderTreeState = {
      rootChildren: [
        dir('/root/a', 'a', [dir('/root/a/b', 'b')]),
        file('/root/x.md', 'x.md'),
      ],
      nodes: new Map([
        ['/root/a', dir('/root/a', 'a', [dir('/root/a/b', 'b')])],
        ['/root/a/b', dir('/root/a/b', 'b')],
      ]),
      expanded: new Set(['/root/a']),
      loading: false,
      loadingDirectories: new Set(),
      directoryErrors: new Set(),
      error: null,
    };
    const flattened = flattenVisibleTree(state);
    // a 展开 → a/b 可见; a/b 未展开 → b 的子级不出现。
    expect(flattened.map((n) => n.item.fullPath)).toEqual([
      '/root/a',
      '/root/a/b',
      '/root/x.md',
    ]);
    expect(flattened[1].depth).toBe(1);
  });

  it('按笔记索引时间与文件创建时间混排同级文档', () => {
    const folder = { ...dir('/root/folder', 'folder'), createdMs: 999 };
    const replacedOlderNote = {
      ...file('/root/older-note.md', 'older-note.md'),
      createdMs: 100,
      memoCreatedMs: 10,
    };
    const newerFile = {
      ...file('/root/image.png', 'image.png'),
      createdMs: 20,
    };
    const newerNote = {
      ...file('/root/newer-note.md', 'newer-note.md'),
      createdMs: 30,
      memoCreatedMs: 30,
    };
    const state: FolderTreeState = {
      rootChildren: [replacedOlderNote, folder, newerFile, newerNote],
      nodes: new Map(),
      expanded: new Set(),
      loading: false,
      loadingDirectories: new Set(),
      directoryErrors: new Set(),
      error: null,
    };

    expect(flattenVisibleTree(state, 'createdAt').map(({ item }) => item.name)).toEqual([
      'folder',
      'newer-note.md',
      'image.png',
      'older-note.md',
    ]);
  });

  it('隐藏文件夹恒定聚在普通文件夹之前, 降序也不甩到末尾', () => {
    const state: FolderTreeState = {
      rootChildren: [
        { ...dir('/root/notes', 'notes'), createdMs: 80 },
        { ...dir('/root/.trash', '.trash'), createdMs: 1 },
        { ...dir('/root/archive', 'archive'), createdMs: 2 },
        { ...dir('/root/.plugin-output', '.plugin-output'), createdMs: 90 },
      ],
      nodes: new Map(),
      expanded: new Set(),
      loading: false,
      loadingDirectories: new Set(),
      directoryErrors: new Set(),
      error: null,
    };

    // 默认 A-Z: 隐藏组整体置顶, 每组内按文件名升序。
    expect(flattenVisibleTree(state).map(({ item }) => item.name)).toEqual([
      '.plugin-output',
      '.trash',
      'archive',
      'notes',
    ]);
    // filenameDesc: 组内与普通组都反序, 隐藏组的位置不变。
    expect(flattenVisibleTree(state, 'filenameDesc').map(({ item }) => item.name)).toEqual([
      '.trash',
      '.plugin-output',
      'notes',
      'archive',
    ]);
  });

  it('置顶文件夹不再改变访问空间排序, 仍按排序规则就地排列', () => {
    const state: FolderTreeState = {
      rootChildren: [
        { ...dir('/root/notes', 'notes'), createdMs: 80 },
        { ...dir('/root/.trash', '.trash'), createdMs: 1 },
        { ...dir('/root/archive', 'archive'), createdMs: 2 },
      ],
      nodes: new Map(),
      expanded: new Set(),
      loading: false,
      loadingDirectories: new Set(),
      directoryErrors: new Set(),
      error: null,
    };

    // archive 被置顶后, 访问空间仍把它排在隐藏组之后、按 A-Z 就地排序;
    // 置顶只负责把它复制到「置顶」分组, 不参与这里的排序。
    expect(flattenVisibleTree(state).map(({ item }) => item.name)).toEqual([
      '.trash',
      'archive',
      'notes',
    ]);
  });
});

describe('buildLoadedTreeIndex', () => {
  it('resolves a root placeholder to the loaded folder node', () => {
    const rootFolder = dir('/root/sub', 'sub');
    const loadedFolder = dir('/root/sub', 'sub', [file('/root/sub/note.md', 'note.md')]);

    const { itemByPath, folderPaths } = buildLoadedTreeIndex({
      rootChildren: [rootFolder],
      nodes: new Map([[rootFolder.fullPath, loadedFolder]]),
    });

    expect(itemByPath.get('/root/sub')).toBe(loadedFolder);
    expect(folderPaths.has('/root/sub')).toBe(true);
  });
});
