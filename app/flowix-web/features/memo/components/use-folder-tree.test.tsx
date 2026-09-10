import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocTreeItem } from '@platform/tauri/client';
import {
  flattenVisibleTree,
  useFolderTree,
  type FolderTreeState,
} from '@features/memo/components/use-folder-tree';

// files IPC mock ── getTree / getDirChildren 均按测试用例注入。
const getTreeMock = vi.fn<(path: string) => Promise<DocTreeItem[] | null>>();
const getDirChildrenMock = vi.fn<(path: string) => Promise<DocTreeItem[]>>();

vi.mock('@platform/tauri/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@platform/tauri/client')>();
  return {
    ...actual,
    files: {
      ...actual.files,
      getTree: (path: string) => getTreeMock(path),
      getDirChildren: (path: string) => getDirChildrenMock(path),
    },
  };
});

function dir(path: string, name: string, children: DocTreeItem[] = []): DocTreeItem {
  return { id: `file-${path}`, fullPath: path, name, type: 'folder', parentId: null, children, sizeBytes: null, modifiedMs: null, createdMs: null };
}

function file(path: string, name: string): DocTreeItem {
  return { id: `file-${path}`, fullPath: path, name, type: 'document', parentId: null, children: null, sizeBytes: 0, modifiedMs: null, createdMs: null };
}

// 仓库测试惯例 (无 @testing-library): createRoot 挂一个 probe 组件,
// hook 状态经 onChange 回调写到外层变量。
let lastState: ReturnType<typeof useFolderTree> | null = null;

function TreeProbe({ folderPath }: { folderPath: string }) {
  lastState = useFolderTree(folderPath);
  return null;
}

describe('useFolderTree', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    getTreeMock.mockReset();
    getDirChildrenMock.mockReset();
    lastState = null;
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  function mount(folderPath: string) {
    act(() => {
      root?.render(createElement(TreeProbe, { folderPath }));
    });
  }

  it('加载根目录单层列表, folder 占位空 children', async () => {
    getTreeMock.mockResolvedValue([dir('/root/sub', 'sub'), file('/root/a.md', 'a.md')]);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    expect(lastState?.rootChildren).toHaveLength(2);
    expect(getTreeMock).toHaveBeenCalledWith('/root');
  });

  it('展开 folder 时惰性拉取子级, 收起再展开不重新请求', async () => {
    getTreeMock.mockResolvedValue([dir('/root/sub', 'sub')]);
    getDirChildrenMock.mockResolvedValue([file('/root/sub/x.md', 'x.md')]);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));

    act(() => lastState?.toggle('/root/sub'));
    await vi.waitFor(() => {
      expect(lastState?.nodes.get('/root/sub')?.children).toHaveLength(1);
    });
    expect(lastState?.expanded.has('/root/sub')).toBe(true);
    expect(getDirChildrenMock).toHaveBeenCalledTimes(1);

    act(() => lastState?.toggle('/root/sub'));
    act(() => lastState?.toggle('/root/sub'));
    expect(getDirChildrenMock).toHaveBeenCalledTimes(1);
  });

  it('根目录不可读时置 error 且列表为空', async () => {
    getTreeMock.mockResolvedValue(null);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.error).toBe('unreadable'));
    expect(lastState?.rootChildren).toHaveLength(0);
  });

  it('根目录局部刷新保留已展开目录', async () => {
    getTreeMock.mockResolvedValue([dir('/root/sub', 'sub')]);
    getDirChildrenMock.mockResolvedValue([file('/root/sub/x.md', 'x.md')]);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    act(() => lastState?.toggle('/root/sub'));
    await vi.waitFor(() => expect(lastState?.expanded.has('/root/sub')).toBe(true));

    getTreeMock.mockResolvedValue([
      dir('/root/sub', 'sub'),
      file('/root/new.md', 'new.md'),
    ]);
    await act(async () => { await lastState?.refresh('/root'); });

    expect(lastState?.expanded.has('/root/sub')).toBe(true);
    expect(lastState?.rootChildren.map((item) => item.name)).toContain('new.md');
  });
});

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
});
