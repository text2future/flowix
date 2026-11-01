import { useNotebookTreeCreation } from './use-notebook-tree-creation';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotebookDocumentCreateDialog, type NotebookDocumentCreateRequest } from './notebook-document-create-dialog';
import { createTableDocumentFile } from '@features/multidimensional-table/public/create-api';
import { createMediaLibraryFile } from '@features/media-library/model';
import { createWorkDocumentsCollectionFile } from '@features/work-documents/model';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { toast } from '@/lib/toast';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@features/multidimensional-table/public/create-api', () => ({ createTableDocumentFile: vi.fn() }));
vi.mock('@features/media-library/model', () => ({ createMediaLibraryFile: vi.fn() }));
vi.mock('@features/work-documents/model', () => ({ createWorkDocumentsCollectionFile: vi.fn() }));
vi.mock('@features/workspace/public/open-surface-api', () => ({ openWorkspaceSurface: vi.fn() }));
vi.mock('@shared/ui/dialog', () => {
  const Surface = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { Dialog: Surface, DialogContent: Surface, DialogHeader: Surface, DialogTitle: Surface, DialogDescription: Surface };
});

let host: HTMLDivElement;
let root: Root;
const notebook = { id: 'other-notebook', path: '/other' };
const onClose = vi.fn();
const tableResult = { filePath: '/other/sub/new.table.yml', relativePath: 'sub/new.table.yml', table: { collection: { id: 'collection-1' }, views: { items: [{ id: 'view-1' }] } } };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createTableDocumentFile).mockResolvedValue(tableResult as Awaited<ReturnType<typeof createTableDocumentFile>>);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(request: NotebookDocumentCreateRequest) {
  await act(async () => root.render(<NotebookDocumentCreateDialog request={request} onClose={onClose} />));
}
async function submit() {
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

describe('notebook document creation', () => {
  it.each(['table', 'calendar', 'kanban', 'gallery'] as const)('creates %s through the same collection opening flow', async (viewType) => {
    const onTableCreated = vi.fn();
    const refresh = vi.fn();
    await render({ kind: 'table', notebook, viewType, parentFolder: async () => 'sub', onTableCreated, refresh });
    await submit();
    expect(createTableDocumentFile).toHaveBeenCalledWith('/other', 'sub', `memo.create.${viewType}DefaultName`, viewType);
    expect(onTableCreated).toHaveBeenCalledWith({ relativePath: 'sub/new.table.yml', collectionId: 'collection-1', viewId: 'view-1' });
    expect(onTableCreated.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(openWorkspaceSurface).mock.invocationCallOrder[0]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(openWorkspaceSurface).toHaveBeenCalledWith(expect.objectContaining({ options: { notebookId: notebook.id }, target: expect.objectContaining({ scopePath: '/other' }) }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('creates media libraries in the resolved folder', async () => {
    vi.mocked(createMediaLibraryFile).mockResolvedValue({ filePath: '/other/library.lib.yaml', document: { collection: { id: 'library-1' } } } as Awaited<ReturnType<typeof createMediaLibraryFile>>);
    await render({ kind: 'media-library', notebook, parentFolder: () => 'media' });
    await submit();
    expect(createMediaLibraryFile).toHaveBeenCalledWith('/other', 'media', 'memo.create.mediaLibraryDefaultName');
    expect(openWorkspaceSurface).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ path: '/other/library.lib.yaml' }) }));
  });

  it('creates work documents in the resolved default folder', async () => {
    vi.mocked(createWorkDocumentsCollectionFile).mockResolvedValue({ filePath: '/other/work/.index.yaml' } as Awaited<ReturnType<typeof createWorkDocumentsCollectionFile>>);
    await render({ kind: 'work-documents', notebook, parentFolder: async () => 'work' });
    await submit();
    expect(createWorkDocumentsCollectionFile).toHaveBeenCalledWith('/other', 'work', 'memo.create.workDocuments');
  });

  it('keeps the form open and permits retry when creation fails', async () => {
    vi.mocked(createTableDocumentFile).mockRejectedValueOnce(new Error('disk full'));
    await render({ kind: 'table', notebook, parentFolder: () => '' });
    await submit();
    expect(toast.error).toHaveBeenCalledWith('disk full');
    expect(onClose).not.toHaveBeenCalled();
    expect(openWorkspaceSurface).not.toHaveBeenCalled();
    await submit();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('prevents duplicate submissions while resolving the directory', async () => {
    let resolveFolder!: (path: string) => void;
    const directory = new Promise<string>((resolve) => { resolveFolder = resolve; });
    await render({ kind: 'table', notebook, parentFolder: () => directory });
    await submit();
    await submit();
    await act(async () => resolveFolder('sub'));
    expect(createTableDocumentFile).toHaveBeenCalledOnce();
  });
});


describe('file tree creation entry points', () => {
  it('resolves the named parent folder for a new table', async () => {
    let controller!: ReturnType<typeof useNotebookTreeCreation>;
    const refreshTables = vi.fn(async () => {});
    const refreshMediaLibraries = vi.fn(async () => {});
    function Harness() {
      controller = useNotebookTreeCreation({ notebookId: notebook.id, notebookPath: notebook.path, refreshTables, refreshMediaLibraries });
      return controller.creationDialog;
    }
    await act(async () => root.render(<Harness />));
    await act(async () => controller.openNewTableDialog('/other/sub', 'gallery'));
    await submit();
    expect(createTableDocumentFile).toHaveBeenCalledWith('/other', 'sub', 'memo.create.galleryDefaultName', 'gallery');
    expect(refreshTables).toHaveBeenCalledOnce();
    expect(refreshMediaLibraries).not.toHaveBeenCalled();
    expect(host.querySelector('form')).toBeNull();
  });

  it('falls back to the notebook root when no parent folder is named', async () => {
    let controller!: ReturnType<typeof useNotebookTreeCreation>;
    function Harness() {
      controller = useNotebookTreeCreation({ notebookId: notebook.id, notebookPath: notebook.path, refreshTables: async () => {}, refreshMediaLibraries: async () => {} });
      return controller.creationDialog;
    }
    await act(async () => root.render(<Harness />));
    await act(async () => controller.openNewTableDialog(undefined, 'gallery'));
    await submit();
    expect(createTableDocumentFile).toHaveBeenCalledWith('/other', null, 'memo.create.galleryDefaultName', 'gallery');
  });
});
