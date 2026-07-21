import { describe, expect, it, vi } from 'vitest';

// buildTagTreeOptions / resolveSelectedTagId 是纯函数不碰 IPC; service 模块
// 顶部 import 了 @platform/tauri/client, 空 mock 防止测试环境加载真实 client。
vi.mock('@platform/tauri/client', () => ({
  memos: {},
  system: {},
  tags: {},
}));

import {
  buildTagTreeOptions,
  resolveSelectedTagId,
  type MemoTagLayoutItem,
  type MemoTagTreeItem,
} from './memo-list-metadata-service';

function makeTagMap(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries);
}

function makeLayout(ids: string[]): MemoTagLayoutItem[] {
  // parentId 字段在 saved layout 里已被忽略; 保留只是为了 IPC 兼容。
  return ids.map((id) => ({ id, parentId: null }));
}

describe('buildTagTreeOptions (segment-node expansion)', () => {
  it('expands single full path into 3 segment nodes', () => {
    // 真实 tag 只有一条: `中国/湖南/长沙`, 但 UI 树要展示 3 个节点。
    const tree = buildTagTreeOptions({
      layout: makeLayout(['中国/湖南/长沙']),
      tagById: makeTagMap([['中国/湖南/长沙', '中国/湖南/长沙']]),
      prefixCounts: {},
    });

    expect(tree.map((t) => t.fullPath)).toEqual([
      '中国',
      '中国/湖南',
      '中国/湖南/长沙',
    ]);
    expect(tree.map((t) => t.name)).toEqual(['中国', '湖南', '长沙']);
    expect(tree.map((t) => t.depth)).toEqual([0, 1, 2]);
  });

  it('merges duplicate segments from different full paths', () => {
    // 真实 tag: `中国/北京` + `中国/湖南` ── `中国` 节点只出现一次。
    const tree = buildTagTreeOptions({
      layout: makeLayout(['中国/北京', '中国/湖南']),
      tagById: makeTagMap([
        ['中国/北京', '中国/北京'],
        ['中国/湖南', '中国/湖南'],
      ]),
      prefixCounts: {},
    });

    const fullPaths = tree.map((t) => t.fullPath);
    // 中国 出现且只出现一次
    expect(fullPaths.filter((p) => p === '中国')).toHaveLength(1);
    expect(fullPaths).toEqual(['中国', '中国/北京', '中国/湖南']);
  });

  it('preserves sibling order from layout first appearance', () => {
    // layout 里 `中国/广东` 在前, `中国/北京` 在后 ── 兄弟顺序应如此。
    const tree = buildTagTreeOptions({
      layout: makeLayout(['中国/广东', '中国/北京']),
      tagById: makeTagMap([
        ['中国/广东', '中国/广东'],
        ['中国/北京', '中国/北京'],
      ]),
      prefixCounts: {},
    });

    const chinaChildren = tree
      .filter((t) => t.parentId === '中国')
      .map((t) => t.fullPath);
    expect(chinaChildren).toEqual(['中国/广东', '中国/北京']);
  });

  it('derives parentId from fullPath string (not from saved layout)', () => {
    // layout.parentId 写错 (WRONG_PARENT) 不应影响结果
    const tree = buildTagTreeOptions({
      layout: [
        { id: 'A', parentId: null },
        { id: 'A/B', parentId: 'WRONG_PARENT' },
        { id: 'A/B/C', parentId: null },
      ],
      tagById: makeTagMap([
        ['A', 'A'],
        ['A/B', 'A/B'],
        ['A/B/C', 'A/B/C'],
      ]),
      prefixCounts: {},
    });

    const find = (fp: string) => tree.find((t) => t.fullPath === fp)!;
    expect(find('A').parentId).toBeNull();
    expect(find('A/B').parentId).toBe('A');
    expect(find('A/B/C').parentId).toBe('A/B');
  });

  it('uses prefix counts from backend (按 memo 数, 非 tag 数)', () => {
    // 后端 `get_tag_prefix_counts` 已经按 distinct memo 算好。
    // 这里直接验证 buildTagTreeOptions 透传 prefixCounts[fullPath]。
    const tree = buildTagTreeOptions({
      layout: makeLayout(['中国/湖南/长沙']),
      tagById: makeTagMap([['中国/湖南/长沙', '中国/湖南/长沙']]),
      prefixCounts: {
        // 后端给的数: 3 个 memo 同时有 中国/湖南/长沙, 其中 5 个 memo
        // 有 中国/湖南 (含前面 3), 6 个 memo 有 中国 (含前面 5)。
        中国: 6,
        '中国/湖南': 5,
        '中国/湖南/长沙': 3,
      },
    });

    const find = (fp: string) => tree.find((t) => t.fullPath === fp)!;
    expect(find('中国').count).toBe(6);
    expect(find('中国/湖南').count).toBe(5);
    expect(find('中国/湖南/长沙').count).toBe(3);
  });

  it('falls back to 0 count when prefix missing in map', () => {
    const tree = buildTagTreeOptions({
      layout: makeLayout(['A', 'A/B']),
      tagById: makeTagMap([
        ['A', 'A'],
        ['A/B', 'A/B'],
      ]),
      prefixCounts: { 'A/B': 3 }, // 故意没给 A
    });
    const find = (fp: string) => tree.find((t) => t.fullPath === fp)!;
    expect(find('A').count).toBe(0);
    expect(find('A/B').count).toBe(3);
  });

  it('handles missing intermediate parents via ensureSegment recursion', () => {
    // 真实 tag: `A/B/C` (无 `A`, 无 `A/B`)
    // → 三个 segment 都应入树, parent 由 fullPath 字面推导
    const tree = buildTagTreeOptions({
      layout: makeLayout(['A/B/C']),
      tagById: makeTagMap([['A/B/C', 'A/B/C']]),
      prefixCounts: {},
    });

    expect(tree.map((t) => t.fullPath)).toEqual(['A', 'A/B', 'A/B/C']);
    const find = (fp: string) => tree.find((t) => t.fullPath === fp)!;
    expect(find('A').parentId).toBeNull();
    expect(find('A/B').parentId).toBe('A');
    expect(find('A/B/C').parentId).toBe('A/B');
  });

  it('skips layout entries that are not in tagById', () => {
    // layout 里有 `STALE`, tagById 里没有 ── 不应入树
    const tree = buildTagTreeOptions({
      layout: makeLayout(['A', 'STALE', 'A/B']),
      tagById: makeTagMap([
        ['A', 'A'],
        ['A/B', 'A/B'],
      ]),
      prefixCounts: {},
    });

    const fullPaths = tree.map((t) => t.fullPath);
    expect(fullPaths).not.toContain('STALE');
    expect(fullPaths).toEqual(['A', 'A/B']);
  });

  it('single-level tag produces single root node', () => {
    const tree = buildTagTreeOptions({
      layout: makeLayout(['plain']),
      tagById: makeTagMap([['plain', 'plain']]),
      prefixCounts: {},
    });

    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      id: 'plain',
      fullPath: 'plain',
      name: 'plain',
      parentId: null,
      depth: 0,
      count: 0,
    });
  });

  it('handles empty layout gracefully', () => {
    const tree = buildTagTreeOptions({
      layout: [],
      tagById: makeTagMap([['A', 'A']]),
      prefixCounts: {},
    });
    expect(tree).toEqual([]);
  });

  it('root nodes from real tag and derived segment appear in DFS order', () => {
    // layout: 先 `中国/北京`, 再 `美国` (独立 root)
    // 树结构: 中国 → 中国/北京 | 美国 (root)
    const tree = buildTagTreeOptions({
      layout: makeLayout(['中国/北京', '美国']),
      tagById: makeTagMap([
        ['中国/北京', '中国/北京'],
        ['美国', '美国'],
      ]),
      prefixCounts: {},
    });

    expect(tree.map((t) => t.fullPath)).toEqual(['中国', '中国/北京', '美国']);
  });
});

