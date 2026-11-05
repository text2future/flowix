import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceLifecycle } from '@features/workspace/public/surface-api';
import { createMediaLibrary, serializeMediaLibrary } from './model';
import { MediaLibraryView } from './media-library-view';

type ListActions = {
  onMediaLibraryFilterChange: (filter: { file_type: 'image' }) => Promise<boolean>;
  onAddMedia: () => Promise<boolean>;
  listContext: { mediaScope?: { relativePath: string; depth: string } };
  mediaLibraryRecords: Array<{ relative_path: string }>;
};
const mocks = vi.hoisted(() => ({
  read: vi.fn(), write: vi.fn(), importFiles: vi.fn(),
  actions: null as ListActions | null,
  subscriptions: [] as Array<{ event: string; handler: (event: never) => void }>,
}));
vi.mock('@platform/tauri/client', () => ({
  files: { read: mocks.read }, externalDocuments: { read: mocks.read, write: mocks.write },
  dialogs: { selectFiles: async () => ['/source/image.png'] }, mediaResources: {}, notebookAssets: {},
}));
vi.mock('@platform/tauri/event-bus', () => ({
  subscribe: (event: string, handler: (event: never) => void) => {
    const subscription = { event, handler };
    mocks.subscriptions.push(subscription);
    return () => { mocks.subscriptions = mocks.subscriptions.filter((item) => item !== subscription); };
  },
}));
vi.mock('@features/collection/public/folder-api', async (importOriginal) => ({
  // 取值范围换算（resolveCollectionScope）保持真实实现：它决定媒体记录过滤，用假的会掩盖问题。
  ...(await importOriginal<typeof import('@features/collection/public/folder-api')>()),
  FolderCollectionSwitchConfirmDialog: () => null,
}));
vi.mock('@features/memo/store/note-store', () => ({
  useNoteStore: (select: (state: { notebooks: unknown[] }) => unknown) => select({ notebooks: [] }),
}));
vi.mock('@features/surface/document-list-view', () => ({
  DocumentListView: (props: ListActions) => { mocks.actions = props; return null; },
}));
vi.mock('./rename-media-library', () => ({ renameMediaLibrary: vi.fn() }));
vi.mock('./media-import', () => ({ importMediaLibraryFiles: mocks.importFiles }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

let root: Root;
let container: HTMLDivElement;
let lifecycle: SurfaceLifecycle | null;
const register = (value: SurfaceLifecycle | null) => { lifecycle = value; };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.subscriptions = [];
  mocks.read.mockResolvedValue(serializeMediaLibrary(createMediaLibrary('Library')));
  mocks.write.mockImplementation(async ({ content }: { content: string }) => ({ status: 'saved', content }));
  lifecycle = null;
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(<MediaLibraryView filePath="/book/library.lib.yaml"
    notebookPath="/book" notebookId="book" onSurfaceLifecycleReady={register} />));
});
afterEach(async () => { await act(async () => root.unmount()); });

