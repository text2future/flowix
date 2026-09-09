import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { FileBrowserView, type FileBrowserViewSurface } from './file-browser-view';
import { useAgentAccessStore } from '@features/agent/store/agent-access-store';
import { useMemoStore } from '@features/memo/store';

const probe = vi.hoisted(() => ({ mounts: 0, scope: null as string | null, flush: vi.fn().mockResolvedValue(true) }));
vi.mock('@features/document/components/document-container', () => ({
  DocumentContainer: ({ externalScopePath, onFlushReady }: { externalScopePath: string | null; onFlushReady?: (flush: (() => Promise<boolean>) | null) => void }) => {
    probe.scope = externalScopePath;
    useEffect(() => { probe.mounts++; }, []);
    useEffect(() => { onFlushReady?.(probe.flush); return () => onFlushReady?.(null); }, [onFlushReady]);
    return <textarea defaultValue="unsaved draft" />;
  },
}));
vi.mock('@features/memo/components/folder-file-tree', () => ({
  FolderFileTree: ({ folderPath, onFileSelect, onFileOpenInNewTab }: {
    folderPath: string; onFileSelect: (path: string) => void; onFileOpenInNewTab: (path: string) => void;
  }) => <div data-tree-root={folderPath}>
    <button onClick={() => onFileSelect(`${folderPath}/next.md`)}>select file</button>
    <button onClick={() => onFileOpenInNewTab(`${folderPath}/next.md`)}>new tab</button>
  </div>,
}));
vi.mock('@features/memo/components/use-folder-tree', () => ({ useFolderTree: () => ({ refreshDirectories: vi.fn() }) }));
vi.mock('@platform/tauri/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@platform/tauri/client')>(),
  files: { watchRoot: vi.fn().mockResolvedValue('lease'), unwatchRoot: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: () => () => {} }));

it('derives the tree from the owning notebook without remounting or changing file access scope', async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const previousConfig = useAgentAccessStore.getState().config;
  const previousNotebookId = useMemoStore.getState().selectedNotebookId;
  useAgentAccessStore.setState({ config: { version: 1, entries: [], defaults: {} }, notebookConfigs: {} });
  probe.mounts = 0;
  const element = document.createElement('div');
  const root = createRoot(element);
  const flushReady = vi.fn();
  const surface: FileBrowserViewSurface = {
    kind: 'file-browser', activeFilePath: '/workspace/src/a.md', folderPath: null, notebookId: 'owner',
    scopePath: '/granted-scope', fileTreeVisible: true, fileTreeWidth: 220,
    documentProps: { filePath: '/workspace/src/a.md', isExternalDocument: true, onFlushReady: flushReady },
    onSelectFile: vi.fn(), onSelectFolder: vi.fn(), onOpenFileInNewTab: vi.fn(),
    onContextChange: vi.fn(), onTreeVisibleChange: vi.fn(), onTreeWidthChange: vi.fn(),
  };
  try {
    await act(async () => root.render(<FileBrowserView surface={surface} />));
    const editor = element.querySelector('textarea');
    expect(editor).not.toBeNull();
    expect(element.querySelector('[data-tree-root]')).toBeNull();
    expect(flushReady).toHaveBeenCalledWith(probe.flush);
    await act(async () => useAgentAccessStore.setState({
      config: { version: 1, entries: [
        { id: 'src', kind: 'folder', path: '/workspace/src', name: 'src', enabled: true, workspace: false, missing: false, addedAt: 0, updatedAt: 0 },
      ], defaults: {} },
      notebookConfigs: { owner: { version: 1, revision: 1, addDirs: [
        { id: 'src', path: '/workspace/src', label: 'src', enabled: true },
      ] } },
    }));
    expect(element.querySelector('[data-tree-root]')?.getAttribute('data-tree-root')).toBe('/workspace/src');
    await act(async () => useMemoStore.setState({ selectedNotebookId: 'unrelated' }));
    expect(element.querySelector('[data-tree-root]')?.getAttribute('data-tree-root')).toBe('/workspace/src');
    const fileButton = Array.from(element.querySelectorAll('button')).find((button) => button.textContent === 'select file');
    await act(async () => fileButton?.click());
    expect(surface.onSelectFile).toHaveBeenCalledWith('/workspace/src/next.md');
    await act(async () => root.render(<FileBrowserView surface={{ ...surface, fileTreeVisible: false }} />));
    expect(element.querySelector('[data-tree-root]')).toBeNull();
    expect(element.querySelector('[title="展开文件树"]')).not.toBeNull();
    await act(async () => useAgentAccessStore.setState({ config: { version: 1, entries: [], defaults: {} }, notebookConfigs: {} }));
    expect(element.querySelector('[title="展开文件树"]')).toBeNull();
    expect(element.querySelector('textarea')).toBe(editor);
    expect(editor?.value).toBe('unsaved draft');
    expect(probe.mounts).toBe(1);
    expect(probe.scope).toBe('/granted-scope');
  } finally {
    await act(async () => root.unmount());
    useAgentAccessStore.setState({ config: previousConfig });
    useMemoStore.setState({ selectedNotebookId: previousNotebookId });
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  }
});
