import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  getDirChildren: vi.fn(),
  summaries: new Map<string, unknown>(),
  openFolderCollection: vi.fn(),
  openWorkspaceSurface: vi.fn(),
}));

vi.mock('@features/collection/use-collection-summary', () => ({ useCollectionSummary: (path: string) => [calls.summaries.get(path) ?? 'missing'] }));

vi.mock('@platform/tauri/client', () => ({
  files: { getDirChildren: calls.getDirChildren },
}));
vi.mock('@features/workspace/public/main-window-api', () => ({
  openFolderCollectionFromFolder: calls.openFolderCollection,
}));
vi.mock('@features/workspace/public/open-surface-api', () => ({
  openWorkspaceSurface: calls.openWorkspaceSurface,
}));
// 图标只关心「行里有没有」，不关心具体画法。
vi.mock('@features/content/public/content-api', () => ({
  ContentIcon: ({ content }: { content: { kind: string } }) => <span data-icon-kind={content.kind} />,
  HtmlFileIcon: () => null,
  getFileIconKind: () => 'other',
}));

import { PROPERTY_ICON_OPTIONS } from '@features/document/properties/property-icons';
import { CollectionFilesTab } from './collection-files-tab';

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  calls.summaries.clear();
  vi.clearAllMocks();
});

const item = (overrides: Partial<Parameters<typeof CollectionFilesTab>[0]> & Record<string, unknown>) => ({
  id: 'x', name: 'x', fullPath: '/book/x', type: 'folder' as const, resourceKind: 'note' as const, ...overrides,
});

const baseProps: Parameters<typeof CollectionFilesTab>[0] = { rootPath: '/book/客户周报', notebookId: 'book-1', notebookPath: '/book', host: 'main-third' };

async function renderTab(props = baseProps): Promise<HTMLDivElement> {
  const node = document.createElement('div');
  root = createRoot(node);
  await act(async () => root?.render(<CollectionFilesTab {...props} />));
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
  return node;
}

