import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  getDirChildren: vi.fn(),
  summaries: new Map<string, unknown>(),
  openFolderCollection: vi.fn(),
  openWorkspaceSurface: vi.fn(),
  watchRoot: vi.fn(async () => 'lease-1'),
  unwatchRoot: vi.fn(async () => {}),
  listTables: vi.fn(async () => []),
  listeners: new Map<string, Set<(event: unknown) => void>>(),
}));
vi.mock('@platform/tauri/event-bus', async (importOriginal) => ({
  ...await importOriginal<typeof import('@platform/tauri/event-bus')>(),
  subscribe: (name: string, handler: (event: unknown) => void) => {
    const listeners = calls.listeners.get(name) ?? new Set();
    listeners.add(handler);
    calls.listeners.set(name, listeners);
    return () => { listeners.delete(handler); };
  },
}));
/** 文件夹行的图标来自 `folder_index`；用例按绝对路径登记自定义图标。 */
const folderAppearance = vi.hoisted(() => ({ icons: new Map<string, string>() }));
vi.mock('@features/collection/folder-appearance', () => ({
  useFolderAppearance: (_notebookPath: string | null, folderPath: string | null) => {
    const value = folderPath ? folderAppearance.icons.get(folderPath) : undefined;
    return value ? { icon: { type: 'Text', value } } : undefined;
  },
}));

vi.mock('@features/collection/use-collection-summary', () => ({ useCollectionSummary: (path: string) => [calls.summaries.get(path) ?? 'missing'] }));

vi.mock('@platform/tauri/client', () => ({
  files: {
    getDirChildren: calls.getDirChildren,
    // 行上的「这是哪种集合」标识要扫三张清单；本文件只关心文件夹行，给空清单。
    listTableDocuments: calls.listTables,
    listMediaLibraries: async () => [],
    getNotebookViewPreferences: async () => ({ defaultCreateFolder: null }),
    watchRoot: calls.watchRoot,
    unwatchRoot: calls.unwatchRoot,
  },
  collections: { list: async () => [] },
}));
vi.mock('@features/workspace/public/main-window-api', () => ({
  openFolderCollectionFromFolder: calls.openFolderCollection,
}));
vi.mock('@features/workspace/public/session-opening-api', () => ({
  openWorkspaceSurface: calls.openWorkspaceSurface,
}));
// 图标只关心「行里有没有」，不关心具体画法。
vi.mock('@features/content/public/content-api', () => ({
  ContentIcon: ({ content }: { content: { kind: string } }) => <span data-icon-kind={content.kind} />,
  HtmlFileIcon: () => null,
  getFileIconKind: () => 'other',
}));

import { PROPERTY_ICON_OPTIONS } from '@features/document/properties/property-icons';
import { noteMetadata } from '@features/memo/public/tree-metadata-api';
import { publishNotebookPathCreated } from '@platform/tauri/notebook-change-events';
import { CollectionFilesTab } from './collection-files-tab';

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  calls.summaries.clear();
  noteMetadata.clear();
  vi.useRealTimers();
  calls.listeners.clear();
  calls.watchRoot.mockReset().mockResolvedValue('lease-1');
  vi.clearAllMocks();
});

const item = (overrides: Partial<Parameters<typeof CollectionFilesTab>[0]> & Record<string, unknown>) => ({
  id: 'x', name: 'x', fullPath: '/book/x', type: 'folder' as const, resourceKind: 'note' as const, ...overrides,
});

const baseProps: Parameters<typeof CollectionFilesTab>[0] = { rootPath: '/book/客户周报', notebookId: 'book-1', notebookPath: '/book', host: 'column-1' };

async function renderTab(props = baseProps): Promise<HTMLDivElement> {
  const node = document.createElement('div');
  root = createRoot(node);
  await act(async () => root?.render(<CollectionFilesTab {...props} />));
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
  return node;
}

