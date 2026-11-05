import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ensureFileDisplayIdentity } from '@/lib/file-display-registry';
import { resolveWorkColumnPresentation, resolveWorkColumnRuntimePresentation } from '@features/surface/presentation';
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
    isMemoListHidden: false, noteNavigationVisible: false, handleToggleMemoList: vi.fn(), canNavigateBack: false,
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
