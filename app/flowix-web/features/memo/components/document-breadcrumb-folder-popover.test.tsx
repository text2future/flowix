import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ResourceFolderIcon } from '@features/surface/public/resource-icon-api';
import {
  DocumentBreadcrumbCollapsedPopover,
  DocumentBreadcrumbFolderPopover,
} from './document-breadcrumb-folder-popover';

// 弹层定位/收起交给 Popover 组件，这里只验证「树上挂的是哪个图标、标题行怎么组合、
// 选中后怎么回传」。树头按真实组件的结构渲染：返回按钮 + 文件夹名。
vi.mock('@shared/ui/popover', () => ({
  Popover: ({ children, onOpenChange }: { children: React.ReactNode; onOpenChange?: (open: boolean) => void }) => (
    <div>
      <button data-testid="open" onClick={() => onOpenChange?.(true)} />
      {children}
    </div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('./use-folder-tree', () => ({ useFolderTree: () => ({}) }));
vi.mock('./folder-file-tree', () => ({
  FolderFileTree: (props: {
    folderPath: string;
    folderName: string;
    folderIcon?: unknown;
    showRowMenu?: boolean;
    headerLeading?: React.ReactNode;
    onFileSelect?: (path: string) => void;
  }) => (
    <div
      data-testid="tree"
      data-folder-path={props.folderPath}
      data-has-sidebar-folder-icon={props.folderIcon === ResourceFolderIcon ? 'yes' : 'no'}
      data-row-menu={props.showRowMenu === false ? 'off' : 'on'}
    >
      <div data-testid="tree-header">
        {props.headerLeading}
        <span data-testid="tree-title">{props.folderName}</span>
      </div>
      <button
        type="button"
        data-testid="tree-file"
        onClick={() => props.onFileSelect?.(`${props.folderPath}/picked.md`)}
      />
    </div>
  ),
}));

let root: Root;
let node: HTMLDivElement;
beforeEach(() => { node = document.createElement('div'); document.body.append(node); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.clearAllMocks(); });

it('renders folders with the access-space sidebar icon and hands the pick back once', async () => {
  const onFileSelect = vi.fn();
  await act(async () => root.render(
    <DocumentBreadcrumbFolderPopover folderPath="/repo/docs" folderName="docs" onFileSelect={onFileSelect}>
      <button type="button">docs</button>
    </DocumentBreadcrumbFolderPopover>,
  ));

  // 未展开不挂树，避免无谓的目录 IPC。
  expect(node.querySelector('[data-testid="tree"]')).toBeNull();

  await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="open"]')!.click());
  const tree = node.querySelector<HTMLElement>('[data-testid="tree"]')!;
  expect(tree.dataset.hasSidebarFolderIcon).toBe('yes');
  // 下拉窗里只要切换目标，行尾「…」菜单不出现。
  expect(tree.dataset.rowMenu).toBe('off');
  // 面包屑段自己开出来的树没有「返回」，标题行只放文件夹名。
  expect(node.querySelector('[data-testid="tree-header"] button')).toBeNull();

  await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="tree-file"]')!.click());
  expect(onFileSelect).toHaveBeenCalledExactlyOnceWith('/repo/docs/picked.md');
});

it('lists the folded folders behind the marker and walks into the chosen one', async () => {
  const onFileSelect = vi.fn();
  await act(async () => root.render(
    <DocumentBreadcrumbCollapsedPopover
      items={[{ label: 'a', path: '/repo/a' }, { label: 'b', path: '/repo/a/b' }]}
      onFileSelect={onFileSelect}
    >
      <button type="button">···</button>
    </DocumentBreadcrumbCollapsedPopover>,
  ));

  // 收起/未选层时不挂树，避免无谓的目录 IPC。
  expect(node.querySelector('[data-testid="tree"]')).toBeNull();

  await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="open"]')!.click());
  // 第一步只列被折叠的文件夹，不直接摊开整棵树。
  expect(node.querySelector('[title="/repo/a"]')!.textContent).toContain('a');
  expect(node.querySelector('[title="/repo/a/b"]')!.textContent).toContain('b');
  expect(node.querySelector('[data-testid="tree"]')).toBeNull();

  await act(async () => node.querySelector<HTMLButtonElement>('[title="/repo/a/b"]')!.click());
  // 第二步换成这一层的树。返回按钮并进树自己的标题行，文件夹名只出现一次。
  expect(node.querySelector<HTMLElement>('[data-testid="tree"]')!.dataset.folderPath).toBe('/repo/a/b');
  expect(node.querySelectorAll('[data-testid="tree-title"]')).toHaveLength(1);
  expect(node.querySelector('[data-testid="tree-title"]')!.textContent).toBe('b');

  // 点标题行里的返回，退回文件夹列表（树卸载）。
  await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="tree-header"] button')!.click());
  expect(node.querySelector('[data-testid="tree"]')).toBeNull();
  expect(node.querySelector('[title="/repo/a"]')).not.toBeNull();

  // 再进一层并选文件，仍然只回传一次。
  await act(async () => node.querySelector<HTMLButtonElement>('[title="/repo/a/b"]')!.click());
  await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="tree-file"]')!.click());
  expect(onFileSelect).toHaveBeenCalledExactlyOnceWith('/repo/a/b/picked.md');
});
