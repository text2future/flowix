import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { files, type DocTreeItem } from '@platform/tauri/client';
import { noteMetadata } from '../services/note-metadata-service';
import {
  flattenLoadedTree,
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
  return { id: `file-${path}`, fullPath: path, name, type: 'folder', parentId: null, children, sizeBytes: null, modifiedMs: null, createdMs: null, memoCreatedMs: null };
}

function file(path: string, name: string): DocTreeItem {
  return { id: `file-${path}`, fullPath: path, name, type: 'document', parentId: null, children: null, sizeBytes: 0, modifiedMs: null, createdMs: null, memoCreatedMs: null };
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
    noteMetadata.clear();
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
    vi.useRealTimers();
  });

  function mount(folderPath: string) {
    act(() => {
      root?.render(createElement(TreeProbe, { folderPath }));
    });
  }

  describe('watcher refresh feedback', () => {
    async function loadExpandedDirectory() {
      getTreeMock.mockResolvedValue([dir('/root/sub', 'sub')]);
      getDirChildrenMock.mockResolvedValue([file('/root/sub/old.md', 'old.md')]);
      mount('/root');
      await vi.waitFor(() => expect(lastState?.loading).toBe(false));
      await act(async () => lastState?.toggle('/root/sub'));
      expect(lastState?.nodes.has('/root/sub/old.md')).toBe(true);
      vi.useFakeTimers();
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    }

    async function notifyWatcher() {
      act(() => lastState?.refreshDirectories(['/root/sub']));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    }

    it('silently reconciles changed files while preserving the visible children', async () => {
      await loadExpandedDirectory();
      let release!: (items: DocTreeItem[]) => void;
      getDirChildrenMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      await notifyWatcher();
      expect(getDirChildrenMock).toHaveBeenCalledTimes(2);
      expect(lastState?.loadingDirectories.has('/root/sub')).toBe(false);
      expect(lastState?.nodes.get('/root/sub')?.children?.[0].name).toBe('old.md');
      await act(async () => release([file('/root/sub/new.md', 'new.md')]));
      expect(lastState?.nodes.has('/root/sub/old.md')).toBe(false);
      expect(lastState?.nodes.has('/root/sub/new.md')).toBe(true);
      expect(lastState?.expanded.has('/root/sub')).toBe(true);
    });

    it('shows feedback for an explicit load joining a silent watcher read', async () => {
      await loadExpandedDirectory();
      let release!: (items: DocTreeItem[]) => void;
      getDirChildrenMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      await notifyWatcher();
      act(() => { void lastState?.loadDirectory('/root/sub'); });
      expect(getDirChildrenMock).toHaveBeenCalledTimes(2);
      expect(lastState?.loadingDirectories.has('/root/sub')).toBe(true);
      await act(async () => release([file('/root/sub/new.md', 'new.md')]));
      expect(lastState?.loadingDirectories.has('/root/sub')).toBe(false);
    });

    it('retains watcher errors and shows loading when the user retries', async () => {
      await loadExpandedDirectory();
      getDirChildrenMock.mockRejectedValueOnce(new Error('unreadable'));
      await notifyWatcher();
      expect(lastState?.loadingDirectories.has('/root/sub')).toBe(false);
      expect(lastState?.directoryErrors.has('/root/sub')).toBe(true);
      expect(lastState?.nodes.has('/root/sub/old.md')).toBe(true);
      let release!: (items: DocTreeItem[]) => void;
      getDirChildrenMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      act(() => { void lastState?.retryDirectory('/root/sub'); });
      expect(lastState?.loadingDirectories.has('/root/sub')).toBe(true);
      await act(async () => release([file('/root/sub/new.md', 'new.md')]));
      expect(lastState?.directoryErrors.has('/root/sub')).toBe(false);
      expect(lastState?.loadingDirectories.has('/root/sub')).toBe(false);
    });

    it('keeps the spinner when a watcher joins the first expansion read', async () => {
      getTreeMock.mockResolvedValue([dir('/root/sub', 'sub')]);
      let release!: (items: DocTreeItem[]) => void;
      getDirChildrenMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      mount('/root');
      await vi.waitFor(() => expect(lastState?.loading).toBe(false));
      act(() => lastState?.toggle('/root/sub'));
      expect(lastState?.loadingDirectories.has('/root/sub')).toBe(true);
      vi.useFakeTimers();
      await notifyWatcher();
      expect(getDirChildrenMock).toHaveBeenCalledTimes(1);
      expect(lastState?.loadingDirectories.has('/root/sub')).toBe(true);
      await act(async () => release([file('/root/sub/new.md', 'new.md')]));
      expect(lastState?.loadingDirectories.has('/root/sub')).toBe(false);
    });
  });

  it.each(['initial', 'refresh', 'reload'] as const)('preserves saved metadata over a delayed %s root read', async (mode) => {
    const oldNote = { ...file('/root/a.md', 'a.md'), memoMeta: { icon: null, colors: [], favorited: false } } satisfies DocTreeItem;
    let release!: (items: DocTreeItem[]) => void;
    const delayed = () => new Promise<DocTreeItem[]>((resolve) => { release = resolve; });
    if (mode === 'initial') getTreeMock.mockImplementationOnce(delayed);
    else getTreeMock.mockResolvedValueOnce([oldNote]);
    mount('/root');
    if (mode !== 'initial') {
      await vi.waitFor(() => expect(lastState?.loading).toBe(false));
      getTreeMock.mockImplementationOnce(delayed);
      act(() => { void (mode === 'reload' ? lastState?.reload() : lastState?.refresh()); });
    }
    const latest = { icon: 'flashlight', colors: ['blue' as const], favorited: true };
    act(() => {
      lastState?.updateNoteMetadata('/root/a.md', { ...latest, icon: 'dog-face' });
      lastState?.updateNoteMetadata('/root/a.md', latest);
    });
    await act(async () => release([oldNote]));
    expect(lastState?.rootChildren[0].memoMeta).toEqual(latest);
    expect(lastState?.nodes.get('/root/a.md')?.memoMeta).toEqual(latest);

    // Protection is scoped to earlier reads, not a permanent metadata override.
    getTreeMock.mockResolvedValueOnce([oldNote]);
    await act(async () => { await lastState?.refresh(); });
    expect(lastState?.rootChildren[0].memoMeta?.icon).toBeNull();
  });

  it('preserves saved metadata over a delayed child read and supports clearing it', async () => {
    getTreeMock.mockResolvedValue([dir('/root/sub', 'sub')]);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    let release!: (items: DocTreeItem[]) => void;
    getDirChildrenMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    act(() => lastState?.toggle('/root/sub'));
    const latest = { icon: 'flashlight', colors: [], favorited: false };
    act(() => lastState?.updateNoteMetadata('/root/sub/a.md', latest));
    await act(async () => release([file('/root/sub/a.md', 'a.md')]));
    expect(lastState?.nodes.get('/root/sub/a.md')?.memoMeta).toEqual(latest);
    expect(lastState?.nodes.get('/root/sub')?.children?.[0].memoMeta).toEqual(latest);
    act(() => lastState?.updateNoteMetadata('/root/sub/a.md', { ...latest, icon: null }));
    expect(lastState?.nodes.get('/root/sub/a.md')?.memoMeta?.icon).toBeNull();
    expect(lastState?.nodes.get('/root/sub')?.children?.[0].memoMeta?.icon).toBeNull();
  });

  it('inserts the folder node when children load before any tree expansion reached it', async () => {
    // 置顶分组可在文件树父链未加载时展开嵌套文件夹 (loadDirectory 不动
    // expanded)。reconcile 必须补上父条目, 否则拍平逻辑在 nodes.get(父)
    // 处断链, 展开渲染成空列表。
    getTreeMock.mockResolvedValue([dir('/root/p', 'p')]);
    getDirChildrenMock.mockImplementation(async (directory) => directory === '/root/p/训练营'
      ? [file('/root/p/训练营/a.md', 'a.md'), dir('/root/p/训练营/b', 'b')]
      : []);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    expect(lastState?.nodes.get('/root/p/训练营')).toBeUndefined();

    await act(async () => { await lastState?.loadDirectory('/root/p/训练营'); });

    const node = lastState?.nodes.get('/root/p/训练营');
    expect(node?.type).toBe('folder');
    expect(node?.fullPath).toBe('/root/p/训练营');
    expect(node?.name).toBe('训练营');
    expect(node?.children?.map((child) => child.fullPath)).toEqual([
      '/root/p/训练营/a.md',
      '/root/p/训练营/b',
    ]);
    // 保留子级缓存: 子文件夹占位不被后续 reconcile 丢弃。
    expect(lastState?.nodes.get('/root/p/训练营/b')?.type).toBe('folder');
  });

  it.each(['refresh', 'reload'] as const)('keeps confirmed metadata when a later %s has no indexed metadata', async (mode) => {
    const path = '/root/a.md';
    getTreeMock.mockResolvedValue([file(path, 'a.md')]);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    const latest = { icon: 'flashlight', colors: ['blue' as const], favorited: true };
    act(() => lastState?.updateNoteMetadata(path, latest));
    getTreeMock.mockResolvedValueOnce([{ ...file(path, 'a.md'), memoMeta: null }]);
    await act(async () => { await (mode === 'reload' ? lastState?.reload() : lastState?.refresh()); });
    expect(lastState?.rootChildren[0].memoMeta).toEqual(latest);
    expect(lastState?.nodes.get(path)?.memoMeta).toEqual(latest);
    // An explicit empty metadata object is a real clear, not missing data.
    const cleared = { icon: null, colors: [], favorited: false };
    getTreeMock.mockResolvedValueOnce([{ ...file(path, 'a.md'), memoMeta: cleared }]);
    await act(async () => { await lastState?.refresh(); });
    expect(lastState?.rootChildren[0].memoMeta).toEqual(cleared);
  });

  it('keeps deep note metadata across a later directory refresh without metadata', async () => {
    const path = '/root/a/b/note.md';
    getTreeMock.mockResolvedValue([dir('/root/a', 'a')]);
    getDirChildrenMock.mockImplementation(async (directory) => directory === '/root/a'
      ? [dir('/root/a/b', 'b')] : [file(path, 'note.md')]);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    await act(async () => { lastState?.toggle('/root/a'); });
    await act(async () => { lastState?.toggle('/root/a/b'); });
    const latest = { icon: 'flashlight', colors: ['blue' as const], favorited: true };
    act(() => lastState?.updateNoteMetadata(path, latest));
    await act(async () => { await lastState?.refresh('/root/a/b'); });
    expect(flattenVisibleTree(lastState!).find(({ item }) => item.fullPath === path)?.item.memoMeta).toEqual(latest);
  });

  it('drops cached metadata after deletion instead of applying it to a new file at the same path', async () => {
    const path = '/root/a.md';
    getTreeMock.mockResolvedValueOnce([file(path, 'a.md')]);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    act(() => lastState?.updateNoteMetadata(path, { icon: 'flashlight', colors: ['blue'], favorited: true }));
    getTreeMock.mockResolvedValueOnce([]);
    await act(async () => { await lastState?.refresh(); });
    getTreeMock.mockResolvedValueOnce([file(path, 'a.md')]);
    await act(async () => { await lastState?.refresh(); });
    expect(lastState?.rootChildren[0].memoMeta).toBeNull();
  });

  it('updates and clears note metadata several folders deep in the visible tree', async () => {
    getTreeMock.mockResolvedValue([dir('/root/a', 'a')]);
    getDirChildrenMock.mockImplementation(async (path) => path === '/root/a'
      ? [dir('/root/a/b', 'b')]
      : [file('/root/a/b/note.md', 'note.md')]);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    await act(async () => { lastState?.toggle('/root/a'); });
    await act(async () => { lastState?.toggle('/root/a/b'); });
    const latest = { icon: 'flashlight', colors: ['blue' as const], favorited: true };
    act(() => lastState?.updateNoteMetadata('/root/a/b/note.md', latest));
    const visibleNote = () => flattenVisibleTree(lastState!).find(({ item }) => item.fullPath === '/root/a/b/note.md')?.item;
    expect(visibleNote()?.memoMeta).toEqual(latest);
    act(() => lastState?.updateNoteMetadata('/root/a/b/note.md', { icon: null, colors: [], favorited: false }));
    expect(visibleNote()?.memoMeta).toEqual({ icon: null, colors: [], favorited: false });
  });

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

  it('重命名后丢弃旧父目录的迟到刷新结果', async () => {
    const oldPath = '/root/old';
    const newPath = '/root/new';
    getTreeMock.mockResolvedValue([dir(oldPath, 'old')]);
    getDirChildrenMock.mockResolvedValue([file(`${oldPath}/note.md`, 'note.md')]);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    await act(async () => lastState?.toggle(oldPath));
    let finishRefresh!: (items: DocTreeItem[]) => void;
    getTreeMock.mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
    let pending!: Promise<void>;
    act(() => { pending = lastState!.refresh('/root'); });
    act(() => lastState?.rebasePath(oldPath, newPath));
    await act(async () => {
      finishRefresh([dir(oldPath, 'old')]);
      await pending;
    });
    expect(lastState?.expanded.has(newPath)).toBe(true);
    expect(lastState?.rootChildren.map((item) => item.fullPath)).toEqual([newPath]);
    expect(flattenVisibleTree(lastState!).map(({ item }) => item.fullPath)).toContain(`${newPath}/note.md`);
  });

  it.each(['/root', '/root/parent'])('保存期间监听刷新 %s 不展示折叠中间态', async (parent) => {
    const oldPath = `${parent}/old`;
    const nextPath = `${parent}/new`;
    let renamed = false;
    getTreeMock.mockImplementation(async () => parent === '/root'
      ? [dir(renamed ? nextPath : oldPath, renamed ? 'new' : 'old')]
      : [dir(parent, 'parent')]);
    getDirChildrenMock.mockImplementation(async (path) => path === parent
      ? [dir(renamed ? nextPath : oldPath, renamed ? 'new' : 'old')]
      : [file(`${path}/note.md`, 'note.md')]);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    if (parent !== '/root') await act(async () => lastState?.toggle(parent));
    await act(async () => lastState?.toggle(oldPath));
    let complete!: (path: string) => void;
    let completeRead!: (items: DocTreeItem[]) => void;
    const delayedRead = () => new Promise<DocTreeItem[]>((resolve) => { completeRead = resolve; });
    if (parent === '/root') getTreeMock.mockImplementationOnce(delayedRead);
    else getDirChildrenMock.mockImplementationOnce(delayedRead);
    let pendingRead!: Promise<void>;
    act(() => { pendingRead = lastState!.refresh(parent); });
    const rename = vi.spyOn(files, 'renameFolder').mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    try {
      let saving!: Promise<string>;
      act(() => { saving = lastState!.renameFolder(oldPath, 'new', '/root'); });
      renamed = true;
      await act(async () => { completeRead([dir(nextPath, 'new')]); await pendingRead; });
      await act(async () => { await lastState?.refresh(parent); });
      expect(lastState?.expanded.has(oldPath)).toBe(true);
      expect(flattenVisibleTree(lastState!).map(({ item }) => item.fullPath)).toContain(`${oldPath}/note.md`);
      await act(async () => { complete(nextPath); await saving; });
      expect(lastState?.expanded.has(nextPath)).toBe(true);
      expect(flattenVisibleTree(lastState!).map(({ item }) => item.fullPath)).toContain(`${nextPath}/note.md`);
    } finally {
      rename.mockRestore();
    }
  });

  it('文件夹重命名成功后不等待父目录刷新再结束保存态', async () => {
    const oldPath = '/root/old';
    const newPath = '/root/new';
    getTreeMock.mockResolvedValue([dir(oldPath, 'old')]);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));

    let finishRefresh!: (items: DocTreeItem[]) => void;
    getTreeMock.mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
    const rename = vi.spyOn(files, 'renameFolder').mockResolvedValueOnce(newPath);
    try {
      let saving!: Promise<string>;
      act(() => { saving = lastState!.renameFolder(oldPath, 'new', '/root'); });
      let timeout!: ReturnType<typeof setTimeout>;
      let settled = false;
      await act(async () => {
        settled = await Promise.race([
          saving.then(() => true),
          new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 100); }),
        ]);
      });
      clearTimeout(timeout);
      expect(settled).toBe(true);
      expect(lastState?.rootChildren.map((item) => item.fullPath)).toEqual([newPath]);
      expect(getTreeMock).toHaveBeenCalledTimes(2);

      await act(async () => { finishRefresh([dir(newPath, 'new')]); });
    } finally {
      rename.mockRestore();
    }
  });

  it('重命名锁定期间到达的 watcher 刷新会在新路径补执行', async () => {
    const oldPath = '/root/old';
    const newPath = '/root/new';
    let renamed = false;
    getTreeMock.mockImplementation(async () => [dir(renamed ? newPath : oldPath, renamed ? 'new' : 'old')]);
    getDirChildrenMock.mockImplementation(async (path) => [
      file(`${path}/${path === newPath ? 'updated' : 'initial'}.md`, `${path === newPath ? 'updated' : 'initial'}.md`),
    ]);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    await act(async () => lastState?.toggle(oldPath));
    // Let the tree's refresh deduplication window expire before delivering the watcher event.
    await new Promise((resolve) => setTimeout(resolve, 400));

    let completeRename!: (path: string) => void;
    const rename = vi.spyOn(files, 'renameFolder').mockImplementationOnce(() => new Promise((resolve) => {
      completeRename = resolve;
    }));
    try {
      let saving!: Promise<string>;
      act(() => {
        saving = lastState!.renameFolder(oldPath, 'new', '/root');
        lastState!.refreshDirectories([oldPath]);
      });
      renamed = true;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
      expect(getDirChildrenMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        completeRename(newPath);
        await saving;
      });

      await vi.waitFor(() => expect(getDirChildrenMock).toHaveBeenCalledWith(newPath));
      await vi.waitFor(() => expect(lastState?.nodes.get(newPath)?.children?.map((item) => item.name)).toEqual(['updated.md']));
      expect(lastState?.expanded.has(newPath)).toBe(true);
      expect(lastState?.nodes.get(newPath)?.children?.map((item) => item.name)).toEqual(['updated.md']);
    } finally {
      rename.mockRestore();
    }
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

  it('刷新父目录时保留已加载的同级文件夹子树', async () => {
    const parent = '/root/parent';
    const left = `${parent}/left`;
    const right = `${parent}/right`;
    let parentReadCount = 0;
    getTreeMock.mockResolvedValue([dir(parent, 'parent')]);
    getDirChildrenMock.mockImplementation(async (path) => {
      if (path === parent) {
        parentReadCount += 1;
        return [
          dir(left, 'left'),
          dir(right, 'right'),
          ...(parentReadCount > 1 ? [file(`${parent}/moved.md`, 'moved.md')] : []),
        ];
      }
      if (path === left) return [file(`${left}/left-note.md`, 'left-note.md')];
      if (path === right) return [file(`${right}/right-note.md`, 'right-note.md')];
      return [];
    });
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));

    act(() => lastState?.toggle(parent));
    await vi.waitFor(() => expect(lastState?.nodes.get(parent)?.children).toHaveLength(2));
    act(() => lastState?.toggle(left));
    act(() => lastState?.toggle(right));
    await vi.waitFor(() => {
      expect(lastState?.nodes.get(left)?.children).toHaveLength(1);
      expect(lastState?.nodes.get(right)?.children).toHaveLength(1);
    });

    await act(async () => { await lastState?.refresh(parent); });

    expect(lastState?.nodes.get(left)?.children?.map((item) => item.name)).toEqual(['left-note.md']);
    expect(lastState?.nodes.get(right)?.children?.map((item) => item.name)).toEqual(['right-note.md']);
    expect(lastState?.nodes.get(parent)?.children?.map((item) => item.name)).toContain('moved.md');
  });

  it('刷新目录时移除已删除子项及其缓存子树', async () => {
    const parent = '/root/parent';
    const removedFolder = `${parent}/removed`;
    getTreeMock.mockResolvedValue([dir(parent, 'parent')]);
    getDirChildrenMock.mockImplementation(async (path) => {
      if (path === parent) return [dir(removedFolder, 'removed')];
      if (path === removedFolder) return [file(`${removedFolder}/old.md`, 'old.md')];
      return [];
    });
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));

    act(() => lastState?.toggle(parent));
    await vi.waitFor(() => expect(lastState?.nodes.has(removedFolder)).toBe(true));
    act(() => lastState?.toggle(removedFolder));
    await vi.waitFor(() => expect(lastState?.nodes.has(`${removedFolder}/old.md`)).toBe(true));

    getDirChildrenMock.mockImplementation(async () => []);
    await act(async () => { await lastState?.refresh(parent); });

    expect(lastState?.nodes.has(removedFolder)).toBe(false);
    expect(lastState?.nodes.has(`${removedFolder}/old.md`)).toBe(false);
  });

  it('刷新根目录时移除已删除根节点及其缓存子树', async () => {
    const removedFolder = '/root/removed';
    getTreeMock.mockResolvedValue([dir(removedFolder, 'removed')]);
    getDirChildrenMock.mockResolvedValue([file(`${removedFolder}/old.md`, 'old.md')]);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    act(() => lastState?.toggle(removedFolder));
    await vi.waitFor(() => expect(lastState?.nodes.has(`${removedFolder}/old.md`)).toBe(true));

    getTreeMock.mockResolvedValue([]);
    await act(async () => { await lastState?.refresh('/root'); });

    expect(lastState?.nodes.has(removedFolder)).toBe(false);
    expect(lastState?.nodes.has(`${removedFolder}/old.md`)).toBe(false);
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

    expect(flattenVisibleTree(state).map(({ item }) => item.name)).toEqual([
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

    // createdAt: 隐藏组整体置顶, 组内仍按「新→旧」。
    expect(flattenVisibleTree(state).map(({ item }) => item.name)).toEqual([
      '.plugin-output',
      '.trash',
      'notes',
      'archive',
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

    // archive 被置顶后, 访问空间仍把它排在隐藏组之后、按创建时间就地排序;
    // 置顶只负责把它复制到「置顶」分组, 不参与这里的排序。
    expect(flattenVisibleTree(state).map(({ item }) => item.name)).toEqual([
      '.trash',
      'notes',
      'archive',
    ]);
  });
});

describe('flattenLoadedTree', () => {
  it('uses loaded children when root folders are still placeholders', () => {
    const rootFolder = dir('/root/sub', 'sub');
    const loadedFolder = dir('/root/sub', 'sub', [file('/root/sub/note.md', 'note.md')]);

    const flattened = flattenLoadedTree({
      rootChildren: [rootFolder],
      nodes: new Map([[rootFolder.fullPath, loadedFolder]]),
    });

    expect(flattened.map((item) => item.fullPath)).toEqual([
      '/root/sub',
      '/root/sub/note.md',
    ]);
  });
});
