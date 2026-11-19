/**
 * 贯通测试：命令回执 → 广播 → 树自 rebase。
 *
 * 其他用例都从 `publishNotebookPathMove`（广播层）开始，绕过了命令回执这一层；
 * 这里从**真实**的 `acceptPathMutationResult` 进入，走完 `path-moved` 的
 * 订阅链，验证「发起改名的入口不需要任何树相关代码」这条核心承诺。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DocTreeItem } from '@platform/tauri/client';
import { acceptPathMutationResult } from '@platform/tauri/notebook-change-events';
import { perfReset, perfSummary } from '@/lib/perf-probe';
import { noteMetadata } from '../services/note-metadata-service';
import { useNoteStore } from '../store/note-store';
import { useFolderTree } from '@features/memo/components/use-folder-tree';

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

function folder(path: string, children: DocTreeItem[] = []): DocTreeItem {
  return {
    id: `file-${path}`, fullPath: path, name: path.split('/').pop() ?? path, type: 'folder',
    parentId: null, children, sizeBytes: null, modifiedMs: null, createdMs: null, memoCreatedMs: null,
  };
}

const NOTEBOOK_ID = 'nb:root';
let lastState: ReturnType<typeof useFolderTree> | null = null;
let container: HTMLDivElement;
let root: Root;

function TreeProbe({ folderPath }: { folderPath: string }) {
  lastState = useFolderTree(folderPath);
  return null;
}

beforeEach(() => {
  noteMetadata.clear();
  perfReset();
  getTreeMock.mockReset();
  getDirChildrenMock.mockReset();
  useNoteStore.setState({ notebooks: [{ id: NOTEBOOK_ID, name: 'root', path: '/root', createdAt: 0, updatedAt: 0, isDefault: false }] });
  lastState = null;
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  useNoteStore.setState({ notebooks: [] });
});

it('命令回执一到就把子树搬到新路径，入口不再补任何树代码', async () => {
  getTreeMock.mockResolvedValue([folder('/root/old')]);
  getDirChildrenMock.mockResolvedValue([
    { id: 'f-a', fullPath: '/root/old/a.md', name: 'a.md', type: 'document', parentId: null, children: null, sizeBytes: 0, modifiedMs: null, createdMs: null, memoCreatedMs: null },
  ]);
  act(() => root.render(createElement(TreeProbe, { folderPath: '/root' })));
  await vi.waitFor(() => expect(lastState?.loading).toBe(false));
  await act(async () => lastState?.toggle('/root/old'));
  expect(lastState?.nodes.has('/root/old/a.md')).toBe(true);

  // 与 Rust 侧 `rename_folder` 的返回体同形：路径 + 一条 `path-moved`。
  const receipt = {
    path: '/root/new',
    notebookChange: {
      changeId: 'cmd-1', notebookId: NOTEBOOK_ID,
      previousRelativePath: 'old', relativePath: 'new', directory: true,
    },
  };
  let returned = '';
  act(() => { returned = acceptPathMutationResult(receipt); });

  // 回执同步发布，调用方 await 之前树已经就位（标题栏改名不用等刷新）。
  expect(returned).toBe('/root/new');
  expect(lastState?.nodes.has('/root/new/a.md')).toBe(true);
  expect(lastState?.nodes.has('/root/old/a.md')).toBe(false);
  expect(lastState?.expanded.has('/root/new')).toBe(true);
  // 埋点跟着这条链路一起工作：改名在图上的耗时可从 __flowixPerf 读到。
  const rebase = perfSummary().find((row) => row.name === 'tree.rebase');
  expect(rebase?.lastDetail?.nodes).toBeGreaterThan(0);

  // 同一条回执再送一次（命令回执 + 广播可能重复）：去重后不改任何状态。
  const nodesAfterReceipt = lastState?.nodes;
  act(() => { acceptPathMutationResult(receipt); });
  expect(lastState?.nodes).toBe(nodesAfterReceipt);
});