describe('collection files tab', () => {
  it('shares the notebook watch root and refreshes only affected visible directories', async () => {
    calls.getDirChildren.mockResolvedValue([]);
    vi.useFakeTimers();
    await renderTab();
    expect(calls.watchRoot).toHaveBeenCalledWith('/book');
    await act(async () => { vi.advanceTimersByTime(200); });
    calls.getDirChildren.mockClear();
    const emit = (directories: string[], paths: string[] = [], leaseId = 'lease-1') => {
      for (const handler of calls.listeners.get('file-browser-directories-changed') ?? []) {
        handler({ leaseId, rootPath: '/book', directories, paths });
      }
    };
    await act(async () => {
      emit(['/book/客户周报/子目录/更深']);
      emit(['/book/客户周报'], [], 'another-lease');
      vi.advanceTimersByTime(200);
    });
    expect(calls.getDirChildren).not.toHaveBeenCalled();
    await act(async () => {
      emit(['/book/客户周报'], ['/book/客户周报/新文件.pdf']);
      emit(['/book/客户周报/子目录'], ['/book/客户周报/子目录/新笔记.md']);
      vi.advanceTimersByTime(200);
    });
    expect(calls.getDirChildren).toHaveBeenCalledTimes(1);
    await act(async () => root?.unmount());
    root = undefined;
    expect(calls.unwatchRoot).toHaveBeenCalledWith('lease-1');
  });

  it('releases a lease that arrives after the tab closes', async () => {
    let finish!: (lease: string) => void;
    calls.watchRoot.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    calls.getDirChildren.mockResolvedValue([]);
    await renderTab();
    await act(async () => root?.unmount());
    root = undefined;
    await act(async () => finish('late-lease'));
    expect(calls.unwatchRoot).toHaveBeenCalledWith('late-lease');
  });

  it('releases a hidden panel watch and reconciles when shown again', async () => {
    calls.getDirChildren.mockResolvedValue([]);
    await renderTab();
    await act(async () => root?.render(<CollectionFilesTab {...baseProps} active={false} />));
    expect(calls.unwatchRoot).toHaveBeenCalledWith('lease-1');
    calls.getDirChildren.mockClear();
    calls.listTables.mockClear();
    await act(async () => root?.render(<CollectionFilesTab {...baseProps} active />));
    expect(calls.watchRoot).toHaveBeenCalledTimes(2);
    expect(calls.getDirChildren).toHaveBeenCalled();
    expect(calls.listTables).toHaveBeenCalled();
  });

  it('refreshes the list and identities for a collection in the visible directory', async () => {
    calls.getDirChildren.mockResolvedValue([]);
    vi.useFakeTimers();
    await renderTab();
    await act(async () => { vi.advanceTimersByTime(200); });
    calls.getDirChildren.mockClear();
    calls.listTables.mockClear();
    const emit = (relativePath: string) => {
      for (const handler of calls.listeners.get('collection-changed') ?? []) {
        handler({ notebookId: 'book-1', relativePath, previousRelativePath: relativePath });
      }
    };
    await act(async () => { emit('其他/集合.index.yaml'); vi.advanceTimersByTime(200); });
    expect(calls.getDirChildren).not.toHaveBeenCalled();
    expect(calls.listTables).not.toHaveBeenCalled();
    await act(async () => { emit('客户周报/集合.index.yaml'); vi.advanceTimersByTime(200); });
    expect(calls.getDirChildren).toHaveBeenCalledTimes(1);
    expect(calls.listTables).toHaveBeenCalledTimes(1);
  });

  it('seeds listed metadata without overwriting a newer update', async () => {
    const path = '/book/客户周报/同步.md';
    const oldMeta = { icon: null, colors: [], favorited: false };
    const newMeta = { icon: 'star', colors: [], favorited: true };
    let finish!: (items: ReturnType<typeof item>[]) => void;
    calls.getDirChildren.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await renderTab();
    noteMetadata.update(path, newMeta);
    await act(async () => finish([item({ type: 'document', name: '同步.md', fullPath: path, memoMeta: oldMeta })]));
    expect(noteMetadata.get(path)).toMatchObject({ status: 'ready', value: newMeta });
  });

  it('merges directory metadata before mounting note rows', async () => {
    const path = '/book/客户周报/元数据.md';
    const metadata = { icon: null, colors: [], favorited: false };
    calls.getDirChildren.mockResolvedValue([item({ type: 'document', name: '元数据.md', fullPath: path, memoMeta: metadata })]);
    await renderTab();
    expect(noteMetadata.get(path)).toMatchObject({ status: 'ready', value: metadata });
  });

  it('ignores descendant changes and batches direct-child refreshes', async () => {
    calls.getDirChildren.mockResolvedValue([]);
    vi.useFakeTimers();
    await renderTab();
    await act(async () => { vi.advanceTimersByTime(200); });
    calls.getDirChildren.mockClear();
    await act(async () => {
      publishNotebookPathCreated({ notebookId: 'book-1', relativePath: '客户周报/子目录/更深/深层.md' });
      vi.advanceTimersByTime(200);
    });
    expect(calls.getDirChildren).not.toHaveBeenCalled();
    await act(async () => {
      publishNotebookPathCreated({ notebookId: 'book-1', relativePath: '客户周报/a.md' });
      publishNotebookPathCreated({ notebookId: 'book-1', relativePath: '客户周报/b.md' });
      vi.advanceTimersByTime(200);
    });
    expect(calls.getDirChildren).toHaveBeenCalledTimes(1);
    await act(async () => {
      publishNotebookPathCreated({ notebookId: 'book-1', relativePath: '客户周报/子目录/新笔记.md' });
      vi.advanceTimersByTime(200);
    });
    expect(calls.getDirChildren).toHaveBeenCalledTimes(2);
  });

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

  it('文件夹行按自己的外观显示（folder_index 优先），集合文件仍按类型显示', async () => {
    const custom = PROPERTY_ICON_OPTIONS[0]!;
    folderAppearance.icons.set('/book/自定义', custom.value);
    calls.summaries.set('/book/列表.index.yaml', { views: [{ domain: 'work_documents' }], properties: {} });
    calls.getDirChildren.mockResolvedValue([
      item({ id: 'calendar', name: '日历', fullPath: '/book/日历', type: 'folder', resourceKind: undefined }),
      item({ id: 'list', name: '列表.index.yaml', fullPath: '/book/列表.index.yaml', type: 'file', resourceKind: undefined }),
      item({ id: 'custom', name: '自定义', fullPath: '/book/自定义', type: 'folder', resourceKind: undefined }),
    ]);
    const node = await renderTab();
    const rows = [...node.querySelectorAll('button[data-file-row]')];
    const row = (title: string) => rows.find((item) => item.textContent?.includes(title))!;
    // 文件夹不是集合：不再借用「表格 / 媒体库」图标，恒用文件夹图标。
    expect(row('日历').querySelector('[data-icon-kind]')).toBeNull();
    expect(row('日历').querySelector('img, svg')).not.toBeNull();
    // 集合文件的类型图标与文件夹无关，照旧有图标。
    expect(row('列表').querySelector('img, svg')).not.toBeNull();
    // 文件夹保存的图标来自文件夹索引表（不是同名的 .index.yaml）。
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

    const node = await renderTab({ ...baseProps, host: 'column-2' });
    await act(async () => node.querySelectorAll<HTMLButtonElement>('button[data-file-row]')[0]?.click());

    // 侧边栏用的是同一个函数（它自己固定 main-third），差别只有宿主。
    expect(calls.openFolderCollection).toHaveBeenCalledWith(
      'book-1', '/book/客户周报/子文件夹', 'column-2',
    );
  });

  it('点击笔记打开文件，不落进集合视图', async () => {
    calls.getDirChildren.mockResolvedValue([
      item({ id: 'n1', name: '周报.md', fullPath: '/book/客户周报/周报.md', type: 'file' }),
    ]);

    const node = await renderTab({ ...baseProps, host: 'column-2' });
    await act(async () => node.querySelectorAll<HTMLButtonElement>('button[data-file-row]')[0]?.click());

    expect(calls.openFolderCollection).not.toHaveBeenCalled();
    expect(calls.openWorkspaceSurface).toHaveBeenCalledWith({
      columnId: 'column-2',
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

  it('列表区域右键按文件树 tab 给出四项，新建文件夹就地开一行输入', async () => {
    calls.getDirChildren.mockResolvedValue([
      item({ id: 'n1', name: '周报.md', fullPath: '/book/客户周报/周报.md', type: 'file' }),
    ]);
    const node = await renderTab();

    await act(async () => {
      node.querySelector('[data-file-name]')!.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 8, clientY: 8,
      }));
    });
    const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items().map((entry) => entry.textContent?.trim()))
      .toEqual(['新建笔记', '新建文件夹', '导入文件…', '导入文件夹…']);

    await act(async () => items().find((entry) => entry.textContent?.includes('新建文件夹'))!.click());
    expect(document.querySelector('[data-flowix-surface="context-menu"]')).toBeNull();
    expect(node.querySelector<HTMLInputElement>('input[aria-label="新建文件夹"]')).not.toBeNull();
  });
});
