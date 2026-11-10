import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ensureFileDisplayIdentity } from '@/lib/file-display-registry';
import { resolveWorkColumnPresentation, resolveWorkColumnRuntimePresentation, type WorkColumnPresentation } from '@features/surface/presentation';
import { workspaceSurfaceContentPresentation } from '@features/workspace/public/surface-api';
import { useDocumentTitlebarProps, type UseDocumentTitlebarPropsInput } from './use-document-titlebar-props';

vi.mock('@features/workspace/public/session-header-api', () => ({ useSessionAddressBar: () => ({ visible: false, toggle: undefined }) }));

it.each(['note', 'collection'] as const)('derives primary file-browser %s menus from their own notebook context', async (kind) => {
  const path = kind === 'collection' ? '/other/folder/.index.yaml' : '/other/note.md';
  const fileIdentity = ensureFileDisplayIdentity(path);
  const presentation = resolveWorkColumnPresentation({
    navigation: { phase: 'committed', showWorkColumnLoading: false, requestId: 1,
      target: { kind: 'file-browser', activeFilePath: path, folderPath: '/other', scopePath: '/other', notebookId: 'other',
        fileTreeVisible: true, fileTreeWidth: 220, collectionType: kind === 'collection' ? 'table' : undefined },
      pendingTarget: null, previousTarget: null, failure: null, retryToken: null },
    document: null, emptyMessage: 'Empty',
  });
  const runtime = workspaceSurfaceContentPresentation(kind === 'collection' ? 'file-table' : 'file-markdown');
  const effective = resolveWorkColumnRuntimePresentation(presentation, runtime, null);
  const remove = vi.fn().mockResolvedValue(undefined);
  const input: UseDocumentTitlebarPropsInput = {
    workColumnPresentation: presentation, workRuntimePresentation: runtime, workCapabilities: effective.capabilities,
    workHeaderStyle: effective.chrome, browserColumnVisible: true, mainEditorMode: 'rich', handleSetMainEditorMode: vi.fn(),
    isMemoListHidden: false, handleToggleMemoList: vi.fn(), canNavigateBack: false,
    canNavigateForward: false, handleNavigateBack: vi.fn(), handleNavigateForward: vi.fn(), handleCopyLink: vi.fn(),
    handleCopyFullText: vi.fn(), handleExportMarkdown: vi.fn(), handleSaveAsTemplate: vi.fn(), handleExportWord: vi.fn(),
    handleExportPdf: vi.fn(), handleDeleteExternalFile: remove, mediaActions: undefined, activeExternalSession: null,
    selectedNotebook: { id: 'primary', path: '/primary' } as UseDocumentTitlebarPropsInput['selectedNotebook'],
  };
  let result: ReturnType<typeof useDocumentTitlebarProps> | undefined;
  function Probe() { result = useDocumentTitlebarProps(input); return null; }
  const node = document.createElement('div'); const root = createRoot(node);
  try {
    await act(async () => root.render(<Probe />));
    expect(result!.document).toMatchObject({ isolated: true, target: { fileIdentity,
      scopePath: '/other', notebookId: 'other', isOutsideCurrentNotebook: false } });
    // 集合有自己的 tab 外壳，标题栏保留集合标题，不出面包屑。
    expect(result!.breadcrumb).toEqual(kind === 'collection' ? null : [
      { label: 'other', path: '/other', type: 'folder' },
      { label: 'note', path: '/other/note.md', type: 'file' },
    ]);
    if (kind === 'collection') {
      expect(result!.collectionDisplay).toEqual({ indexPath: path, notebookPath: '/other', notebookId: 'other' });
    } else {
      expect(result!.document.target?.indexable).toBe(true);
      expect(result!.contentCapabilities.versionHistory).toBe(true);
      expect(result!.showEditorModeToggle).toBe(true);
    }
    result!.actions.onDeleteExternalFile();
    expect(remove).toHaveBeenCalledExactlyOnceWith(path, '/other');
  } finally { await act(async () => root.unmount()); }
});

