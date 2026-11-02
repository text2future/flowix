import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollectionActionsPortal, type CollectionActionsHost } from '@shared/ui/collection-actions';

const calls = vi.hoisted(() => ({
  summary: { current: null as unknown },
  showTableActions: true,
  rename: vi.fn(),
  subscriptions: new Set<(event: unknown) => void>(),
  tableProps: { current: null as Record<string, unknown> | null },
  mediaProps: { current: null as Record<string, unknown> | null },
}));

vi.mock('@features/collection/public/folder-api', () => ({
  readCollectionSummary: () => Promise.resolve(calls.summary.current),
  // 文件夹 → 集合体地址的唯一换算（真实模块里同一条规则）。
  collectionIndexPathForFolder: (folderPath: string) => `${folderPath.replace(/[\\/]+$/, '')}/.index.yaml`,
  addCollectionDomain: vi.fn(),
  addCollectionNoteView: vi.fn(),
  removeCollectionDomain: vi.fn(),
  ensureFolderCollection: vi.fn(),
  resolveCollectionScope: (source: unknown) => (source ? { relativePath: '客户周报', depth: 'descendants' as const } : undefined),
  updateCollectionProperties: vi.fn(),
  // 头图 seed 规则在真实模块里做哈希；这里给可断言的确定性替身（同一 seed ⇒ 同一图）。
}));
vi.mock('./collection-asset-filter-menu', () => ({ CollectionAssetFilterMenu: () => <button data-testid="inline-assets-filter">资料筛选</button> }));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: (_name: string, callback: (event: unknown) => void) => {
  calls.subscriptions.add(callback); return () => calls.subscriptions.delete(callback);
} }));
vi.mock('@features/collection/mutations', () => ({ renameCollectionAtPath: calls.rename }));
vi.mock('@features/multidimensional-table/public/surface-api', () => ({
  TableDocumentView: (props: Record<string, unknown>) => {
    calls.tableProps.current = props;
    return calls.showTableActions ? <>
      <div data-testid="table-host">{props.assetFilterMenu as import('react').ReactNode}</div>
      <CollectionActionsPortal host={props.collectionActionsHost as CollectionActionsHost}><button data-testid="notes-filter-slot">笔记筛选</button></CollectionActionsPortal>
    </> : null;
  },
}));
vi.mock('@features/media-library/public/surface-api', () => ({
  MediaLibraryView: (props: { actionsHost: CollectionActionsHost; activeViewId?: string; editable?: boolean; onOpenNoteFilter?: () => void }) => {
    calls.mediaProps.current = props;
    return <div data-testid="media-panel" data-active-view={props.activeViewId} data-editable={String(props.editable)}>
      <button data-testid="request-notes-filter" onClick={props.onOpenNoteFilter}>笔记筛选</button>
      <CollectionActionsPortal host={props.actionsHost}><button>媒体操作</button></CollectionActionsPortal>
    </div>;
  },
  // 文件树 tab 的数据集合菜单要用这个面板；外壳测试不关心它长什么样。
  MediaLibraryFilterPanel: () => null,
}));
vi.mock('./work-documents-collection-view', () => ({
  WorkDocumentsCollectionView: ({ actionsHost }: { actionsHost: CollectionActionsHost }) => <div data-testid="work-panel"><CollectionActionsPortal host={actionsHost}><button>列表操作</button></CollectionActionsPortal></div>,
}));
vi.mock('@features/agent/public/shell-api', () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
  createAndOpenAgentConversationWithPrompt: vi.fn(),
  useNewConversationAgentSelection: () => ({ kind: 'create', agentType: 'pi', options: [{ id: 'pi', name: 'Pi' }] }),
  listSelectableAgentTypes: () => [{ id: 'pi', name: 'Pi', icon: '', runtimeKind: 'builtin', desc: '', capabilities: {} }],
}));

import { CollectionShell } from './collection-shell';
import { useCollectionBannerControl } from '@/lib/collection-banner-visibility';

