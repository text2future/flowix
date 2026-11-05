import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  isIndexExcluded: vi.fn(),
  getDirChildren: vi.fn(),
  read: vi.fn(),
  /** Capture the notes panel contract; navigation belongs to the collection frame. */
  tableProps: { current: null as Record<string, unknown> | null },
}));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: () => () => {} }));
vi.mock('@platform/tauri/client', () => ({
  files: { isIndexExcluded: (path: string) => calls.isIndexExcluded(path), getDirChildren: calls.getDirChildren, read: (path: string, scope: string) => calls.read(path, scope) },
  notes: {},
}));
vi.mock('@features/workspace/public/main-window-api', () => ({ openFolderCollection: vi.fn(), openFolderCollectionFromFolder: vi.fn() }));
vi.mock('@features/agent/public/shell-api', () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
  createAndOpenAgentConversationWithPrompt: vi.fn(),
  useNewConversationAgentSelection: () => ({ kind: 'create', agentType: 'pi', options: [{ id: 'pi', name: 'Pi' }] }),
  listSelectableAgentTypes: () => [{ id: 'pi', name: 'Pi', icon: '', runtimeKind: 'builtin', desc: '', capabilities: {} }],
}));
vi.mock('@features/multidimensional-table/public/surface-api', () => ({
  TableDocumentView: (props: Record<string, unknown>) => {
    calls.tableProps.current = props;
    return <div data-testid="table-host" />;
  },
}));
vi.mock('@features/media-library/public/surface-api', () => ({
  MediaLibraryView: () => <div data-testid="media-panel" />,
  MediaLibraryFilterPanel: () => null,
}));

vi.mock('./work-documents-collection-view', () => ({ WorkDocumentsCollectionView: () => <div data-testid="work-panel" /> }));

import { CollectionRenderer, WorkDocumentsCollectionRenderer, MediaLibraryRenderer } from './workspace-surface-renderers';
import { createWorkDocumentsCollection, serializeWorkDocumentsCollection } from '@features/work-documents/model';
import { createMediaLibrary, serializeMediaLibrary } from '@features/media-library/model';
import type { WorkspaceSurfaceRenderContext, WorkspaceSurfaceRendererData } from './workspace-surface-renderer-contract';
import { createFolderHybridCollectionContent } from '@features/collection/public/folder-api';

const surface: Extract<WorkspaceSurfaceRendererData, { kind: 'collection' }> = {
  kind: 'collection',
  notebookId: 'book',
  notebookPath: '/book',
  folderPath: '/book/.agents/skills',
  folderName: 'skills',
};
const context: WorkspaceSurfaceRenderContext = {
  host: 'column-1',
  viewId: 'work',
  focused: true,
  readOnly: false,
};

let root: Root | undefined;

beforeEach(() => {
  calls.read.mockResolvedValue(null);
  calls.isIndexExcluded.mockResolvedValue(false);
  calls.getDirChildren.mockResolvedValue([]);
  calls.tableProps.current = null;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  // 集合的「当前 tab」记在 localStorage，用例之间必须清掉，否则会互相带入上一次的选择。
  window.localStorage.clear();
  vi.clearAllMocks();
});

async function render(): Promise<HTMLDivElement> {
  const node = document.createElement('div');
  root = createRoot(node);
  await act(async () => root?.render(<CollectionRenderer surface={surface} context={context} />));
  return node;
}

