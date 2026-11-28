import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { files, type DocTreeItem } from '@platform/tauri/client';
import { publishNotebookPathMove } from '@platform/tauri/notebook-change-events';
import { noteMetadata } from '../services/note-metadata-service';
import { useNoteStore, type Notebook } from '../store/note-store';
import {
  flattenVisibleTree,
  useFolderTree,
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

/** Trees resolve their notebook root from the store; most cases mount under this one. */
const ROOT_NOTEBOOK_ID = 'nb-root';
const rootNotebook: Notebook = {
  id: ROOT_NOTEBOOK_ID,
  name: 'root',
  path: '/root',
  createdAt: 0,
  updatedAt: 0,
  isDefault: false,
};

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
    useNoteStore.setState({ notebooks: [rootNotebook] });
    lastState = null;
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useNoteStore.setState({ notebooks: [] });
    vi.useRealTimers();
  });

  function mount(folderPath: string) {
    act(() => {
      root?.render(createElement(TreeProbe, { folderPath }));
    });
  }

/**
 * Mirrors what the real client does (`acceptPathMutationResult`): the command
 * receipt publishes `path-moved` before the promise resolves. Mocking
 * `files.renameFolder` without this would test a contract the app never has —
 * the tree deliberately does not rebase from the caller side any more.
 */
let moveSequence = 0;

/**
 * Advance the clock past the tree's 350ms refresh dedup window without sleeping.
 * Only `Date.now` is shifted, so timers, `waitFor` and promise scheduling keep
 * working normally; call `mockRestore()` when the test is done.
 */