describe('media library surface save barrier', () => {
  it('shows refresh failures, keeps the view mounted, and retries the latest path', async () => {
    const failure = new Error('temporary disk read failure');
    mocks.read.mockRejectedValueOnce(failure);
    const collectionChanged = mocks.subscriptions.find((item) => item.event === 'collection-changed');
    expect(collectionChanged).toBeDefined();

    await act(async () => {
      collectionChanged!.handler({ notebookId: 'book', relativePath: 'library.lib.yaml' } as never);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('errors.friendly.mediaRefresh');
    expect(container.textContent).not.toContain('temporary disk read failure');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'error.retry');
    expect(retry).toBeDefined();
    await act(async () => {
      retry!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('errors.friendly.mediaRefresh');
    expect(mocks.read).toHaveBeenCalledWith('/book/library.lib.yaml', '/book');
  });

  it('ignores a refresh failure after the surface changes to another session', async () => {
    let rejectRead!: (reason: Error) => void;
    mocks.read.mockReturnValueOnce(new Promise<string>((_resolve, reject) => { rejectRead = reject; }));
    const collectionChanged = mocks.subscriptions.find((item) => item.event === 'collection-changed');
    expect(collectionChanged).toBeDefined();
    act(() => {
      collectionChanged!.handler({ notebookId: 'book', relativePath: 'library.lib.yaml' } as never);
    });

    await act(async () => root.render(<MediaLibraryView filePath="/book/next.lib.yaml"
      notebookPath="/book" notebookId="book" onSurfaceLifecycleReady={register} />));
    await act(async () => {
      rejectRead(new Error('stale session failure'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('stale session failure');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('returns false for a failed config write and permits a successful retry', async () => {
    const write = deferred<{ status: 'error'; message: string }>();
    mocks.write.mockReturnValueOnce(write.promise);
    let operation!: Promise<boolean>;
    act(() => { operation = mocks.actions!.onMediaLibraryFilterChange({ file_type: 'image' }); });
    const flush = lifecycle!.flush!();
    let finished = false;
    void flush.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    await act(async () => { write.resolve({ status: 'error', message: 'write failed' }); await operation; });
    await expect(flush).resolves.toBe(false);
    await expect(lifecycle!.flush!()).resolves.toBe(false);
    await act(async () => { expect(await mocks.actions!.onMediaLibraryFilterChange({ file_type: 'image' })).toBe(true); });
    await expect(lifecycle!.flush!()).resolves.toBe(true);
  });

  it('waits for the import transaction after its nested configuration write completes', async () => {
    const tail = deferred<void>();
    mocks.importFiles.mockImplementation(async ({ persist }: { persist: (mutate: (value: ReturnType<typeof createMediaLibrary>) => ReturnType<typeof createMediaLibrary>) => Promise<boolean> }) => {
      await persist((current) => current);
      await tail.promise;
      return { completed: ['image.png'], failed: 0, recordSaveFailed: false, cleanupFailed: 0 };
    });
    let operation!: Promise<boolean>;
    await act(async () => { operation = mocks.actions!.onAddMedia(); });
    expect(mocks.write).toHaveBeenCalledOnce();
    const flush = lifecycle!.flush!();
    let finished = false;
    void flush.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    await act(async () => { tail.resolve(); await operation; });
    await expect(flush).resolves.toBe(true);
  });
});

it('switching asset tabs uses the selected view filter without rewriting the default', async () => {
  const document = createMediaLibrary('Library');
  const first = document.views.items[0];
  document.views.items.push({ ...first, id: `view_${'b'.repeat(32)}`, name: 'Videos',
    filter: { all: [{ field: 'kind', op: 'eq', value: 'video' }], any: [] } });
  mocks.read.mockResolvedValue(serializeMediaLibrary(document));
  await act(async () => { root.unmount(); root = createRoot(container); root.render(<MediaLibraryView
    filePath="/book/library.lib.yaml" notebookPath="/book" notebookId="book" activeViewId={first.id} />); });
  expect((mocks.actions as unknown as { mediaLibraryViewFilter: unknown }).mediaLibraryViewFilter).toEqual(first.filter);
  await act(async () => root.render(<MediaLibraryView filePath="/book/library.lib.yaml" notebookPath="/book" notebookId="book"
    activeViewId={document.views.items[1].id} />));
  expect((mocks.actions as unknown as { mediaLibraryViewFilter: unknown }).mediaLibraryViewFilter).toEqual(document.views.items[1].filter);
  expect(mocks.write).not.toHaveBeenCalled();
});
it('read-only media rejects mutations even when handlers are called directly', async () => {
  await act(async () => root.render(<MediaLibraryView filePath="/book/library.lib.yaml"
    notebookPath="/book" notebookId="book" editable={false} />));
  expect(await mocks.actions!.onAddMedia()).toBe(false);
  expect(await mocks.actions!.onMediaLibraryFilterChange({ file_type: 'image' })).toBe(false);
  expect((mocks.actions as unknown as { libraryActionsDisabled: boolean }).libraryActionsDisabled).toBe(true);
  expect(mocks.write).not.toHaveBeenCalled();
  expect(mocks.importFiles).not.toHaveBeenCalled();
});

it('pushes the standalone selected directory into paged gallery reads', async () => {
  const document = createMediaLibrary('Gallery');
  document.dataset.source = { scope: 'folder', path: 'Old' };
  document.dataset.filter = { path: 'New', match: 'all', conditions: [] };
  mocks.read.mockResolvedValue(serializeMediaLibrary(document));
  await act(async () => root.render(<MediaLibraryView filePath="/book/Views/gallery.index.yaml" notebookPath="/book" notebookId="book" />));
  expect(mocks.actions?.listContext.mediaScope).toEqual({ relativePath: 'New', depth: 'descendants' });
});

it('reads descendant media from an old moved folder collection', async () => {
  const document = createMediaLibrary('Gallery');
  document.collection.placement = 'folder';
  document.dataset.source = { scope: 'containing_folder' };
  document.dataset.filter = { path: 'Old', match: 'all', conditions: [] };
  document.dataset.records.include = [{ id: `rec_${'a'.repeat(32)}`, updated_at: new Date().toISOString(), resource_id: 'book::New/sub/a.png', relative_path: 'New/sub/a.png' }];
  mocks.read.mockResolvedValue(serializeMediaLibrary(document));
  await act(async () => root.render(<MediaLibraryView filePath="/book/New/.index.yaml" notebookPath="/book" notebookId="book" />));
  expect(mocks.actions?.listContext.mediaScope).toEqual({ relativePath: 'New', depth: 'descendants' });
  expect(mocks.actions?.mediaLibraryRecords.map((record) => record.relative_path)).toEqual(['New/sub/a.png']);
});
