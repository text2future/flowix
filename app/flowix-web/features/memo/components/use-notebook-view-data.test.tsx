import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaLibraryListItem, TableDocumentListItem } from '@platform/tauri/client';

const mocks = vi.hoisted(() => ({
  tables: vi.fn(),
  libraries: vi.fn(),
  ignorePaths: vi.fn(() => false),
  handlers: new Map<string, (payload: unknown) => void>(),
}));
vi.mock('@platform/tauri/client', () => ({
  files: { listTableDocuments: mocks.tables, listMediaLibraries: mocks.libraries },
}));
vi.mock('@platform/tauri/event-bus', () => ({
  subscribe: (name: string, handler: (payload: unknown) => void) => {
    mocks.handlers.set(name, handler);
    return () => { mocks.handlers.delete(name); };
  },
}));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));

import { useNotebookViewData } from './use-notebook-view-data';

const table: TableDocumentListItem = {
  collectionId: 'table', relativePath: 'Table.flowix', name: 'Table',
  modifiedMs: 1, fileRevision: 1, inViews: true,
};
const library: MediaLibraryListItem = {
  collectionId: 'library', relativePath: 'Library.media', name: 'Library',
  modifiedMs: 1, inViews: true,
};

let root: Root;
let latest: ReturnType<typeof useNotebookViewData> | null;

function Harness({ notebookId }: { notebookId: string }) {
  latest = useNotebookViewData({
    notebookId, notebookPath: `/notes/${notebookId}`, isActive: true,
    refreshTrigger: 0, ignoreCollectionPathEvents: mocks.ignorePaths,
  });
  return null;
}
function data() {
  if (!latest) throw new Error('Harness is not mounted');
  return latest;
}
async function render(notebookId = 'nb-1') {
  await act(async () => root.render(createElement(Harness, { notebookId })));
}
async function emit(name: string, payload: unknown) {
  await act(async () => mocks.handlers.get(name)?.(payload));
}

describe('notebook view catalogs', () => {
  beforeEach(() => {
    mocks.tables.mockReset().mockResolvedValue([table]);
    mocks.libraries.mockReset().mockResolvedValue([library]);
    mocks.ignorePaths.mockReset().mockReturnValue(false);
    mocks.handlers.clear();
    latest = null;
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    expect(mocks.handlers.size).toBe(0);
    document.body.replaceChildren();
  });

  it('routes refresh events by notebook and directory, with independent catalog failures', async () => {
    await render();
    await emit('file-management-changed', { notebookId: 'other' });
    expect(mocks.tables).toHaveBeenCalledTimes(1);
    mocks.tables.mockRejectedValueOnce(new Error('table catalog unavailable'));
    mocks.libraries.mockResolvedValueOnce([{ ...library, name: 'Updated library' }]);
    await emit('file-management-changed', { notebookId: 'nb-1' });
    expect(data().tableDocuments).toEqual([table]);
    expect(data().mediaLibraries[0].name).toBe('Updated library');

    await emit('file-browser-directories-changed', { rootPath: '/other', paths: [] });
    mocks.ignorePaths.mockReturnValueOnce(true);
    await emit('file-browser-directories-changed', { rootPath: '/notes/nb-1', paths: ['rename-temp'] });
    expect(mocks.tables).toHaveBeenCalledTimes(2);
    await emit('file-browser-directories-changed', { rootPath: '/notes/nb-1', paths: ['changed'] });
    expect(mocks.tables).toHaveBeenCalledTimes(3);
    expect(mocks.libraries).toHaveBeenCalledTimes(3);
  });

  it('keeps collection event ordering and applies regenerated identities locally', async () => {
    await render();
    const change = {
      notebookId: 'nb-1', collectionId: 'table', relativePath: 'Renamed.flowix',
      name: 'Renamed', revision: 2, indexSequence: 5,
    };
    await emit('collection-changed', change);
    await emit('collection-changed', { ...change, name: 'Stale', indexSequence: 4 });
    await emit('collection-changed', { ...change, notebookId: 'other', name: 'Other', indexSequence: 6 });
    expect(data().tableDocuments[0]).toMatchObject({ name: 'Renamed', fileRevision: 2 });
    expect(data().mediaLibraries).toEqual([library]);

    await act(async () => {
      data().updateTableIdentity('Renamed.flowix', 'new-table');
      data().updateMediaLibraryIdentity('Library.media', 'new-library');
    });
    expect(data().tableDocuments[0]).toMatchObject({ collectionId: 'new-table', identityConflict: false });
    expect(data().mediaLibraries[0]).toMatchObject({ collectionId: 'new-library', identityConflict: false });
  });

  it('ignores late initial snapshots after switching notebooks', async () => {
    let resolveTables!: (items: TableDocumentListItem[]) => void;
    let resolveLibraries!: (items: MediaLibraryListItem[]) => void;
    mocks.tables.mockReturnValueOnce(new Promise<TableDocumentListItem[]>((resolve) => { resolveTables = resolve; }));
    mocks.libraries.mockReturnValueOnce(new Promise<MediaLibraryListItem[]>((resolve) => { resolveLibraries = resolve; }));
    await render();
    mocks.tables.mockResolvedValueOnce([{ ...table, name: 'Second notebook table' }]);
    mocks.libraries.mockResolvedValueOnce([{ ...library, name: 'Second notebook library' }]);
    await render('nb-2');
    await act(async () => {
      resolveTables([table]);
      resolveLibraries([library]);
    });
    expect(data().tableDocuments[0].name).toBe('Second notebook table');
    expect(data().mediaLibraries[0].name).toBe('Second notebook library');
  });
});