const HYBRID_NOTES_ONLY = {
  source: '', formatVersion: 3 as const, fileTree: false,
  domains: ['notes' as const],
  views: [{ id: 'v1', name: '表格', domain: 'notes' as const }],
  defaultByDomain: { notes: 'v1' }, collectionId: 'c1', revision: 1,
};
const HYBRID_WITH_FILE_TREE = {
  ...HYBRID_NOTES_ONLY, fileTree: true,
  domains: ['notes' as const, 'media' as const],
  views: [
    { id: 'v1', name: '表格', domain: 'notes' as const },
    { id: 'v2', name: '图墙', domain: 'media' as const },
  ],
  defaultByDomain: { notes: 'v1', media: 'v2' },
};

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
  calls.tableProps.current = null;
  calls.mediaProps.current = null;
  calls.showTableActions = true;
  window.localStorage.clear();
  vi.clearAllMocks();
});

/**
 * 一套外壳跑两个入口：入口只决定「给了什么」，不决定版式。
 * 挂到 document 上（而不是游离节点）：操作区的框内菜单按 id 找槽位，离开文档树就找不到。
 */
async function renderShell(props: Parameters<typeof CollectionShell>[0]): Promise<HTMLDivElement> {
  const node = document.createElement('div');
  document.body.append(node);
  host = node;
  root = createRoot(node);
  await act(async () => root?.render(<CollectionShell {...props} />));
  for (let i = 0; i < 10; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
  return node;
}

function activeTab() { return host?.querySelector('[aria-label="集合视图"] [aria-current="page"]')?.textContent; }
function selectTab(key: string) {
  const summary = calls.summary.current as { views: { id: string; name: string }[] };
  const name = key === 'files' ? '文件夹' : summary.views.find((view) => view.id === key.slice(key.indexOf(':') + 1))?.name;
  const target = [...(host?.querySelectorAll<HTMLButtonElement>('[aria-label="集合视图"] button') ?? [])].find((button) => button.textContent === name);
  expect(target).toBeDefined(); target?.click();
}

describe('collection shell', () => {
  it('直接打开集合文件：名字取文件夹（.index.yaml 没有集合文件名），且没有文件树 tab', async () => {
    calls.summary.current = HYBRID_NOTES_ONLY;
    const node = await renderShell({
      filePath: '/book/客户周报/.index.yaml',
      notebookId: 'book',
      notebookPath: '/book',
      host: 'main-third',
    });

    // 大标题独占一行：`.index.yaml` 用所在文件夹名当集合名。
    expect(node.querySelector('h2')?.textContent).toBe('客户周报');
    // 文件树 tab 只属于文件夹类型的集合：直接打开集合文件时没有它。
    expect(node.querySelector('[aria-label="集合视图"]')?.textContent).not.toContain('全部');
    expect(node.querySelector('[data-view-scope]')?.textContent).toBe('仅笔记');
    // 名字已经在大标题上，表格 nav 的小标题关掉（一个集合只出现一处名字）。
    expect(calls.tableProps.current?.showNavTitle).toBe(false);
    // 头图下的集合图标：头图可见时叠在头图下缘（色相已改为静态混色，见 collection-banner.css）。
    const headerIcon = node.querySelector<HTMLElement>('.collection-header-icon-tint');
    expect(headerIcon).not.toBeNull();
    expect(headerIcon?.querySelector('svg')).not.toBeNull();
  });

  it('集合变更事件更新唯一 tab 栏，不依赖表格回调', async () => {
    calls.summary.current = HYBRID_NOTES_ONLY;
    const node = await renderShell({ filePath: '/book/集合.index.yaml', notebookId: 'book', notebookPath: '/book', host: 'main-third' });
    calls.summary.current = { ...HYBRID_NOTES_ONLY, views: [{ id: 'v1', name: '新名称', domain: 'notes' }, { id: 'calendar1', name: '日历', domain: 'notes' }] };
    await act(async () => { for (const handler of calls.subscriptions) handler({ notebookId: 'book', collectionId: 'c1', relativePath: '集合.index.yaml' }); });
    expect(node.querySelectorAll('[aria-label="集合视图"]')).toHaveLength(1);
    expect(node.querySelector('[aria-label="集合视图"]')?.textContent).toContain('新名称');
    expect(node.querySelector('[aria-label="集合视图"]')?.textContent).toContain('日历');
    expect(calls.tableProps.current?.onNoteViewsChange).toBeUndefined();
  });

  it('集合文件即使 file_tree 为真也不展示文件树 tab（文件树只属于文件夹类型）', async () => {
    calls.summary.current = HYBRID_WITH_FILE_TREE;
    await renderShell({
      filePath: '/book/客户周报/.index.yaml',
      notebookId: 'book',
      notebookPath: '/book',
      host: 'main-third',
    });

    // 宿主 tab 的 label 就是资料视图自身的名字（可改名），不做 i18n 兜底。
    expect(host?.querySelector('[aria-label="集合视图"]')?.textContent).toContain('图墙');
    expect(host?.querySelector('[aria-label="集合视图"]')?.textContent).not.toContain('全部');
  });

  it('直接打开文件夹：同一套外壳，多出的文件树 tab 来自 file_tree 标记', async () => {
    calls.summary.current = HYBRID_WITH_FILE_TREE;
    const node = await renderShell({
      folderPath: '/book/客户周报',
      notebookId: 'book',
      notebookPath: '/book',
      host: 'main-third',
    });

    expect(node.querySelector('h2')?.textContent).toBe('客户周报');
    expect(node.querySelector('[aria-label="集合视图"]')?.textContent).toContain('文件夹');
    expect(node.querySelector('[aria-label="集合视图"]')?.textContent).toContain('图墙');
    expect(calls.tableProps.current?.showNavTitle).toBe(false);
  });

  it('大标题双击改名：失焦保存后标题跟着新路径走', async () => {
    calls.summary.current = HYBRID_NOTES_ONLY;
    calls.rename.mockResolvedValue({ filePath: '/book/客户月报/.index.yaml' });
    const node = await renderShell({
      filePath: '/book/客户周报/.index.yaml',
      notebookId: 'book',
      notebookPath: '/book',
      host: 'main-third',
    });

    const titleButton = node.querySelector('h2 button');
    expect(titleButton).not.toBeNull();
    await act(async () => {
      titleButton!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    const input = node.querySelector<HTMLInputElement>('h2 input');
    expect(input).not.toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(input, '客户月报');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(calls.rename).toHaveBeenCalledWith('/book/客户周报/.index.yaml', '/book', '客户月报', 'book', 'c1');
    expect(node.querySelector('h2')?.textContent).toBe('客户月报');
  });
});

describe('collection shell active tab', () => {
  const folderProps = { folderPath: '/book/客户周报', notebookId: 'book', notebookPath: '/book', host: 'main-third' as const };

  it('文件夹集合默认落在「文件树」tab', async () => {
    calls.summary.current = HYBRID_WITH_FILE_TREE;
    const node = await renderShell(folderProps);

    expect(activeTab()).toBe('文件夹');
    expect(node.querySelector('[data-view-scope]')).toBeNull();
  });

  it('同一资料域的不同 tab 把自己的视图 ID 交给内容面板', async () => {
    calls.summary.current = { ...HYBRID_WITH_FILE_TREE, views: [...HYBRID_WITH_FILE_TREE.views,
      { id: 'v3', name: '视频', domain: 'media' }] };
    const node = await renderShell(folderProps);
    await act(async () => selectTab('media:v2'));
    expect(node.querySelector('[data-testid="media-panel"]')?.getAttribute('data-active-view')).toBe('v2');
    expect(node.querySelector('[data-view-scope]')?.textContent).toBe('仅资料');
    await act(async () => selectTab('media:v3'));
    expect(node.querySelector('[data-testid="media-panel"]')?.getAttribute('data-active-view')).toBe('v3');
    expect(node.querySelector('[data-view-scope]')?.textContent).toBe('仅资料');
    expect(node.querySelector('[data-testid="media-panel"]')?.getAttribute('data-editable')).toBe('true');
  });

  it('从图墙打开笔记筛选时保持图墙 tab，不跳转到表格', async () => {
    calls.summary.current = HYBRID_WITH_FILE_TREE;
    const node = await renderShell(folderProps);
    await act(async () => selectTab('media:v2'));
    expect(activeTab()).toBe('图墙');

    const requests: unknown[] = [];
    const listener = (event: Event) => requests.push((event as CustomEvent).detail);
    window.addEventListener('flowix:collection-dataset-filter-request', listener);
    try {
      await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="request-notes-filter"]')?.click());
      for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });

      expect(activeTab()).toBe('图墙');
      expect(requests).toContainEqual({ indexPath: '/book/客户周报/.index.yaml', target: 'notes' });
      expect(node.querySelector('[data-host-actions-slot] [data-testid="notes-filter-slot"]')).not.toBeNull();
    } finally {
      window.removeEventListener('flowix:collection-dataset-filter-request', listener);
    }
  });

  it('独立日历添加图墙后，日历操作菜单也提供集合资料筛选', async () => {
    calls.summary.current = { ...HYBRID_WITH_FILE_TREE, fileTree: false,
      views: [{ id: 'v1', name: '日历', domain: 'notes' }, { id: 'v2', name: '图墙', domain: 'media' }] };
    const node = await renderShell({ filePath: '/book/日历.index.yaml', notebookId: 'book', notebookPath: '/book', host: 'main-third' });
    expect(activeTab()).toBe('日历');
    expect(node.querySelector('[data-testid="inline-assets-filter"]')).not.toBeNull();
    expect(calls.tableProps.current?.assetFilterMenu).toBeTruthy();
  });

  it('普通打开笔记数据集合时不发送二级筛选打开请求', async () => {
    calls.summary.current = HYBRID_WITH_FILE_TREE;
    await renderShell({ filePath: '/book/客户周报/.index.yaml', notebookId: 'book', notebookPath: '/book', host: 'main-third' });
    const listener = vi.fn();
    window.addEventListener('flowix:collection-dataset-filter-request', listener);
    try {
      await act(async () => (calls.tableProps.current?.onDatasetFilterOpenChange as (open: boolean) => void)(true));
      expect(listener).not.toHaveBeenCalled();
    } finally { window.removeEventListener('flowix:collection-dataset-filter-request', listener); }
  });

  it('表格提供内嵌资料筛选，保留笔记操作区', async () => {
    calls.summary.current = HYBRID_WITH_FILE_TREE;
    const node = await renderShell({ filePath: '/book/客户周报/.index.yaml', notebookId: 'book', notebookPath: '/book', host: 'main-third' });
    expect(activeTab()).toBe('表格');

    const requests: unknown[] = [];
    const listener = (event: Event) => requests.push((event as CustomEvent).detail);
    window.addEventListener('flowix:collection-dataset-filter-request', listener);
    try {
      await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="inline-assets-filter"]')?.click());
      for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });

      expect(activeTab()).toBe('表格');
      expect(requests).toEqual([]);
      expect(node.querySelector('[data-host-actions-slot] [data-testid="notes-filter-slot"]')).not.toBeNull();
    } finally {
      window.removeEventListener('flowix:collection-dataset-filter-request', listener);
    }
  });

  it('表格尚未加载时，文件树与操作区已由外壳展示', async () => {
    calls.summary.current = HYBRID_WITH_FILE_TREE;
    calls.showTableActions = false;
    const node = await renderShell(folderProps);
    expect(node.querySelector('[data-host-actions-slot] button[aria-label="管理数据集"]')).not.toBeNull();
    // 表格是否就绪不再决定文件树或它的操作区是否挂载。
    calls.showTableActions = true;
    await act(async () => root?.render(<CollectionShell {...folderProps} />));
    expect(node.querySelector('[data-host-actions-slot] button[aria-label="管理数据集"]')).not.toBeNull();
  });

  it('文件树、图墙、列表和表格切换时，只有当前面板占用操作区', async () => {
    calls.summary.current = {
      ...HYBRID_WITH_FILE_TREE,
      domains: ['notes', 'media', 'work_documents'],
      views: [...HYBRID_WITH_FILE_TREE.views, { id: 'w1', name: '列表', domain: 'work_documents' }],
      defaultByDomain: { ...HYBRID_WITH_FILE_TREE.defaultByDomain, work_documents: 'w1' },
    };
    const node = await renderShell(folderProps);
    const slot = () => node.querySelector('[data-host-actions-slot]');
    const select = selectTab;
    expect(slot()?.querySelector('button[aria-label="管理数据集"]')).not.toBeNull();
    await act(async () => select('media:v2'));
    expect(slot()?.textContent).toBe('媒体操作');
    // 已挂载面板遇到操作槽移除/重建，也要切换到新的目标，不留在脱离 DOM 的节点里。
    await act(async () => {
      (calls.tableProps.current?.onActiveViewChange as (id: string) => void)('v1');
    });
    expect(slot()?.textContent).not.toContain('媒体操作');
    expect(node.querySelectorAll('[aria-label="集合视图"]')).toHaveLength(1);
    expect(window.localStorage.getItem('flowix:collection:active-host-tab:c1')).toBe('notes:v1');
    await act(async () => select('media:v2'));
    expect(slot()?.textContent).toBe('媒体操作');
    await act(async () => select('work_documents:w1'));
    expect(slot()?.textContent).toBe('列表操作');
    await act(async () => select('files'));
    expect(slot()?.querySelector('button[aria-label="管理数据集"]')).not.toBeNull();
    expect(slot()?.textContent).not.toContain('媒体操作');
    expect(slot()?.textContent).not.toContain('列表操作');
    await act(async () => (calls.tableProps.current?.onActiveViewChange as (id: string) => void)('v1'));
    expect(slot()?.textContent).not.toContain('媒体操作');
    expect(node.querySelectorAll('[aria-label="集合视图"]')).toHaveLength(1);
  });

  it('同一集合在主列和浏览列同时打开时，操作区互不占用', async () => {
    calls.summary.current = HYBRID_WITH_FILE_TREE;
    const main = await renderShell(folderProps);
    window.localStorage.setItem('flowix:collection:active-host-tab:c1', 'media:v2');
    const browser = document.createElement('div');
    document.body.append(browser);
    const browserRoot = createRoot(browser);
    try {
      await act(async () => browserRoot.render(<CollectionShell filePath="/book/客户周报/.index.yaml" notebookId="book" notebookPath="/book" host="browser-column" />));
      const mainSlot = main.querySelector('[data-host-actions-slot]');
      expect(mainSlot?.querySelector('button[aria-label="管理数据集"]')).not.toBeNull();
      expect(mainSlot?.textContent).not.toContain('媒体操作');
      expect(browser.querySelector('[data-host-actions-slot]')?.textContent).toBe('媒体操作');
    } finally {
      await act(async () => browserRoot.unmount());
      browser.remove();
    }
    expect(main.querySelector('[data-host-actions-slot] button[aria-label="管理数据集"]')).not.toBeNull();
  });

  it('集合文件入口默认仍落在表格视图（没有文件树 tab）', async () => {
    calls.summary.current = HYBRID_WITH_FILE_TREE;
    await renderShell({ filePath: '/book/客户周报/.index.yaml', notebookId: 'book', notebookPath: '/book', host: 'main-third' });

    expect(activeTab()).toBe('表格');
  });

  it('切换 tab 保存偏好，但文件夹重新打开默认仍为文件树', async () => {
    calls.summary.current = HYBRID_WITH_FILE_TREE;
    await renderShell(folderProps);

    const select = selectTab;
    // 资料域 tab 按**视图实例**记：键形如 `media:<viewId>`，不再是旧的域级键。
    await act(async () => select('media:v2'));
    expect(activeTab()).toBe('图墙');
    expect(window.localStorage.getItem('flowix:collection:active-host-tab:c1')).toBe('media:v2');

    // 重新打开同一个集合（新实例）：直接落在上次的 tab。
    await act(async () => root?.unmount());
    root = undefined;
    await renderShell(folderProps);
    expect(activeTab()).toBe('文件夹');
  });

  it('文件夹入口不受上次表格视图偏好的影响，默认选中文件树', async () => {
    calls.summary.current = HYBRID_WITH_FILE_TREE;
    window.localStorage.setItem('flowix:collection:active-host-tab:c1', 'notes');
    const node = await renderShell(folderProps);
    expect(activeTab()).toBe('文件夹');
    expect(node.querySelector('button[aria-label="管理数据集"]')).not.toBeNull();
  });

  it('记录里的 tab 已不成立时回落默认（文件树被关掉 → 表格视图）', async () => {
    window.localStorage.setItem('flowix:collection:active-host-tab:c1', 'files');
    calls.summary.current = { ...HYBRID_WITH_FILE_TREE, fileTree: false };
    await renderShell(folderProps);

    expect(activeTab()).toBe('表格');
  });

  it.each(['table', 'gallery', 'kanban', 'calendar'] as const)('唯一 tab 栏的添加菜单可创建 %s', async (layout) => {
    calls.summary.current = null;
    const api = await import('@features/collection/public/folder-api');
    const label = { table: '表格', gallery: '画廊', kanban: '看板', calendar: '日历' }[layout];
    vi.mocked(api.addCollectionNoteView).mockResolvedValue({
      summary: { ...HYBRID_NOTES_ONLY, sources: {}, properties: {}, fileTree: true,
        views: [{ id: 'new-view', name: label, domain: 'notes' }], defaultByDomain: { notes: 'new-view' } }, viewId: 'new-view',
    });
    const node = await renderShell(folderProps);
    expect(node.querySelectorAll('[aria-label="集合视图"]')).toHaveLength(1);
    await act(async () => node.querySelector<HTMLButtonElement>('button[aria-label="显示设置"]')?.click());
    const labels = [...document.querySelectorAll('button')].map((button) => button.textContent);
    for (const name of ['表格', '画廊', '看板', '日历']) expect(labels).toContain(name);
    const choice = [...document.querySelectorAll('button')].find((button) => button.textContent === label);
    await act(async () => choice?.click());
    if (layout === 'calendar' || layout === 'kanban') {
      const field = [...document.querySelectorAll('button')].find((button) => button.textContent === (layout === 'calendar' ? '日期' : '状态'));
      expect(field).toBeDefined();
      await act(async () => field?.click());
    }
    expect(api.addCollectionNoteView).toHaveBeenCalledWith('/book/客户周报/.index.yaml', '/book', layout, '/book/客户周报', layout === 'calendar' ? '__note_calendar_date__' : undefined);
    expect(node.querySelectorAll('[aria-label="集合视图"]')).toHaveLength(1);
    expect(calls.tableProps.current?.showNavigation).toBe(false);
    expect(calls.tableProps.current?.initialViewId).toBe('new-view');
  });

  it.each([['media', '图墙'], ['work_documents', '列表']] as const)('空文件夹从同一个菜单添加 %s', async (domain, label) => {
    calls.summary.current = null;
    const api = await import('@features/collection/public/folder-api');
    vi.mocked(api.ensureFolderCollection).mockResolvedValue({
      ...HYBRID_NOTES_ONLY, sources: {}, properties: {}, fileTree: true, domains: [domain],
      views: [{ id: 'asset-view', name: label, domain }], defaultByDomain: { [domain]: 'asset-view' },
    });
    const node = await renderShell(folderProps);
    await act(async () => node.querySelector<HTMLButtonElement>('button[aria-label="显示设置"]')?.click());
    const choice = [...document.querySelectorAll('button')].find((button) => button.textContent?.startsWith(label));
    await act(async () => choice?.click());
    expect(api.ensureFolderCollection).toHaveBeenCalledWith('/book/客户周报', '/book', '客户周报', domain);
    expect(node.querySelectorAll('[aria-label="集合视图"]')).toHaveLength(1);
  });

  it('文件夹入口尚无 .index.yaml：文件树不套灰色描边框（与有集合时的版式一致），且右侧操作槽照旧给出', async () => {
    calls.summary.current = null;
    const node = await renderShell(folderProps);

    // 缺集合时走的是「占位 tab + 文件树」的兜底分支，不再有那圈 rounded-xl border
    // （集合图标本身是圆角描边，排除掉它才是这条回归要守的「内容区外框」）。
    expect(node.textContent).toContain('文件夹');
    expect(node.querySelector('.rounded-xl.border:not(.collection-header-icon-tint)')).toBeNull();

    // 回归：兜底态也必须有 nav 右侧的操作槽，否则文件树的数据集合按钮会整块消失
    // （首次点开文件夹看不见、切一次 tab 又出现）。
    const slot = node.querySelector<HTMLElement>('[data-host-actions-slot]');
    expect(slot).not.toBeNull();
    // 文件树操作由外壳直接渲染，不依赖 `.index.yaml` 或表格加载。
    expect(slot?.querySelector('button[aria-label="管理数据集"]')).not.toBeNull();
  });

  it('文件夹入口尚无 .index.yaml：默认隐藏头图，不请求在线图片', async () => {
    calls.summary.current = null;
    const node = await renderShell(folderProps);
    expect(node.querySelector('img[src^="https://"]')).toBeNull();
    expect(node.querySelector('.collection-banner-placeholder')).toBeNull();
    expect(node.querySelector('button[aria-label="切换图片"]')).toBeNull();
  });

  it('已有文件夹集合显式开启但未选图片时显示色块背景', async () => {
    calls.summary.current = { ...HYBRID_WITH_FILE_TREE, properties: { banner_hidden: { type: 'Boolean', value: false } } };
    const node = await renderShell(folderProps);
    expect(node.querySelector('img[src^="https://"]')).toBeNull();
    expect(node.querySelector('.collection-banner-placeholder')).not.toBeNull();
  });
});

