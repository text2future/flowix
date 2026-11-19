import { describe, expect, it } from 'vitest';

import type { DocTreeItem } from '@platform/tauri/client';
import { emptySnapshot, rebaseSnapshot, type FolderTreeSnapshot } from './folder-tree-model';

/**
 * `rebaseSnapshot` 是改名/移动唯一的状态迁移点，而 hook 测试只能覆盖「同一父
 * 目录改名」和「根换根」两种——拖拽到另一个文件夹（跨父）没有入口可走。这里
 * 直接测纯函数，把四种落点（同父 / 跨父 / 移入根 / 移出根）逐一钉住。
 */

function folder(id: string, path: string, children: DocTreeItem[] = [], parentId: string | null = null): DocTreeItem {
  return {
    id, fullPath: path, name: path.split('/').pop() ?? path, type: 'folder',
    parentId, children, sizeBytes: null, modifiedMs: null, createdMs: null, memoCreatedMs: null,
  };
}

function doc(id: string, path: string): DocTreeItem {
  return {
    id, fullPath: path, name: path.split('/').pop() ?? path, type: 'document',
    parentId: null, children: null, sizeBytes: 0, modifiedMs: null, createdMs: null, memoCreatedMs: null,
  };
}

/** `/root` 下两个文件夹：`a/` 带一个子目录 `sub/` 和一篇笔记，`b/` 为空。 */
function tree(): FolderTreeSnapshot {
  const sub = folder('f-sub', '/root/a/sub', [doc('d-1', '/root/a/sub/x.md')], 'f-a');
  const a = folder('f-a', '/root/a', [sub]);
  const b = folder('f-b', '/root/b');
  const nodes = new Map<string, DocTreeItem>([
    ['/root/a', a],
    ['/root/a/sub', sub],
    ['/root/a/sub/x.md', doc('d-1', '/root/a/sub/x.md')],
    ['/root/b', b],
  ]);
  return {
    nodes,
    rootChildren: [a, b],
    expanded: new Set(['/root/a', '/root/a/sub']),
    directories: new Map([
      ['/root/a/sub', { loading: false, error: true, dirty: false, refreshedAt: 7 }],
      ['/root/b', { loading: true, error: false, dirty: false, refreshedAt: 3 }],
    ]),
  };
}

describe('rebaseSnapshot', () => {
  it('同父改名: 路径键、展开态、目录标记一起搬, 加载标记丢弃', () => {
    const next = rebaseSnapshot(tree(), '/root/a/sub', '/root/a/renamed', '/root');
    expect(next).not.toBeNull();
    expect(next!.nodes.has('/root/a/sub')).toBe(false);
    expect(next!.nodes.has('/root/a/renamed/x.md')).toBe(true);
    expect(next!.expanded.has('/root/a/renamed')).toBe(true);
    // 正在读的标记跟着旧路径作废, 不能挂到新路径上等一个永远不会来的响应。
    expect(next!.directories.get('/root/a/renamed')).toEqual({ loading: false, error: true, dirty: false, refreshedAt: 7 });
    // 父行的 children 换了路径, 但没有被重复追加。
    const children = next!.nodes.get('/root/a')!.children!;
    expect(children.map((child) => child.fullPath)).toEqual(['/root/a/renamed']);
    expect(children[0].name).toBe('renamed');
  });

  it('跨父移动: 从旧父摘掉、挂到新父, 并改写 parentId', () => {
    const next = rebaseSnapshot(tree(), '/root/a/sub', '/root/b/sub', '/root');
    expect(next).not.toBeNull();
    expect(next!.nodes.get('/root/a')!.children).toEqual([]);
    const moved = next!.nodes.get('/root/b')!.children!;
    expect(moved.map((child) => child.fullPath)).toEqual(['/root/b/sub']);
    expect(moved[0].id).toBe('f-sub');
    expect(moved[0].parentId).toBe('f-b');
    // 子树整体跟过来
    expect(next!.nodes.has('/root/b/sub/x.md')).toBe(true);
    // 两个父行都还在根列表里
    expect(next!.rootChildren.map((item) => item.fullPath)).toEqual(['/root/a', '/root/b']);
  });

  it('移入根: 进入根列表, parentId 置空', () => {
    const next = rebaseSnapshot(tree(), '/root/a/sub', '/root/sub', '/root');
    expect(next!.rootChildren.map((item) => item.fullPath)).toContain('/root/sub');
    expect(next!.rootChildren.find((item) => item.fullPath === '/root/sub')!.parentId).toBeNull();
    expect(next!.nodes.get('/root/a')!.children).toEqual([]);
  });

  it('移出根: 从根列表摘掉, 挂到内层父目录', () => {
    const next = rebaseSnapshot(tree(), '/root/b', '/root/a/b', '/root');
    expect(next!.rootChildren.map((item) => item.fullPath)).toEqual(['/root/a']);
    expect(next!.nodes.get('/root/a')!.children!.map((child) => child.fullPath)).toEqual(['/root/a/sub', '/root/a/b']);
  });

  it('重复送达同一次移动时返回 null（幂等，避免整表重建重渲染）', () => {
    expect(rebaseSnapshot(tree(), '/root/b', '/root/a/b', '/root')).not.toBeNull();
    const once = rebaseSnapshot(tree(), '/root/b', '/root/a/b', '/root');
    expect(rebaseSnapshot(once!, '/root/b', '/root/a/b', '/root')).toBeNull();
  });

  it('落到树范围之外或原地不动时返回 null', () => {
    expect(rebaseSnapshot(tree(), '/root/a', '/root/a', '/root')).toBeNull();
    expect(rebaseSnapshot(tree(), '/root', '/root', '/root')).toBeNull();
    expect(rebaseSnapshot(emptySnapshot(), '/root/a', '/root/b', '/root')).toBeNull();
  });
});
