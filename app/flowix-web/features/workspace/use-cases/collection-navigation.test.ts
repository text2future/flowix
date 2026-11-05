import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTableDocument, parseTableDocument, serializeTableDocument } from '@features/multidimensional-table/model';
import { createMediaLibrary, serializeMediaLibrary } from '@features/media-library/model';
import { ensureCollectionDisplay, reconcileCollectionDisplays } from '@/lib/collection-display-registry';
import { collectionDisplayName } from '@features/collection/model';
import { workColumnTargetFilePath } from '../store/work-column-target';
import { resolveWorkColumnContent } from '@features/surface/resolver';
import { useWorkColumnStore } from '../store/work-column-store';
import { useBrowserColumnStore } from '../store/browser-column-store';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), read: vi.fn(), write: vi.fn(), getAll: vi.fn(), clear: vi.fn(async () => {}) }));
vi.mock('@platform/tauri/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@platform/tauri/client')>(),
  collections: { resolve: mocks.resolve }, externalDocuments: { read: mocks.read, write: mocks.write }, notebooks: { getAll: mocks.getAll },
}));
vi.mock('@features/memo/public/workspace-api', () => ({ getWorkspaceMemoState: () => ({ notebooks: [{ id: 'book', path: '/book' }] }) }));
vi.mock('@features/document/public/workspace-api', () => ({
  getWorkspaceDocumentState: () => ({ activeExternalSession: null, activeAgentConversationId: null, clearDocument: mocks.clear }),
  recordWorkspaceDocumentNavigation: vi.fn(),
}));
import { openCollectionTarget, openContentleTarget, openFolderCollection, resetCurrentCollectionView } from './workspace-navigation';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAll.mockResolvedValue([{ id: 'book', path: '/book' }]);
  useBrowserColumnStore.getState().reset();
  const store = useWorkColumnStore.getState();
  store.commitNavigation(store.beginNavigation({ kind: 'empty' }, null), { kind: 'empty' });
});
afterEach(() => reconcileCollectionDisplays([]));

it('opens a table with a deleted reference view so the table can apply its fallback policy', async () => {
  const document = createTableDocument();
  mocks.resolve.mockResolvedValue({ relativePath: 'table.yaml', parseState: 'valid', collectionType: 'table', name: 'Table', indexSequence: 1 });
  mocks.read.mockResolvedValue(serializeTableDocument(document));
  await openCollectionTarget({ notebookId: 'book', collectionId: document.collection.id, viewId: 'deleted-view' });
  const target = useWorkColumnStore.getState().navigation.target;
  expect(target).toMatchObject({ kind: 'collection', viewId: 'deleted-view', filePath: '/book/table.yaml' });
  expect(target).not.toHaveProperty('unavailableReason');
});

it('commits the latest view when a second request arrives during loading', async () => {
  const document = createTableDocument();
  const firstView = document.views.items[0];
  document.views.items.push({ ...firstView, id: 'view_11111111111111111111111111111111', name: 'Second' });
  mocks.read.mockResolvedValue(serializeTableDocument(document));
  const item = { relativePath: 'table.yaml', parseState: 'valid', collectionType: 'table', name: 'Table', indexSequence: 1 };
  let release!: (value: typeof item) => void;
  mocks.resolve.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })).mockResolvedValue(item);
  const reference = { notebookId: 'book', collectionId: document.collection.id };
  const first = openCollectionTarget({ ...reference, viewId: firstView.id });
  await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1));
  await openCollectionTarget({ ...reference, viewId: 'view_11111111111111111111111111111111' });
  const latest = useWorkColumnStore.getState().navigation.target;
  expect(latest).toMatchObject({ kind: 'collection', viewId: 'view_11111111111111111111111111111111' });
  release(item);
  await first;
  expect(useWorkColumnStore.getState().navigation.target).toEqual(latest);
});

it('re-resolves an explicit main-column open after collection type changes and resets its view', async () => {
  const media = createMediaLibrary('Media');
  const display = ensureCollectionDisplay({ notebookId: 'book', collectionId: media.collection.id, viewId: 'old-table-view' });
  const target = { kind: 'collection' as const, ...display, filePath: '/book/.index.yaml', notebookPath: '/book', collectionType: 'table' as const, name: 'Table' };
  const store = useWorkColumnStore.getState();
  store.commitNavigation(store.beginNavigation(target, null), target);
  mocks.resolve.mockResolvedValue({ relativePath: '.index.yaml', parseState: 'valid', collectionType: 'media_library', name: 'Media', indexSequence: 1 });
  mocks.read.mockResolvedValue(serializeMediaLibrary(media));
  await openCollectionTarget({ ...display, viewId: null }, { destination: 'column-1', history: 'skip' });
  expect(mocks.resolve).toHaveBeenCalledTimes(1);
  expect(useWorkColumnStore.getState().navigation.target).toMatchObject({ displayId: display.displayId, collectionType: 'media_library', viewId: null });
});

