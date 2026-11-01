import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/path', () => ({ isWindowsPlatform: () => false }));
vi.mock('@features/workspace/public/surface-api', () => ({
  workspaceSurfaceUsesCollectionFrame: (kind: string | null) => kind === 'collection',
}));
vi.mock('@features/surface/public/shell-api', () => ({
  collectionIndexPath: () => '/book/folder/.index.yaml',
  WorkColumnContentHost: () => <span data-testid="surface-host" />,
}));
vi.mock('@features/document/public/shell-api', () => ({
  DocumentTitlebarMac: () => null,
  DocumentTitlebarWin: () => null,
}));
vi.mock('./work-column-titlebar', () => ({ WorkColumnTitlebar: () => null }));
vi.mock('./work-column-selection-view', () => ({ WorkColumnSelectionView: () => null }));
vi.mock('./main-layout-export-notice', () => ({ MainLayoutExportNotice: () => null }));
vi.mock('./memo-list-preview-edge-trigger', () => ({ MemoListPreviewEdgeTrigger: () => null }));
vi.mock('@shared/surface-boundary', () => ({ SurfaceBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock('@shared/ui/centered-loading-spinner', () => ({ CenteredLoadingSpinner: () => null }));

import { registerCollectionBannerControl } from '@/lib/collection-banner-visibility';
import { MainWorkColumns, type MainWorkColumnsProps } from './main-work-columns';

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let disposeBanner: (() => void) | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
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
    toolbarCollapsed: false,
    setToolbarCollapsed: vi.fn(),
    focusedHostId: 'main-third',
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
    defaultCreateFolderState: null,
    defaultCreateFolder: null,
    handleToggleDefaultFolder: vi.fn(),
    handleSwitchFolderCollectionType: vi.fn(),
    activeExternalSession: null,
    selectedNotebook: null,
    recentExportPath: null,
    onDismissExportNotice: vi.fn(),
    isDocumentTransitioning: false,
    workSurfaceBlockingLoading: false,
    workSurfaceFailed: false,
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
    expect(contentHost()?.style.marginTop).toBe('-3rem');
    expect(contentHost()?.style.getPropertyValue('--work-titlebar-h')).toBe('3rem');

    await act(async () => {
      disposeBanner?.();
      disposeBanner = registerCollectionBannerControl('/book/folder/.index.yaml', { visible: false, toggle: vi.fn() });
    });

    expect(contentHost()?.style.marginTop).toBe('');
    expect(contentHost()?.style.getPropertyValue('--work-titlebar-h')).toBe('');
  });
});