describe('resolveSelectedTagId', () => {
  // 校验 selectedTagId 是否是 tagOptions 里实际存在的节点 (含路径前缀 segment)。
  // 重命名后 selectedTagId 可能暂时是旧路径, 调用方回写时用它重新校验当前值。
  const options = (fullPaths: string[]): MemoTagTreeItem[] =>
    fullPaths.map((fp) => {
      const lastSlash = fp.lastIndexOf('/');
      return {
        id: fp,
        parentId: lastSlash > 0 ? fp.slice(0, lastSlash) : null,
        name: lastSlash > 0 ? fp.slice(lastSlash + 1) : fp,
        fullPath: fp,
        depth: (fp.match(/\//g) ?? []).length,
        count: 0,
      };
    });

  it('keeps selectedTagId when it is a path-prefix segment (parent node)', () => {
    // 真实 tag `Flowix/云存储` 展开出父 segment `Flowix`; 选中 `Flowix` 合法保留。
    expect(resolveSelectedTagId('Flowix', options(['Flowix', 'Flowix/云存储']))).toBe('Flowix');
  });

  it('keeps selectedTagId when it is a real (leaf) tag fullPath', () => {
    expect(resolveSelectedTagId('Flowix/云存储', options(['Flowix', 'Flowix/云存储']))).toBe('Flowix/云存储');
  });

  it('clears selectedTagId when it is not a node in the tree', () => {
    expect(resolveSelectedTagId('NonExistent', options(['Flowix', 'Flowix/云存储']))).toBeNull();
  });

  it('returns null for null selectedTagId', () => {
    expect(resolveSelectedTagId(null, options(['Flowix']))).toBeNull();
  });
});