describe('collection files tab', () => {
  it('retains rows and sorting on a collection rename and opens files at the new path', async () => {
    calls.getDirChildren.mockResolvedValue([
      item({ id: 'b', name: 'b.md', fullPath: '/book/客户周报/b.md', type: 'file' }),
      item({ id: 'a', name: 'a.md', fullPath: '/book/客户周报/a.md', type: 'file' }),
    ]);
    const reportPresentation = vi.fn();
    const props = { ...baseProps, collectionId: 'c1', reportPresentation };
    const node = await renderTab(props);
    await act(async () => node.querySelector<HTMLButtonElement>('th button')!.click());
    let finish!: (items: ReturnType<typeof item>[]) => void;
    calls.getDirChildren.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    reportPresentation.mockClear();
    await act(async () => root?.render(<CollectionFilesTab {...props} rootPath="/book/renamed" />));
    expect([...node.querySelectorAll('[data-file-name]')].map((row) => row.textContent)).toEqual(['a', 'b']);
    expect(reportPresentation.mock.calls.every(([update]) => update.state.status === 'ready')).toBe(true);
    await act(async () => node.querySelector<HTMLButtonElement>('[data-file-row]')!.click());
    expect(calls.openWorkspaceSurface.mock.lastCall?.[0].target.path).toBe('/book/renamed/a.md');
    await act(async () => finish([
      item({ id: 'b', name: 'b.md', fullPath: '/book/renamed/b.md', type: 'file' }),
      item({ id: 'a', name: 'a.md', fullPath: '/book/renamed/a.md', type: 'file' }),
    ]));
    expect([...node.querySelectorAll('[data-file-name]')].map((row) => row.textContent)).toEqual(['a', 'b']);
  });

  it('clears shell loading after files arrive and republishes ready when reactivated', async () => {
    let finish!: (items: ReturnType<typeof item>[]) => void;
    calls.getDirChildren.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const reportPresentation = vi.fn();
    const node = await renderTab({ ...baseProps, reportPresentation });
    expect(reportPresentation.mock.lastCall?.[0].state.status).toBe('loading');

    await act(async () => { finish([item({ type: 'file', name: 'ready.md' })]); });
    expect(node.querySelector('[data-file-name]')?.textContent).toBe('ready');
    expect(reportPresentation.mock.lastCall?.[0].state.status).toBe('ready');

    await act(async () => root?.render(<CollectionFilesTab {...baseProps} />));
    reportPresentation.mockClear();
    await act(async () => root?.render(<CollectionFilesTab {...baseProps} reportPresentation={reportPresentation} />));
    expect(reportPresentation).toHaveBeenCalledExactlyOnceWith({ state: { status: 'ready' } });
    expect(calls.getDirChildren).toHaveBeenCalledTimes(1);
  });

  it('does not publish hidden panel completion and waits for the new folder after navigation', async () => {
    let finish!: (items: ReturnType<typeof item>[]) => void;
    calls.getDirChildren.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await renderTab();
    await act(async () => { finish([]); });
    const reportPresentation = vi.fn();
    calls.getDirChildren.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await act(async () => root?.render(<CollectionFilesTab {...baseProps} rootPath="/book/other" reportPresentation={reportPresentation} />));
    expect(reportPresentation.mock.calls.every(([update]) => update.state.status === 'loading')).toBe(true);
    reportPresentation.mockClear();
    await act(async () => root?.render(<CollectionFilesTab {...baseProps} rootPath="/book/other" />));
    await act(async () => { finish([]); });
    expect(reportPresentation).not.toHaveBeenCalled();
  });

  it.each(['empty', 'failed'])('finishes shell loading for a %s directory', async (result) => {
    if (result === 'failed') calls.getDirChildren.mockRejectedValue(new Error('unreadable'));
    else calls.getDirChildren.mockResolvedValue([]);
    const reportPresentation = vi.fn();
    await renderTab({ ...baseProps, reportPresentation });
    expect(reportPresentation.mock.lastCall?.[0].state.status).toBe('ready');
  });

  it('全部列表中的文件夹集合和集合文件共享默认图标，并优先使用集合保存的图标', async () => {
    const custom = PROPERTY_ICON_OPTIONS[0]!;
    calls.summaries.set('/book/日历/.index.yaml', { views: [{ domain: 'notes' }], properties: {} });
    calls.summaries.set('/book/列表.index.yaml', { views: [{ domain: 'work_documents' }], properties: {} });
    calls.summaries.set('/book/自定义/.index.yaml', { views: [{ domain: 'media' }], properties: { icon: { type: 'Text', value: custom.value } } });
    calls.getDirChildren.mockResolvedValue([
      item({ id: 'calendar', name: '日历', fullPath: '/book/日历', type: 'folder', resourceKind: undefined }),
      item({ id: 'list', name: '列表.index.yaml', fullPath: '/book/列表.index.yaml', type: 'file', resourceKind: undefined }),
      item({ id: 'custom', name: '自定义', fullPath: '/book/自定义', type: 'folder', resourceKind: undefined }),
    ]);
    const node = await renderTab();
    const rows = [...node.querySelectorAll('button[data-file-row]')];
    const row = (title: string) => rows.find((item) => item.textContent?.includes(title))!;
    expect(row('日历').querySelector('[data-icon-kind]')?.getAttribute('data-icon-kind')).toBe('multidimensional-table');
    expect(row('列表').querySelector('[data-icon-kind]')?.getAttribute('data-icon-kind')).toBe('media-library');
    expect(row('自定义').querySelector('img')?.getAttribute('src')).toBe(custom.src);
  });

  it('只渲染根目录的一层：文件夹与文件平铺，没有折叠箭头', async () => {
    calls.getDirChildren.mockResolvedValue([
      item({ id: 'f1', name: '子文件夹', fullPath: '/book/客户周报/子文件夹', type: 'folder', resourceKind: undefined }),
      item({ id: 'n1', name: '周报.md', fullPath: '/book/客户周报/周报.md', type: 'file' }),
    ]);

    const node = await renderTab();

    expect(calls.getDirChildren).toHaveBeenCalledTimes(1);
    expect(calls.getDirChildren).toHaveBeenCalledWith('/book/客户周报');
    const rows = Array.from(node.querySelectorAll<HTMLButtonElement>('button[data-file-row]')).map((button) => button.textContent?.trim());
    expect(rows).toEqual(['子文件夹', '周报']);
    // 折叠/展开图标已删除：行内只剩文件类型图标 + 名称。
    expect(node.querySelector('svg.lucide-chevron-right')).toBeNull();
  });

  it('点击文件夹走与侧边栏同一条逻辑：openFolderCollectionFromFolder + 当前宿主', async () => {
    calls.getDirChildren.mockResolvedValue([
      item({ id: 'f1', name: '子文件夹', fullPath: '/book/客户周报/子文件夹', type: 'folder', resourceKind: undefined }),
    ]);

    const node = await renderTab({ ...baseProps, host: 'browser-column' });
    await act(async () => node.querySelectorAll<HTMLButtonElement>('button[data-file-row]')[0]?.click());

    // 侧边栏用的是同一个函数（它自己固定 main-third），差别只有宿主。
    expect(calls.openFolderCollection).toHaveBeenCalledWith(
      'book-1', '/book/客户周报/子文件夹', 'browser-column',
    );
  });

  it('点击笔记打开文件，不落进集合视图', async () => {
    calls.getDirChildren.mockResolvedValue([
      item({ id: 'n1', name: '周报.md', fullPath: '/book/客户周报/周报.md', type: 'file' }),
    ]);

    const node = await renderTab({ ...baseProps, host: 'browser-column' });
    await act(async () => node.querySelectorAll<HTMLButtonElement>('button[data-file-row]')[0]?.click());

    expect(calls.openFolderCollection).not.toHaveBeenCalled();
    expect(calls.openWorkspaceSurface).toHaveBeenCalledWith({
      host: 'browser-column',
      target: { kind: 'external', path: '/book/客户周报/周报.md', scopePath: '/book', transitionId: null },
    });
  });

  it('表头循环排序，文件夹始终在前且两组独立排序', async () => {
    calls.getDirChildren.mockResolvedValue([
      item({ id: 'b', name: 'b.md', type: 'document', sizeBytes: 20, modifiedMs: 100 }),
      item({ id: 'z', name: 'z', type: 'folder', sizeBytes: null, modifiedMs: 300 }),
      item({ id: 'a', name: 'a.md', type: 'document', sizeBytes: 100, modifiedMs: 200 }),
      item({ id: 'c', name: 'c', type: 'folder', sizeBytes: null, modifiedMs: 400 }),
      item({ id: 'e', name: 'empty.md', type: 'document', sizeBytes: 0, modifiedMs: null }),
    ]);
    const node = await renderTab();
    const rows = () => Array.from(node.querySelectorAll<HTMLButtonElement>('button[data-file-row]')).map((row) => row.querySelector('[data-file-name]')?.textContent?.trim());
    const headers = node.querySelectorAll('[role="columnheader"]');
    const click = async (index: number) => { await act(async () => headers[index].querySelector('button')!.click()); };
    expect(rows()).toEqual(['z', 'c', 'b', 'a', 'empty']);
    await click(0);
    expect(rows()).toEqual(['c', 'z', 'a', 'b', 'empty']);
    expect(headers[0].getAttribute('aria-sort')).toBe('ascending');
    await click(0);
    expect(rows()).toEqual(['z', 'c', 'empty', 'b', 'a']);
    await click(0);
    expect(rows()).toEqual(['z', 'c', 'b', 'a', 'empty']);
    await click(1);
    expect(rows()).toEqual(['z', 'c', 'b', 'a', 'empty']);
    await click(1);
    expect(rows()).toEqual(['c', 'z', 'a', 'b', 'empty']);
    await click(2);
    expect(rows()).toEqual(['z', 'c', 'empty', 'b', 'a']);
    expect(headers[1].getAttribute('aria-sort')).toBe('none');
    await click(2);
    expect(rows()).toEqual(['z', 'c', 'a', 'b', 'empty']);
  });

  it('目录为空时给出空态文案', async () => {
    calls.getDirChildren.mockResolvedValue([]);

    const node = await renderTab();

    expect(node.querySelectorAll<HTMLButtonElement>('button[data-file-row]')).toHaveLength(0);
    expect(node.textContent).not.toBe('');
  });
});