it('falls back to the owning notebook when a file-browser surface has no scopePath', async () => {
  // 文件树/访问空间打开的笔记：surface 的 scopePath 为空，且当前选中的是别的笔记本。
  const path = '/notebooks/小红书运营知识库/08 原则/番茄笔记.md';
  const fileIdentity = ensureFileDisplayIdentity(path);
  const presentation = {
    header: { kind: 'document', document: { externalFilePath: path } },
    chrome: 'document', contentKind: 'file-markdown', capabilities: [],
    content: { status: 'surface', surface: {
      kind: 'file-browser', instanceKey: fileIdentity.displayId, fileIdentity, activeFilePath: path,
      folderPath: '/notebooks/小红书运营知识库/08 原则', scopePath: null, notebookId: null,
      fileTreeVisible: true, fileTreeWidth: 220,
    } },
  } as unknown as WorkColumnPresentation;
  const runtime = workspaceSurfaceContentPresentation('file-markdown');
  const input: UseDocumentTitlebarPropsInput = {
    workColumnPresentation: presentation, workRuntimePresentation: runtime, workCapabilities: [],
    workHeaderStyle: 'document', browserColumnVisible: true, mainEditorMode: 'rich', handleSetMainEditorMode: vi.fn(),
    isMemoListHidden: false, handleToggleMemoList: vi.fn(), canNavigateBack: false,
    canNavigateForward: false, handleNavigateBack: vi.fn(), handleNavigateForward: vi.fn(), handleCopyLink: vi.fn(),
    handleCopyFullText: vi.fn(), handleExportMarkdown: vi.fn(), handleSaveAsTemplate: vi.fn(), handleExportWord: vi.fn(),
    handleExportPdf: vi.fn(), handleDeleteExternalFile: vi.fn().mockResolvedValue(undefined), mediaActions: undefined,
    activeExternalSession: null,
    selectedNotebook: { id: 'other', path: '/notebooks/其他库' } as UseDocumentTitlebarPropsInput['selectedNotebook'],
    notebooks: [{ path: '/notebooks/小红书运营知识库' }, { path: '/notebooks/其他库' }],
  };
  let result: ReturnType<typeof useDocumentTitlebarProps> | undefined;
  function Probe() { result = useDocumentTitlebarProps(input); return null; }
  const node = document.createElement('div'); const root = createRoot(node);
  try {
    await act(async () => root.render(<Probe />));
    expect(result!.breadcrumb).toEqual([
      { label: '小红书运营知识库', path: '/notebooks/小红书运营知识库', type: 'folder' },
      { label: '08 原则', path: '/notebooks/小红书运营知识库/08 原则', type: 'folder' },
      { label: '番茄笔记', path, type: 'file' },
    ]);
  } finally { await act(async () => root.unmount()); }
});

it('derives the notebook path breadcrumb for a note opened from the access space', async () => {
  // 访问空间打开笔记：target 是 external，scopePath 就是笔记本路径。
  const path = '/book/sub/note.md';
  const fileIdentity = ensureFileDisplayIdentity(path);
  const presentation = {
    header: { kind: 'document', document: { externalFilePath: path } },
    chrome: 'document', contentKind: 'file-markdown', capabilities: [],
    content: { status: 'surface', surface: { kind: 'md', instanceKey: fileIdentity.displayId, fileIdentity, props: {} } },
  } as unknown as WorkColumnPresentation;
  const runtime = workspaceSurfaceContentPresentation('file-markdown');
  const remove = vi.fn().mockResolvedValue(undefined);
  const input: UseDocumentTitlebarPropsInput = {
    workColumnPresentation: presentation, workRuntimePresentation: runtime, workCapabilities: [],
    workHeaderStyle: 'document', browserColumnVisible: true, mainEditorMode: 'rich', handleSetMainEditorMode: vi.fn(),
    isMemoListHidden: false, handleToggleMemoList: vi.fn(), canNavigateBack: false,
    canNavigateForward: false, handleNavigateBack: vi.fn(), handleNavigateForward: vi.fn(), handleCopyLink: vi.fn(),
    handleCopyFullText: vi.fn(), handleExportMarkdown: vi.fn(), handleSaveAsTemplate: vi.fn(), handleExportWord: vi.fn(),
    handleExportPdf: vi.fn(), handleDeleteExternalFile: remove, mediaActions: undefined,
    activeExternalSession: { fileIdentity, scopePath: '/book', notebookId: 'book', notebookPath: '/book',
      relativePath: 'sub/note.md', indexable: true, openedAt: 0, transitionId: 0 },
    selectedNotebook: { id: 'book', path: '/book' } as UseDocumentTitlebarPropsInput['selectedNotebook'],
  };
  let result: ReturnType<typeof useDocumentTitlebarProps> | undefined;
  function Probe() { result = useDocumentTitlebarProps(input); return null; }
  const node = document.createElement('div'); const root = createRoot(node);
  try {
    await act(async () => root.render(<Probe />));
    // markdown 不上报标题，面包屑必须是 header 身份的唯一来源。
    expect(result!.navigation.title).toBeUndefined();
    expect(result!.breadcrumb).toEqual([
      { label: 'book', path: '/book', type: 'folder' },
      { label: 'sub', path: '/book/sub', type: 'folder' },
      { label: 'note', path: '/book/sub/note.md', type: 'file' },
    ]);
  } finally { await act(async () => root.unmount()); }
});
