import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/path', () => ({ isWindowsPlatform: () => false }));
vi.mock('@features/workspace/public/surface-api', () => ({
  workspaceSurfaceUsesCollectionFrame: (kind: string | null) => kind === 'collection',
}));
vi.mock('@features/surface/public/shell-api', () => ({
  collectionIndexPath: () => '/book/folder/.index.yaml',
  WorkColumnContentHost: () => <span data-testid="surface-host"><input defaultValue="primary draft" /></span>,
}));
vi.mock('@features/document/public/shell-api', () => ({
  DocumentTitlebarMac: () => null,
  DocumentTitlebarWin: () => null,
}));
vi.mock('./browser-column', () => ({ BrowserColumn: () => <section data-testid="secondary-surface"><input defaultValue="preserved" /></section> }));
vi.mock('./work-column-titlebar', () => ({ WorkColumnTitlebar: () => null }));
vi.mock('./work-column-selection-view', () => ({ WorkColumnSelectionView: () => null }));
vi.mock('./main-layout-export-notice', () => ({ MainLayoutExportNotice: () => null }));
vi.mock('./memo-list-preview-edge-trigger', () => ({ MemoListPreviewEdgeTrigger: () => null }));
vi.mock('@shared/surface-boundary', () => ({ SurfaceBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock('@shared/ui/centered-loading-spinner', () => ({ CenteredLoadingSpinner: () => null }));

import { useWorkspaceSessionStore } from '@features/workspace/public/session-api';
import { registerCollectionBannerControl } from '@/lib/collection-banner-visibility';
import { MainWorkColumns, type MainWorkColumnsProps } from './main-work-columns';

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let disposeBanner: (() => void) | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  useWorkspaceSessionStore.getState().reset();
  disposeBanner?.();
  disposeBanner = undefined;
  host?.remove();
  host = undefined;
});

function props(): MainWorkColumnsProps {
  return {
    navigationState: { target: { kind: 'collection', filePath: '/book/folder/.index.yaml' }, phase: 'ready', showWorkColumnLoading: false } as unknown as MainWorkColumnsProps['navigationState'],
    browserColumnVisible: false,
    browserColumnLayout: { mainColumnWidth: 900, browserColumnWidth: 400 } as MainWorkColumnsProps['browserColumnLayout'],
    browserColumnLayoutKey: 'layout',
    handleBrowserColumnResize: vi.fn(),
    focusedColumnId: 'column-1',
    isMemoListHidden: false,
    isMemoListAnimating: false,
    noteNavigationPhase: 'closed',
    handleMemoListPreviewTriggerEnter: vi.fn(),
    handleMemoListPreviewTriggerLeave: vi.fn(),
    handleMemoListPreviewEnter: vi.fn(),
    hasMultipleDocumentsSelected: false,
    accessSpaceSelectionCount: 0,
    accessSpaceSelectedPaths: [],
    accessSpaceSelectionContentKinds: new Map(),
    workColumnPresentation: {
      header: { kind: 'document', document: { externalFilePath: '/book/folder/.index.yaml' } },
      chrome: 'document',
      contentKind: 'collection',
      capabilities: [],
      content: { status: 'surface', surface: { kind: 'folder-collection' } },
    } as unknown as MainWorkColumnsProps['workColumnPresentation'],
    documentTitlebarProps: {} as MainWorkColumnsProps['documentTitlebarProps'],
    canNavigateBack: false,
    canNavigateForward: false,
    handleNavigateBack: vi.fn(),
    handleNavigateForward: vi.fn(),
    handleToggleMemoList: vi.fn(),
    handleCopyLink: vi.fn(),
    handleCopyFullText: vi.fn(),
    handleExportMarkdown: vi.fn(),
    handleSaveAsTemplate: vi.fn(),
    handleExportWord: vi.fn(),
    handleExportPdf: vi.fn(),
    handleDeleteExternalFile: vi.fn(),
    mediaActions: undefined,
    activeExternalSession: null,
    selectedNotebook: null,
    recentExportPath: null,
    onDismissExportNotice: vi.fn(),
    workSurfaceBlockingLoading: false,
    notebookSwitching: false,
    language: 'zh-CN',
  } as unknown as MainWorkColumnsProps;
}

describe('MainWorkColumns collection header overlap', () => {
  it('removes the negative top margin when the collection banner is hidden', async () => {
    disposeBanner = registerCollectionBannerControl('/book/folder/.index.yaml', { visible: true, toggle: vi.fn() });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(<MainWorkColumns {...props()} />));

    const contentHost = () => host?.querySelector('[data-testid="surface-host"]')?.parentElement;
    expect(contentHost()?.style.marginTop).toBe('calc(0px - var(--window-titlebar-height))');
    expect(contentHost()?.style.getPropertyValue('--work-titlebar-h')).toBe('var(--window-titlebar-height)');

    await act(async () => {
      disposeBanner?.();
      disposeBanner = registerCollectionBannerControl('/book/folder/.index.yaml', { visible: false, toggle: vi.fn() });
    });

    expect(contentHost()?.style.marginTop).toBe('');
    expect(contentHost()?.style.getPropertyValue('--work-titlebar-h')).toBe('');
  });
});