describe('folder home inside index-excluded folders', () => {
  it('replaces the folder home with the hidden-folder notice', async () => {
    calls.isIndexExcluded.mockResolvedValue(true);
    const node = await render();

    expect(calls.isIndexExcluded).toHaveBeenCalledWith('/book/.agents/skills');
    expect(node.textContent).toContain('这是一个隐藏文件夹');
    expect(node.textContent).not.toContain('文件列表');
    expect(node.querySelectorAll('button')).toHaveLength(0);
  });

  it('文件夹入口传递只读能力，保持文件树可浏览并禁用修改菜单', async () => {
    calls.read.mockResolvedValue(createFolderHybridCollectionContent('skills', ''));
    const node = document.createElement('div'); root = createRoot(node);
    await act(async () => root?.render(<CollectionRenderer surface={surface} context={{ ...context, readOnly: true }} />));
    expect(node.querySelector('[aria-current="page"]')?.textContent).toBe('文件夹');
    expect(node.querySelector<HTMLButtonElement>('button[aria-label="显示设置"]')?.disabled).toBe(true);
    expect(calls.tableProps.current?.editable).toBe(false);
  });

  it('旧 work-documents 文件夹入口也使用统一集合外壳', async () => {
    calls.isIndexExcluded.mockResolvedValue(false);
    calls.read.mockResolvedValue(null);
    calls.getDirChildren.mockResolvedValue([]);
    const node = document.createElement('div');
    root = createRoot(node);
    await act(async () => root?.render(<CollectionRenderer surface={{ ...surface, viewMode: 'work-documents' }} context={context} />));
    for (let i = 0; i < 20 && !node.textContent?.includes('文件夹'); i++) {
      await act(async () => { await Promise.resolve(); });
    }
    expect(node.querySelector('h2')?.textContent).toBe('skills');
    expect(node.textContent).toContain('文件夹');
    expect(node.querySelectorAll('[aria-label="集合视图"]')).toHaveLength(1);
  });

  it('renders the folder home (agent composer + first-level tabs + view entries)', async () => {
    calls.isIndexExcluded.mockResolvedValue(false);
    calls.getDirChildren.mockResolvedValue([
      { id: 'f1', fullPath: '/book/sub', name: 'sub', type: 'folder', parentId: null, children: null, sizeBytes: null, modifiedMs: null, createdMs: null, memoCreatedMs: null, memoMeta: null, resourceKind: null, indexExcluded: false, pinned: false },
      { id: 'n1', fullPath: '/book/idea.md', name: 'idea.md', type: 'document', parentId: null, children: null, sizeBytes: null, modifiedMs: null, createdMs: null, memoCreatedMs: null, memoMeta: null, resourceKind: 'note', indexExcluded: false, pinned: false },
    ]);
    const node = await render();
    const text = () => node.textContent ?? '';
    // FolderHomeView 静态挂载，flush 微任务等 getDirChildren 数据落地。
    for (let i = 0; i < 20 && !text().includes('文件夹'); i += 1) {
      await act(async () => { await Promise.resolve(); });
    }

    expect(node.querySelector('input[placeholder*="询问内容"]')).not.toBeNull();
    // 直接打开：集合名是大标题，独占一行。
    expect(node.querySelector('h2')?.textContent).toBe('skills');
    expect(text()).toContain('文件夹');
    // 尚无 .index.yaml：只展示文件树，视图由原显示菜单按需添加。
    expect(node.querySelectorAll('[aria-label="集合视图"]')).toHaveLength(1);
    expect(node.querySelector('button[aria-label="显示设置"]')).not.toBeNull();
    // 「仅第一层」角标已移除。
    expect(text()).not.toContain('仅第一层');
    // 文件树 tab 是文件树：文件夹与笔记同列，笔记去掉扩展名展示。
    expect(text()).toContain('sub');
    expect(text()).toContain('idea');
    expect(text()).not.toContain('idea.md');
  });

  it('外壳独立展示文件树与资料 tab，表格不再持有其他面板', async () => {
    calls.isIndexExcluded.mockResolvedValue(false);
    calls.getDirChildren.mockResolvedValue([]);
    calls.read.mockResolvedValue(createFolderHybridCollectionContent('skills', ''));
    const node = await render();
    const text = () => node.textContent ?? '';
    for (let i = 0; i < 20 && !text().includes('文件夹'); i += 1) {
      await act(async () => { await Promise.resolve(); });
    }

    // 集合外壳独立持有唯一 tab 条，表格只提供笔记内容。
    const host = node.querySelector('[data-testid="table-host"]');
    expect(host).not.toBeNull();
    const navigation = node.querySelector('[aria-label="集合视图"]');
    expect(navigation).not.toBeNull();
    expect(host!.contains(navigation)).toBe(false);
    const labels = [...navigation!.querySelectorAll('button')].map((button) => button.textContent?.trim());
    expect(labels).toContain('文件夹');
    expect(labels).toContain('图墙');
    expect(labels).toContain('列表');
    // 文件夹类型的集合默认落在「文件树」（集合就是这个文件夹本身）。
    expect(node.querySelector('[aria-current="page"]')?.textContent).toBe('文件夹');
    // 直接打开：名字在大标题里，表格 nav 的小标题关掉（一个集合只出现一处名字）。
    expect(calls.tableProps.current?.showNavTitle).toBe(false);

    // 点击「图墙」tab：activeHostTab 落在该域的默认视图 tab（视图实例键），
    // 媒体面板挂载显示。
    const mediaTab = [...navigation!.querySelectorAll('button')].find((button) => button.textContent?.trim() === '图墙');
    await act(async () => mediaTab?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => { await Promise.resolve(); });
    expect(node.querySelector('[aria-current="page"]')?.textContent).toBe('图墙');
    expect(node.querySelector('[data-testid="media-panel"]')).not.toBeNull();
  });
});


