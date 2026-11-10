import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceHeaderBreadcrumb, type WorkspaceHeaderBreadcrumbItem } from './workspace-header-breadcrumb';

// 树本体属于 memo，这里只验证顶栏把「哪一段、根 scope、选中的文件」连对了。
vi.mock('@features/memo/public/shell-api', () => ({
  DocumentBreadcrumbFolderPopover: ({ folderPath, onFileSelect, children }: {
    folderPath: string;
    onFileSelect: (filePath: string) => void;
    children: React.ReactNode;
  }) => (
    <span data-testid={`tree-${folderPath}`} onClick={() => onFileSelect(`${folderPath}/picked.md`)}>
      {children}
    </span>
  ),
  DocumentBreadcrumbCollapsedPopover: ({ items, onFileSelect, children }: {
    items: readonly { label: string; path: string }[];
    onFileSelect: (filePath: string) => void;
    children: React.ReactNode;
  }) => (
    <span data-testid={`collapsed-${items.map((item) => item.label).join(',')}`}
      onClick={() => onFileSelect(`${items[0]!.path}/picked.md`)}>
      {children}
    </span>
  ),
}));
// 折叠规划需要真实布局宽度，jsdom 量不出来 —— 直接给计划，只验证折叠后的交互。
const plan = vi.hoisted(() => ({ hiddenStart: null as number | null }));
vi.mock('@shared/hooks/use-breadcrumb-collapse', () => ({
  breadcrumbSignature: (items: readonly { label: string }[]) => items.map((item) => item.label).join('|'),
  useBreadcrumbCollapse: () => ({ containerRef: { current: null }, itemRefs: { current: [] }, hiddenStart: plan.hiddenStart }),
}));
vi.mock('@/lib/i18n', async (original) => ({
  ...await original<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}));

const items: WorkspaceHeaderBreadcrumbItem[] = [
  { label: 'flowix-main', path: '/repo', type: 'folder' },
  { label: 'docs', path: '/repo/docs', type: 'folder' },
  { label: 'guide', path: '/repo/docs/guide.md', type: 'file' },
];

let root: Root;
let node: HTMLDivElement;
beforeEach(() => { node = document.createElement('div'); document.body.append(node); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); node.remove(); plan.hiddenStart = null; vi.clearAllMocks(); });

const folderTriggers = () => [...node.querySelectorAll<HTMLButtonElement>('[aria-label="collection.openFolder"]')];

it('opens a folder segment as a file tree and hands the picked file back with the root scope', async () => {
  const openFile = vi.fn();
  await act(async () => root.render(<WorkspaceHeaderBreadcrumb items={items} onOpenFile={openFile} />));

  // 根段与中间段都能下钻，当前文件的文件夹（docs）就是第二段。
  expect(folderTriggers().map((button) => button.textContent)).toEqual(['flowix-main', 'docs']);
  expect(node.querySelector('[data-testid="tree-/repo/docs"]')).not.toBeNull();

  const docs = folderTriggers()[1]!;
  await act(async () => docs.click());
  expect(openFile).toHaveBeenCalledExactlyOnceWith('/repo/docs/picked.md', '/repo');
});

it('stays display-only when no column owns the destination', async () => {
  await act(async () => root.render(<WorkspaceHeaderBreadcrumb items={items} />));

  expect(folderTriggers()).toEqual([]);
  expect(node.querySelector('[data-testid^="tree-"]')).toBeNull();
  // 可见层才是文案来源；同名的隐藏测量层（aria-hidden）不计入。
  expect(node.querySelector('nav > span:not([aria-hidden])')!.textContent).toBe('flowix-maindocsguide');
});

it('opens the folded folders from the marker and opens the pick in the same column', async () => {
  const openFile = vi.fn();
  const deepItems: WorkspaceHeaderBreadcrumbItem[] = [
    { label: 'flowix-main', path: '/repo', type: 'folder' },
    { label: 'a', path: '/repo/a', type: 'folder' },
    { label: 'b', path: '/repo/a/b', type: 'folder' },
    { label: 'deep', path: '/repo/a/b/deep.md', type: 'file' },
  ];
  // 折叠 1..hiddenStart 之间的段，这里只剩 'a'。
  plan.hiddenStart = 2;

  await act(async () => root.render(<WorkspaceHeaderBreadcrumb items={deepItems} onOpenFile={openFile} />));

  const marker = node.querySelector<HTMLButtonElement>('[aria-label="breadcrumb.showCollapsedFolders"]')!;
  expect(marker).not.toBeNull();
  // 只剩被折叠的那一段进弹层，根段与当前文件仍在行上。
  expect(node.querySelector('[data-testid="collapsed-a"]')).not.toBeNull();

  await act(async () => node.querySelector<HTMLElement>('[data-testid="collapsed-a"]')!.click());
  expect(openFile).toHaveBeenCalledExactlyOnceWith('/repo/a/picked.md', '/repo');
});

it('keeps the marker inert when no column owns the destination', async () => {
  plan.hiddenStart = 2;
  await act(async () => root.render(
    <WorkspaceHeaderBreadcrumb
      items={[
        { label: 'flowix-main', path: '/repo', type: 'folder' },
        { label: 'a', path: '/repo/a', type: 'folder' },
        { label: 'b', path: '/repo/a/b', type: 'folder' },
        { label: 'deep', path: '/repo/a/b/deep.md', type: 'file' },
      ]}
    />,
  ));

  expect(node.querySelector('[aria-label="breadcrumb.showCollapsedFolders"]')).toBeNull();
  expect(node.querySelector('[data-testid^="collapsed-"]')).toBeNull();
});