describe('standalone list collection', () => {
  const summary = {
    source: '', formatVersion: 2 as const, fileTree: true,
    domains: ['work_documents' as const],
    views: [{ id: 'list1', name: '列表', domain: 'work_documents' as const }],
    defaultByDomain: { work_documents: 'list1' }, collectionId: 'list-collection', revision: 0, properties: {},
  };
  it.each([null, 'notes', 'files'])('没有笔记域时从旧偏好 %s 回到列表，并且打开不修改集合', async (preference) => {
    calls.summary.current = summary;
    if (preference) window.localStorage.setItem('flowix:collection:active-host-tab:list-collection', preference);
    const node = await renderShell({ filePath: '/book/资料 (2).index.yaml', notebookId: 'book', notebookPath: '/book', host: 'main-third' });
    expect(node.querySelector('[aria-label="集合视图"] button[aria-current="page"]')?.textContent).toBe('列表');
    expect(node.querySelector('[data-testid="work-panel"]')).not.toBeNull();
    expect(node.querySelector('[data-testid="table-host"]')).toBeNull();
    const api = await import('@features/collection/public/folder-api');
    expect(api.addCollectionDomain).not.toHaveBeenCalled();
  });
});

describe('collection shell banner', () => {
  const HYBRID_MEDIA = {
    source: '', formatVersion: 3 as const, fileTree: false,
    domains: ['notes' as const, 'media' as const],
    views: [
      { id: 'v1', name: '表格', domain: 'notes' as const },
      { id: 'v2', name: '媒体', domain: 'media' as const },
    ],
    defaultByDomain: { notes: 'v1', media: 'v2' },
    sources: { media: { scope: 'containing_folder' as const, depth: 'descendants' as const } },
    collectionId: 'c1', revision: 1, properties: { banner_hidden: { type: 'Boolean', value: false } },
  };

  it('有媒体域且未隐藏时，向表格传入 bannerVisible=true', async () => {
    calls.summary.current = HYBRID_MEDIA;
    await renderShell({ filePath: '/book/客户周报/.index.yaml', notebookId: 'book', notebookPath: '/book', host: 'main-third' });

    expect(calls.tableProps.current?.bannerVisible).toBe(true);
    expect(typeof calls.tableProps.current?.onToggleBannerVisibility).toBe('function');
  });

  it('集合属性 banner_hidden=true 时，传入 bannerVisible=false', async () => {
    calls.summary.current = { ...HYBRID_MEDIA, properties: { banner_hidden: { type: 'Boolean', value: true } } };
    await renderShell({ filePath: '/book/客户周报/.index.yaml', notebookId: 'book', notebookPath: '/book', host: 'main-third' });

    expect(calls.tableProps.current?.bannerVisible).toBe(false);
  });

  it('没有媒体域时仍可开关头图（bannerVisible=true：顶部是渐变占位）', async () => {
    calls.summary.current = { ...HYBRID_NOTES_ONLY, properties: { banner_hidden: { type: 'Boolean', value: false } } };
    await renderShell({ filePath: '/book/客户周报/.index.yaml', notebookId: 'book', notebookPath: '/book', host: 'main-third' });

    expect(calls.tableProps.current?.bannerVisible).toBe(true);
  });

  it('切换头图显示写入集合属性 banner_hidden', async () => {
    const updateCollectionProperties = (await import('@features/collection/public/folder-api')).updateCollectionProperties as unknown as ReturnType<typeof vi.fn>;
    calls.summary.current = HYBRID_MEDIA;
    await renderShell({ filePath: '/book/客户周报/.index.yaml', notebookId: 'book', notebookPath: '/book', host: 'main-third' });

    updateCollectionProperties.mockResolvedValue(HYBRID_MEDIA);
    const toggle = calls.tableProps.current?.onToggleBannerVisibility as (() => void) | undefined;
    await act(async () => { toggle?.(); });

    expect(updateCollectionProperties).toHaveBeenCalledWith(expect.objectContaining({
      collectionId: 'c1',
      expectedRevision: 1,
      properties: { banner_hidden: { type: 'Boolean', value: true } },
    }));
  });

  it('把「显示头图」的写入口登记给 header 的「···」，并跟着属性变化', async () => {
    const updateCollectionProperties = (await import('@features/collection/public/folder-api')).updateCollectionProperties as unknown as ReturnType<typeof vi.fn>;
    calls.summary.current = HYBRID_MEDIA;
    await renderShell({ filePath: '/book/客户周报/.index.yaml', notebookId: 'book', notebookPath: '/book', host: 'main-third' });

    // 一个探针读注册表：header 的「···」就是这么拿到状态与写入口的。
    const probeHost = document.createElement('div');
    document.body.append(probeHost);
    const probe = createRoot(probeHost);
    await act(async () => probe.render(<BannerProbe indexPath="/book/客户周报/.index.yaml" />));
    expect(probeHost.textContent).toBe('true:true');

    updateCollectionProperties.mockResolvedValue({ ...HYBRID_MEDIA, properties: { banner_hidden: { type: 'Boolean', value: true } } });
    const toggleFromHeader = () => probeHost.querySelector<HTMLButtonElement>('button')!.click();
    await act(async () => { toggleFromHeader(); });
    expect(updateCollectionProperties).toHaveBeenCalledOnce();
    // 属性落盘后外壳重登记，header 那边的状态跟着变（图标从眼睛变斜眼）。
    expect(probeHost.textContent).toBe('true:false');

    await act(async () => { probe.unmount(); });
    probeHost.remove();
  });
});

/** header「···」的读法：available:visible。 */
function BannerProbe({ indexPath }: { indexPath: string }) {
  const { available, visible, toggle } = useCollectionBannerControl(indexPath);
  return <button type="button" onClick={toggle}>{`${available}:${visible}`}</button>;
}
