import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocTreeItem } from '@platform/tauri/client';

vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ t: (key: string) => key, language: 'zh-CN' }),
}));

/** 行里的写操作走 IPC，测试只关心重命名态的图标槽几何，全部挡掉。 */
vi.mock('@platform/tauri/client', () => ({ files: {} }));
vi.mock('@platform/tauri/opener', () => ({ openPath: vi.fn() }));
vi.mock('@features/document/public/file-operations-api', () => ({ localDocumentOperations: {} }));
vi.mock('@features/workspace/public/shell-api', () => ({ renameWorkspaceFile: vi.fn() }));
vi.mock('@features/content/public/content-api', () => ({ ContentIcon: () => null }));

/** 右键菜单默认不挂载内容，这里直接平铺，便于点「重命名」。 */
vi.mock('@shared/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => <div onClick={onClick}>{children}</div>,
}));

import { FolderFileTree } from './folder-file-tree';
import type { FolderTreeController } from './use-folder-tree';

function treeItem(path: string, type: 'folder' | 'document'): DocTreeItem {
  return {
    id: path,
    fullPath: path,
    name: path.slice(path.lastIndexOf('/') + 1),
    type,
    parentId: null,
    children: type === 'folder' ? [] : null,
    sizeBytes: 0,
    modifiedMs: null,
    createdMs: null,
    memoCreatedMs: null,
    memoMeta: { icon: null, colors: [], favorited: false },
  } as unknown as DocTreeItem;
}

function controller(rootChildren: DocTreeItem[]): FolderTreeController {
  return {
    rootChildren,
    expanded: new Set<string>(),
    nodes: new Map(),
    loadingDirectories: new Set<string>(),
    directoryErrors: new Set<string>(),
    loading: false,
    error: null,
    toggle: vi.fn(),
    expandTo: vi.fn(),
    refresh: vi.fn(async () => {}),
    retryDirectory: vi.fn(),
    collapseAll: vi.fn(),
    reload: vi.fn(),
  } as unknown as FolderTreeController;
}

const FolderIcon = ({ className }: { className?: string }) => <span data-testid="folder-icon" className={className} />;
const FileIcon = ({ className }: { path: string; className?: string }) => <span data-testid="file-icon" className={className} />;

describe('FolderFileTree rename icon slot', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    vi.restoreAllMocks();
  });

  async function renameAndReadIconSlot(item: DocTreeItem) {
    await act(async () => root.render(
      <FolderFileTree
        folderPath="/notes"
        folderName="notes"
        folderIcon={FolderIcon}
        fileIcon={FileIcon}
        tree={controller([item])}
        onFileSelect={vi.fn()}
      />,
    ));
    const renameEntry = Array.from(host.querySelectorAll<HTMLElement>('div'))
      .find((el) => el.textContent === 'memo.fileTree.rename');
    expect(renameEntry).toBeTruthy();
    await act(async () => { renameEntry!.click(); });
    const input = host.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();
    return input!.previousElementSibling as HTMLElement;
  }

  /**
   * 普通态文件夹图标住在 18px 的槽里 (16px 图标居中, 左侧留 1px, 同时承载 hover 的展开箭头)。
   * 重命名态没有那个槽时, 图标会左移 1px、输入框左移 2px。
   */
  it('keeps the folder icon slot as wide as the expand slot it replaces', async () => {
    const slot = await renameAndReadIconSlot(treeItem('/notes/项目', 'folder'));
    expect(slot.className).toContain('h-[18px]');
    expect(slot.className).toContain('w-[18px]');
    expect(host.querySelector('[data-testid="folder-icon"]')?.className).toContain('absolute');
  });

  it('leaves the file icon slot alone (files render the icon directly)', async () => {
    const slot = await renameAndReadIconSlot(treeItem('/notes/a.md', 'document'));
    expect(slot.className).not.toContain('h-[18px]');
    expect(slot.className).toContain('h-4');
    expect(slot.className).not.toContain('relative');
  });
});