it('revalidates an unavailable collection without clearing an identity conflict', async () => {
  const display = ensureCollectionDisplay({ notebookId: 'book', collectionId: 'conflicted', viewId: 'old' });
  const target = { kind: 'collection' as const, ...display, filePath: '/book/table.yaml', notebookPath: '/book', collectionType: 'table' as const, name: 'Table', unavailableReason: '集合身份冲突或格式暂不可用' };
  const store = useWorkColumnStore.getState();
  store.commitNavigation(store.beginNavigation(target, null), target);
  mocks.resolve.mockResolvedValue({ relativePath: 'table.yaml', parseState: 'valid', identityConflict: true, collectionType: 'table', name: 'Table', indexSequence: 1 });
  await openCollectionTarget({ ...display, viewId: 'another' });
  expect(mocks.resolve).toHaveBeenCalledTimes(1);
  expect(mocks.read).not.toHaveBeenCalled();
  expect(useWorkColumnStore.getState().navigation.target).toMatchObject({ unavailableReason: '集合身份冲突，请先为副本生成新 ID' });
});

it('retains the selected file when a previously resolved collection disappears from the index', async () => {
  const document = createTableDocument();
  mocks.resolve.mockResolvedValueOnce({ relativePath: '11测试/新建多维日历.index.yaml', parseState: 'valid', collectionType: 'table', name: '日历', indexSequence: 1 })
    .mockRejectedValue(new Error('COLLECTION_NOT_FOUND'));
  const reference = { notebookId: 'book', collectionId: document.collection.id };
  await openCollectionTarget(reference);
  await openCollectionTarget(reference, { refresh: true });
  expect(useWorkColumnStore.getState().navigation.target).toMatchObject({
    filePath: '/book/11测试/新建多维日历.index.yaml', unavailableReason: '集合不存在或暂时无法读取',
  });
});

it('opens a malformed calendar without withdrawing selection, then repairs it even while the index is unavailable', async () => {
  const document = createTableDocument('calendar', '新建多维日历', 'standalone');
  const damaged = serializeTableDocument(document).replace('placement: standalone', 'placement: standalone1');
  const path = '/book/11测试/新建多维日历.index.yaml';
  mocks.read.mockResolvedValue(damaged);
  mocks.resolve.mockRejectedValue(new Error('COLLECTION_NOT_FOUND'));
  mocks.write.mockResolvedValue({ status: 'saved' });
  await openContentleTarget(path, '/book/11测试', null);
  const navigation = useWorkColumnStore.getState().navigation;
  expect(navigation.phase).toBe('committed');
  expect(workColumnTargetFilePath(navigation.target)).toBe(path);
  expect(navigation.target).toMatchObject({ kind: 'table', notebookPath: '/book', notebookId: 'book', unavailableReason: '集合文件格式无效' });
  const presentation = resolveWorkColumnContent({ navigation, document: null, pluginWorkbench: null, emptyMessage: '' });
  expect(presentation).toMatchObject({ status: 'empty', actions: [{ id: 'reset-current-collection-view', enabled: true }] });

  await resetCurrentCollectionView(path, '/book/11测试', null);
  const write = mocks.write.mock.calls[0][0];
  expect(write).toMatchObject({ filePath: path, scopePath: '/book', expectedContent: damaged });
  const repaired = parseTableDocument(write.content);
  expect(repaired.collection).toMatchObject({ id: document.collection.id, placement: 'standalone' });
  expect(collectionDisplayName(path, repaired.collection.placement)).toBe('新建多维日历');
  expect(repaired.collection).not.toHaveProperty('name');
  expect(repaired.views.items).toEqual(document.views.items);
  expect(useWorkColumnStore.getState().navigation.target).toMatchObject({ kind: 'table', filePath: path });
  expect(useWorkColumnStore.getState().navigation.target).not.toHaveProperty('unavailableReason');
});

it('keeps a malformed folder collection selected and recoverable', async () => {
  const document = createTableDocument('table', '项目', 'folder');
  document.dataset.source = { scope: 'containing_folder' };
  mocks.read.mockResolvedValue(serializeTableDocument(document).replace('placement: folder', 'placement: broken'));
  const { files } = await import('@platform/tauri/client');
  const read = vi.spyOn(files, 'read').mockResolvedValue(await mocks.read());
  try {
    await openFolderCollection('book', '/book/项目');
    expect(useWorkColumnStore.getState().navigation.target).toMatchObject({
      kind: 'table', filePath: '/book/项目/.index.yaml', unavailableReason: '集合文件格式无效',
    });
  } finally { read.mockRestore(); }
});