describe('standalone asset collection files', () => {
  it.each(['column-1', 'column-2'] as const)('新建列表文件在 %s 进入集合外壳并选中列表 tab，不补写笔记域', async (host) => {
    const document = createWorkDocumentsCollection('资料 (2)');
    const source = serializeWorkDocumentsCollection(document);
    calls.read.mockResolvedValue(source);
    calls.tableProps.current = null;
    const node = globalThis.document.createElement('div');
    root = createRoot(node);
    await act(async () => root?.render(<WorkDocumentsCollectionRenderer
      surface={{ kind: 'file-work-documents', fileIdentity: { path: '/book/资料 (2).index.yaml', displayId: 'list-file' }, notebookId: 'book', notebookPath: '/book' }}
      context={{ ...context, host }}
    />));
    for (let i = 0; i < 20 && !node.querySelector('[data-testid="work-panel"]'); i++) {
      await act(async () => { await Promise.resolve(); });
    }
    expect(node.querySelector('h2')?.textContent).toBe('资料 (2)');
    expect(node.querySelector('[aria-label="集合视图"] button[aria-current="page"]')?.textContent).toBe('列表');
    expect(node.querySelector('[data-testid="work-panel"]')).not.toBeNull();
    expect(calls.tableProps.current).toBeNull();
    expect(calls.read).toHaveBeenCalledWith('/book/资料 (2).index.yaml', '/book');
  });

  it('旧单域图墙文件同样展示集合 tab，不走独立媒体库页面', async () => {
    calls.read.mockResolvedValue(serializeMediaLibrary(createMediaLibrary('图片')));
    calls.tableProps.current = null;
    const node = document.createElement('div');
    root = createRoot(node);
    await act(async () => root?.render(<MediaLibraryRenderer
      surface={{ kind: 'file-media-library', fileIdentity: { path: '/book/图片.index.yaml', displayId: 'media-file' }, notebookId: 'book', notebookPath: '/book' }}
      context={context}
    />));
    for (let i = 0; i < 20 && !node.querySelector('[data-testid="media-panel"]'); i++) {
      await act(async () => { await Promise.resolve(); });
    }
    expect(node.querySelector('h2')?.textContent).toBe('图片');
    expect(node.querySelector('[aria-label="集合视图"] button[aria-current="page"]')?.textContent).toBe('图墙');
    expect(node.querySelector('[data-testid="media-panel"]')).not.toBeNull();
    expect(calls.tableProps.current).toBeNull();
  });
});