it('keeps both column trees mounted when column 2 collapses', async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const input = { ...props(), browserColumnVisible: true };
  await act(async () => root?.render(<MainWorkColumns {...input} />));
  const primary = host.querySelector('[data-testid="surface-host"]');
  const secondary = host.querySelector('[data-testid="secondary-surface"]');
  const field = secondary?.querySelector('input');
  if (field) field.value = 'edited without saving';
  const primaryRoot = host.querySelector<HTMLElement>('[data-workspace-host="column-1"]');
  // 两个实例保持挂载，index 控制当前位置。
  expect(primaryRoot?.style.gridColumn).toBe('1');
  expect(primaryRoot?.dataset.workspaceHost).toBe('column-1');
  expect(host.querySelector('[data-testid="surface-host"]')).toBe(primary);
  expect(host.querySelector('[data-testid="secondary-surface"]')).toBe(secondary);
  expect(secondary?.querySelector('input')?.value).toBe('edited without saving');
  await act(async () => root?.render(<MainWorkColumns {...input} browserColumnVisible={false} />));
  // 收起右侧只改变可见性，不卸载实例。
  expect(primaryRoot?.style.display).toBe('');
  expect(host.querySelector('[data-testid="surface-host"]')).toBe(primary);
});

it('moves the same column DOM and preserves both drafts when indices exchange', async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<MainWorkColumns {...props()} browserColumnVisible />));
  const column = host.querySelector<HTMLElement>('[data-workspace-host="column-1"]')!;
  const primary = host.querySelector<HTMLInputElement>('[data-testid="surface-host"] input')!;
  const secondary = host.querySelector<HTMLInputElement>('[data-testid="secondary-surface"] input')!;
  primary.value = 'unsaved primary';
  secondary.value = 'unsaved secondary';
  primary.focus();

  await act(async () => useWorkspaceSessionStore.getState().swapColumnContents());

  expect(host.querySelector('[data-workspace-host="column-1"]')).toBe(column);
  expect(column.style.gridColumn).toBe('2');
  expect(column.dataset.columnIndex).toBe('1');
  expect(host.querySelector('[data-testid="surface-host"] input')).toBe(primary);
  expect(host.querySelector('[data-testid="secondary-surface"] input')).toBe(secondary);
  expect(primary.value).toBe('unsaved primary');
  expect(secondary.value).toBe('unsaved secondary');
  expect(document.activeElement).toBe(primary);

  await act(async () => root?.render(<MainWorkColumns {...props()} browserColumnVisible={false} />));
  expect(column.style.display).toBe('none');
  expect(host.querySelector('[data-testid="surface-host"] input')).toBe(primary);
  await act(async () => useWorkspaceSessionStore.getState().swapColumnContents());
  expect(column.style.gridColumn).toBe('1');
  expect(column.style.display).toBe('');
  expect(primary.value).toBe('unsaved primary');
});

describe('MainWorkColumns browser column toggle animation', () => {
  const grid = () => host!.querySelector<HTMLElement>('[data-document-columns-layout]')!;

  afterEach(() => { vi.useRealTimers(); });

  it('collapses through an animating px-track window and restores the fr template', async () => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(<MainWorkColumns {...props()} browserColumnVisible />));
    expect(grid().style.gridTemplateColumns).toBe('900px 400px');
    expect(grid().className).not.toContain('document-columns-layout--animating');

    await act(async () => root?.render(<MainWorkColumns {...props()} browserColumnVisible={false} />));
    // 收起窗口：双列 px 轨道插值到 0，过渡类挂在 grid 容器上。
    expect(grid().className).toContain('document-columns-layout--animating');
    expect(grid().style.gridTemplateColumns).toBe('1300px 0px');

    await act(async () => vi.advanceTimersByTime(200));
    // 窗口结束：回到隐藏稳态模板（视觉等宽，无跳变）。
    expect(grid().className).not.toContain('document-columns-layout--animating');
    expect(grid().style.gridTemplateColumns).toBe('minmax(0, 1fr)');
  });

  it('expands through the same animating window starting from the collapsed template', async () => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(<MainWorkColumns {...props()} />));
    expect(grid().style.gridTemplateColumns).toBe('minmax(0, 1fr)');

    await act(async () => root?.render(<MainWorkColumns {...props()} browserColumnVisible />));
    // 展开窗口：起点模板已 pin 为收起态，终点是展开 px 模板。
    expect(grid().className).toContain('document-columns-layout--animating');
    expect(grid().style.gridTemplateColumns).toBe('900px 400px');

    await act(async () => vi.advanceTimersByTime(200));
    expect(grid().className).not.toContain('document-columns-layout--animating');
    expect(grid().style.gridTemplateColumns).toBe('900px 400px');
  });
});