function expireRefreshWindow(offsetMs = 5_000) {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  offset = offsetMs;
  return spy;
}
  function broadcastMove(previousPath: string, nextPath: string) {
    const relative = (path: string) => path.replace(/^\/root\/?/, '');
    publishNotebookPathMove({
      changeId: `move-${moveSequence++}`,
      notebookId: ROOT_NOTEBOOK_ID,
      previousRelativePath: relative(previousPath),
      relativePath: relative(nextPath),
      directory: true,
    });
  }

  it('loads the newly selected notebook tree and ignores an older notebook response', async () => {
    let finishOld!: (items: DocTreeItem[]) => void;
    getTreeMock.mockImplementation(path => path === '/a'
      ? new Promise(resolve => { finishOld = resolve; })
      : Promise.resolve([file('/b/new.md', 'new.md')]));
    mount('/a');
    await vi.waitFor(() => expect(finishOld).toBeTypeOf('function'));
    mount('/b');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    expect(lastState?.nodes.has('/b/new.md')).toBe(true);
    await act(async () => { finishOld([file('/a/old.md', 'old.md')]); });
    expect(lastState?.nodes.has('/a/old.md')).toBe(false);
    expect(lastState?.nodes.has('/b/new.md')).toBe(true);
    expect(getTreeMock.mock.calls.map(call => call[0])).toEqual(['/a', '/b']);
  });

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
      noteMetadata.update('/root/a.md', { ...latest, icon: 'dog-face' });
      noteMetadata.update('/root/a.md', latest);
    });
    await act(async () => release([oldNote]));
    expect(lastState?.rootChildren[0].memoMeta).toEqual(latest);
    expect(lastState?.nodes.get('/root/a.md')?.memoMeta).toEqual(latest);

    // Protection is scoped to earlier reads, not a permanent metadata override.
    getTreeMock.mockResolvedValueOnce([oldNote]);
    await act(async () => { await lastState?.refresh(); });
    expect(lastState?.rootChildren[0].memoMeta?.icon).toBeNull();
  });

  it('preserves metadata observed during a delayed child read, including an explicit clear', async () => {
    getTreeMock.mockResolvedValue([dir('/root/sub', 'sub')]);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    let release!: (items: DocTreeItem[]) => void;
    getDirChildrenMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    act(() => lastState?.toggle('/root/sub'));
    const latest = { icon: 'flashlight', colors: [], favorited: false };
    act(() => noteMetadata.update('/root/sub/a.md', latest));
    await act(async () => release([file('/root/sub/a.md', 'a.md')]));
    expect(lastState?.nodes.get('/root/sub/a.md')?.memoMeta).toEqual(latest);
    expect(lastState?.nodes.get('/root/sub')?.children?.[0].memoMeta).toEqual(latest);

    // An observation that lands mid-read wins for that read; the stale listing
    // it was racing must not put the old icon back.
    let releaseClear!: (items: DocTreeItem[]) => void;
    getDirChildrenMock.mockImplementationOnce(() => new Promise((resolve) => { releaseClear = resolve; }));
    act(() => { void lastState?.refresh('/root/sub'); });
    const cleared = { icon: null, colors: [], favorited: false };
    act(() => noteMetadata.update('/root/sub/a.md', cleared));
    await act(async () => releaseClear([{ ...file('/root/sub/a.md', 'a.md'), memoMeta: latest }]));
    expect(lastState?.nodes.get('/root/sub/a.md')?.memoMeta).toEqual(cleared);
    expect(lastState?.nodes.get('/root/sub')?.children?.[0].memoMeta).toEqual(cleared);
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
    act(() => noteMetadata.update(path, latest));
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
    act(() => noteMetadata.update(path, latest));
    await act(async () => { await lastState?.refresh('/root/a/b'); });
    expect(flattenVisibleTree(lastState!).find(({ item }) => item.fullPath === path)?.item.memoMeta).toEqual(latest);
  });

  it('drops cached metadata after deletion instead of applying it to a new file at the same path', async () => {
    const path = '/root/a.md';
    getTreeMock.mockResolvedValueOnce([file(path, 'a.md')]);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    act(() => noteMetadata.update(path, { icon: 'flashlight', colors: ['blue'], favorited: true }));
    getTreeMock.mockResolvedValueOnce([]);
    await act(async () => { await lastState?.refresh(); });
    getTreeMock.mockResolvedValueOnce([file(path, 'a.md')]);
    await act(async () => { await lastState?.refresh(); });
    expect(lastState?.rootChildren[0].memoMeta).toBeNull();
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
      await act(async () => { broadcastMove(oldPath, nextPath); complete(nextPath); await saving; });
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
    const rename = vi.spyOn(files, 'renameFolder').mockImplementationOnce(async () => {
      broadcastMove(oldPath, newPath);
      return newPath;
    });
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

  it('重命名后父目录只做静默补读, 父行不出现加载态', async () => {
    const parent = '/root/parent';
    const oldPath = `${parent}/old`;
    const newPath = `${parent}/new`;
    let renamed = false;
    getTreeMock.mockResolvedValue([dir(parent, 'parent')]);
    getDirChildrenMock.mockImplementation(async (path) => path === parent
      ? [dir(renamed ? newPath : oldPath, renamed ? 'new' : 'old')]
      : [file(`${path}/note.md`, 'note.md')]);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    await act(async () => lastState?.toggle(parent));
    await act(async () => lastState?.toggle(oldPath));
    // Expire the refresh dedup window so the follow-up read is really issued,
    // without making the suite wait for it.
    const clock = expireRefreshWindow();

    const rename = vi.spyOn(files, 'renameFolder').mockImplementationOnce(async () => {
      renamed = true;
      broadcastMove(oldPath, newPath);
      return newPath;
    });
    try {
      await act(async () => { await lastState!.renameFolder(oldPath, 'new', '/root'); });
      // The rebase already published the new path; the follow-up read must not
      // put the parent row into a loading state.
      expect(lastState?.loadingDirectories.size).toBe(0);
      await vi.waitFor(() => expect(getDirChildrenMock).toHaveBeenCalledWith(parent));
      expect(lastState?.loadingDirectories.size).toBe(0);
      expect(flattenVisibleTree(lastState!).map(({ item }) => item.fullPath))
        .toEqual([parent, newPath, `${newPath}/note.md`]);
    } finally {
      clock.mockRestore();
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
    // Expire the dedup window so the later watcher refresh is not swallowed by it.
    const clock = expireRefreshWindow();

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
        broadcastMove(oldPath, newPath);
        completeRename(newPath);
        await saving;
      });

      await vi.waitFor(() => expect(getDirChildrenMock).toHaveBeenCalledWith(newPath));
      await vi.waitFor(() => expect(lastState?.nodes.get(newPath)?.children?.map((item) => item.name)).toEqual(['updated.md']));
      expect(lastState?.expanded.has(newPath)).toBe(true);
      expect(lastState?.nodes.get(newPath)?.children?.map((item) => item.name)).toEqual(['updated.md']);
    } finally {
      clock.mockRestore();
      rename.mockRestore();
    }
  });

  /**
   * 标题栏改名会把 surface 的根换到新路径。改名不应该让树退回骨架，也不应该
   * 把用户展开的子树折叠掉。判据是**收到过这次改名广播**，不是「父目录相同」：
   * 后者会把切换到兄弟目录也当成改名。
   */
  describe('根目录改名换根', () => {
    it('不进入加载态, 已展开的子树跟着搬到新根', async () => {
      getTreeMock.mockImplementation(async (path) => (path.startsWith('/root/old')
        ? [dir('/root/old/sub', 'sub')]
        : [dir('/root/new/sub', 'sub')]));
      getDirChildrenMock.mockResolvedValue([file('/root/old/sub/a.md', 'a.md')]);
      mount('/root/old');
      await vi.waitFor(() => expect(lastState?.loading).toBe(false));
      await act(async () => lastState?.toggle('/root/old/sub'));
      expect(lastState?.nodes.has('/root/old/sub/a.md')).toBe(true);

      let finish!: (items: DocTreeItem[]) => void;
      getTreeMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      act(() => broadcastMove('/root/old', '/root/new'));
      mount('/root/new');

      expect(lastState?.loading).toBe(false);
      expect(lastState?.nodes.has('/root/new/sub/a.md')).toBe(true);
      expect(lastState?.expanded.has('/root/new/sub')).toBe(true);

      await act(async () => { finish([dir('/root/new/sub', 'sub')]); });
      expect(lastState?.loading).toBe(false);
      expect(lastState?.expanded.has('/root/new/sub')).toBe(true);
      expect(lastState?.nodes.has('/root/new/sub/a.md')).toBe(true);
      expect(lastState?.rootChildren.map((item) => item.fullPath)).toEqual(['/root/new/sub']);
    });

    it('根已知在改名时, watcher 刷新不再去读旧根', async () => {
      getTreeMock.mockResolvedValue([dir('/root/old/sub', 'sub')]);
      getDirChildrenMock.mockResolvedValue([file('/root/old/sub/a.md', 'a.md')]);
      mount('/root/old');
      await vi.waitFor(() => expect(lastState?.loading).toBe(false));
      await act(async () => lastState?.toggle('/root/old/sub'));

      act(() => broadcastMove('/root/old', '/root/new'));
      const readsBefore = getTreeMock.mock.calls.length;
      await act(async () => { await lastState?.refreshDirectoriesNow(['/root/old']); });

      expect(getTreeMock.mock.calls.length).toBe(readsBefore);
      expect(lastState?.error).toBeNull();
      expect(lastState?.nodes.has('/root/old/sub/a.md')).toBe(true);
    });

    it('早于广播发出的旧根回读迟到返回 null 时不清空树', async () => {
      getTreeMock.mockResolvedValue([dir('/root/old/sub', 'sub')]);
      getDirChildrenMock.mockResolvedValue([file('/root/old/sub/a.md', 'a.md')]);
      mount('/root/old');
      await vi.waitFor(() => expect(lastState?.loading).toBe(false));
      await act(async () => lastState?.toggle('/root/old/sub'));

      // watcher 已经发起了旧根的回读, 广播随后才到 —— 这个顺序在真实改名里很常见。
      let finishRoot!: (items: DocTreeItem[] | null) => void;
      getTreeMock.mockImplementationOnce(() => new Promise((resolve) => { finishRoot = resolve; }));
      const refreshing = lastState!.refreshDirectoriesNow(['/root/old']);
      act(() => broadcastMove('/root/old', '/root/new'));
      await act(async () => { finishRoot(null); await refreshing; });

      expect(lastState?.error).toBeNull();
      expect(lastState?.rootChildren.map((item) => item.fullPath)).toEqual(['/root/old/sub']);
      expect(lastState?.nodes.has('/root/old/sub/a.md')).toBe(true);
      expect(lastState?.expanded.has('/root/old/sub')).toBe(true);
    });

    it('没有 surface 换根时, 旧根被搁置到过期后 watcher 恢复刷新', async () => {
      getTreeMock.mockResolvedValue([dir('/root/old/sub', 'sub')]);
      mount('/root/old');
      await vi.waitFor(() => expect(lastState?.loading).toBe(false));

      act(() => broadcastMove('/root/old', '/root/new'));
      const readsBefore = getTreeMock.mock.calls.length;
      await act(async () => { await lastState?.refreshDirectoriesNow(['/root/old']); });
      // 广播之后这一棵仍未换根: 旧路径不该再被读。
      expect(getTreeMock.mock.calls.length).toBe(readsBefore);

      // 没有任何 surface 认领这次移动。搁置必须自己过期, 否则这棵树会永远
      // 停止响应 watcher —— 比「停在旧路径」更糟: 新建的文件再也不会出现。
      const clock = expireRefreshWindow(6_000);
      try {
        await act(async () => { await lastState?.refreshDirectoriesNow(['/root/old']); });
        expect(getTreeMock.mock.calls.length).toBe(readsBefore + 1);
        expect(lastState?.rootChildren.map((item) => item.fullPath)).toEqual(['/root/old/sub']);
      } finally {
        clock.mockRestore();
      }
    });

    it('切到兄弟目录不是改名: 回到加载态, 不复用对方的内容', async () => {
      getTreeMock.mockImplementation(async (path) => (path.startsWith('/root/a')
        ? [file('/root/a/only-in-a.md', 'only-in-a.md')]
        : [file('/root/b/only-in-b.md', 'only-in-b.md')]));
      mount('/root/a');
      await vi.waitFor(() => expect(lastState?.loading).toBe(false));

      let finish!: (items: DocTreeItem[]) => void;
      getTreeMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      // 两个根同父 (/root) 但毫无关系: 没有改名广播就不能当成改名。
      mount('/root/b');

      expect(lastState?.loading).toBe(true);
      expect(lastState?.nodes.has('/root/b/only-in-a.md')).toBe(false);
      await act(async () => { finish([file('/root/b/only-in-b.md', 'only-in-b.md')]); });
      expect(lastState?.rootChildren.map((item) => item.fullPath)).toEqual(['/root/b/only-in-b.md']);
      expect(lastState?.nodes.has('/root/a/only-in-a.md')).toBe(false);
    });

    it('切到无关目录仍然回到加载态并清空展开', async () => {
      getTreeMock.mockResolvedValue([file('/root/a.md', 'a.md')]);
      mount('/root');
      await vi.waitFor(() => expect(lastState?.loading).toBe(false));

      let finish!: (items: DocTreeItem[]) => void;
      getTreeMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      mount('/other');

      expect(lastState?.loading).toBe(true);
      await act(async () => { finish([file('/other/b.md', 'b.md')]); });
      expect(lastState?.loading).toBe(false);
      expect(lastState?.rootChildren.map((item) => item.fullPath)).toEqual(['/other/b.md']);
      expect(lastState?.expanded.size).toBe(0);
    });
  });

  it('根目录不可读时置 error 且列表为空', async () => {
    getTreeMock.mockResolvedValue(null);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.error).toBe('unreadable'));
    expect(lastState?.rootChildren).toHaveLength(0);
  });

  it('手动刷新先更新父目录，并跳过已删除的子目录', async () => {
    getTreeMock.mockResolvedValue([dir('/root/sub', 'sub')]);
    getDirChildrenMock.mockResolvedValue([file('/root/sub/old.md', 'old.md')]);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    await act(async () => lastState?.toggle('/root/sub'));
    getDirChildrenMock.mockClear();
    getTreeMock.mockResolvedValue([]);

    await act(async () => { await lastState?.refreshTree(); });
    expect(getDirChildrenMock).not.toHaveBeenCalled();
    expect(lastState?.nodes.has('/root/sub')).toBe(false);
    expect(lastState?.nodes.has('/root/sub/old.md')).toBe(false);
  });

  it('手动刷新根目录失败时显示错误并保留旧列表', async () => {
    getTreeMock.mockResolvedValueOnce([file('/root/a.md', 'a.md')]);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    getTreeMock.mockRejectedValueOnce(new Error('read failed'));

    await act(async () => { await lastState?.refreshTree(); });
    expect(lastState?.error).toBe('unreadable');
    expect(lastState?.rootChildren.map((item) => item.name)).toEqual(['a.md']);
  });

  it('force 补读绕过去重窗口, 且不进入加载态', async () => {
    getTreeMock.mockResolvedValue([dir('/root/sub', 'sub')]);
    getDirChildrenMock.mockResolvedValue([file('/root/sub/a.md', 'a.md')]);
    mount('/root');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    await act(async () => lastState?.toggle('/root/sub'));
    await vi.waitFor(() => expect(lastState?.nodes.has('/root/sub/a.md')).toBe(true));
    const reads = getDirChildrenMock.mock.calls.length;

    // 刚读过: 去重窗口内不再是「疑似过期」, 不该重复读。
    await act(async () => { await lastState?.refreshDirectoriesNow(['/root/sub']); });
    expect(getDirChildrenMock.mock.calls.length).toBe(reads);

    // 改名后子读被 rebase 丢弃的那一行是「确定过期」: 必须真的重读,
    // 但仍走静默, 不能给这一行加加载态。
    await act(async () => { await lastState?.refreshDirectoriesNow(['/root/sub'], { force: true }); });
    expect(getDirChildrenMock.mock.calls.length).toBe(reads + 1);
    expect(lastState?.loadingDirectories.size).toBe(0);
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

/**
 * 树必须靠广播自我 rebase，而不是靠发起改名的那个入口顺手改一遍。
 * 这组用例不发任何命令、只发 `path-moved`，与「外部工具 / 另一个窗口 /
 * 标题栏」改名的路径完全一致。
 */
describe('useFolderTree path-moved 驱动', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  function notebook(path: string): Notebook {
    return {
      id: `nb:${path}`,
      name: path.split('/').pop() ?? path,
      path,
      createdAt: 0,
      updatedAt: 0,
      isDefault: false,
    };
  }

  function move(changeId: string, previous: string, next: string) {
    publishNotebookPathMove({
      changeId,
      notebookId: 'nb:/nb',
      previousRelativePath: previous,
      relativePath: next,
      directory: true,
    });
  }

  beforeEach(() => {
    noteMetadata.clear();
    getTreeMock.mockReset();
    getDirChildrenMock.mockReset();
    useNoteStore.setState({ notebooks: [notebook('/nb')] });
    lastState = null;
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useNoteStore.setState({ notebooks: [] });
  });

  function mount(folderPath: string) {
    act(() => {
      root?.render(createElement(TreeProbe, { folderPath }));
    });
  }

  async function mountExpandedRoot() {
    getTreeMock.mockResolvedValue([dir('/nb/sub', 'sub')]);
    getDirChildrenMock.mockResolvedValue([file('/nb/sub/old.md', 'old.md')]);
    mount('/nb');
    await vi.waitFor(() => expect(lastState?.loading).toBe(false));
    await act(async () => lastState?.toggle('/nb/sub'));
    expect(lastState?.nodes.has('/nb/sub/old.md')).toBe(true);
  }

  it('不经过改名入口，只靠事件就能把已加载子树搬到新路径', async () => {
    await mountExpandedRoot();

    act(() => move('move-1', 'sub', 'renamed'));

    expect(lastState?.nodes.has('/nb/renamed/old.md')).toBe(true);
    expect(lastState?.nodes.has('/nb/sub/old.md')).toBe(false);
    expect(lastState?.expanded.has('/nb/renamed')).toBe(true);
  });

  it('同一次移动重复送达时不动节点表', async () => {
    await mountExpandedRoot();

    act(() => move('move-1', 'sub', 'renamed'));
    const afterFirstMove = lastState?.nodes;
    // 新 changeId 绕过 changeId 去重，直接考察 rebase 自身的幂等性。
    act(() => move('move-2', 'sub', 'renamed'));

    expect(lastState?.nodes).toBe(afterFirstMove);
  });

  it('落在树范围之外的移动不改变这棵树', async () => {
    await mountExpandedRoot();

    act(() => move('move-1', 'sibling', 'renamed-sibling'));

    expect(lastState?.nodes.has('/nb/sub/old.md')).toBe(true);
    expect(lastState?.nodes.has('/nb/renamed-sibling/old.md')).toBe(false);
  });

  it('别的笔记本里同名的相对路径不影响这棵树', async () => {
    await mountExpandedRoot();

    // 另一个笔记本里也有一条 `sub` → `renamed`：相对路径相同，绝对路径不同。
    act(() => publishNotebookPathMove({
      changeId: 'move-other-notebook',
      notebookId: 'nb:/other',
      previousRelativePath: 'sub',
      relativePath: 'renamed',
      directory: true,
    }));

    expect(lastState?.nodes.has('/nb/sub/old.md')).toBe(true);
    expect(lastState?.nodes.has('/nb/renamed/old.md')).toBe(false);
  });
});
