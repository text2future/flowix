import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collections, externalDocuments, notebooks, type CollectionIndexItem } from '@platform/tauri/client';
import { createTableDocument, serializeTableDocument } from '@features/multidimensional-table/model';
import { createMediaLibrary, serializeMediaLibrary } from '@features/media-library/model';
import { serializeHybridCollectionDocument } from '@features/collection/model';
import { ensureCollectionDisplay } from '@/lib/collection-display-registry';
import { useWorkColumnStore } from '../store/work-column-store';
import { useBrowserColumnStore } from '../store/browser-column-store';
import type { WorkColumnTarget } from '../store/work-column-target';
import { resetBrowserColumnCoordinator } from './browser-column-coordinator';
import { openBrowserColumnText, openWorkColumnTargetInBrowserColumn, selectBrowserColumnFile } from './browser-column-navigation';

function activate(target: WorkColumnTarget) {
  const store = useWorkColumnStore.getState();
  store.commitNavigation(store.beginNavigation(target, null), target);
}

function fixture(type: 'table' | 'media_library' | 'hybrid', filename: string) {
  const document = type === 'media_library' ? createMediaLibrary('照片') : createTableDocument();
  const table = document as ReturnType<typeof createTableDocument>;
  const content = type === 'hybrid' ? serializeHybridCollectionDocument({
    collection: { ...table.collection, type: 'hybrid' },
    payload: { schema_version: 3, file_tree: false, domains: { notes: table.dataset },
      views: { default_by_domain: { notes: table.views.default_id },
        items: table.views.items.map((view) => ({ ...view, domain: 'notes' })) } },
  }) : type === 'table'
    ? serializeTableDocument(document as ReturnType<typeof createTableDocument>)
    : serializeMediaLibrary(document as ReturnType<typeof createMediaLibrary>);
  const item: CollectionIndexItem = {
    collectionId: document.collection.id, collectionType: type, relativePath: filename,
    indexSequence: 1, name: filename.replace(/\.(?:index\.ya?ml|(?:table|lib)\.ya?ml)$/i, ''), schemaVersion: type === 'hybrid' ? 3 : 2, payloadSchemaVersion: type === 'hybrid' ? 3 : 2,
    revision: 0, properties: {}, createdAt: null, updatedAt: null, modifiedMs: 0,
    sizeBytes: content.length, contentHash: null, parseState: 'valid', errorCode: null,
    inViews: true, identityConflict: false,
  };
  vi.spyOn(collections, 'resolve').mockResolvedValue(item);
  vi.spyOn(externalDocuments, 'read').mockResolvedValue(content);
  return item;
}

describe('browser column collection navigation', () => {
  beforeEach(() => {
    resetBrowserColumnCoordinator();
    useBrowserColumnStore.getState().reset();
    activate({ kind: 'empty' });
    vi.spyOn(notebooks, 'getAll').mockResolvedValue([
      { id: 'notes', name: 'Notes', path: '/notes', createdAt: 0, updatedAt: 0, isDefault: true },
    ]);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['table', 'media_library', 'hybrid'] as const)('resolves .index.yaml as %s and clears collection state when selecting Markdown', async (type) => {
    const item = fixture(type, '项目.index.yaml');
    const opened = await openBrowserColumnText('/notes/项目.index.yaml', '/notes');
    expect(opened?.host).toBe('column-2');
    const tab = useBrowserColumnStore.getState().current!;
    expect(tab.target).toMatchObject({ collectionType: type, collectionDisplay: { collectionId: item.collectionId } });
    await selectBrowserColumnFile(tab.id, '/notes/plan.md');
    expect(useBrowserColumnStore.getState().current!.target).toMatchObject({
      activeFilePath: '/notes/plan.md', collectionType: undefined, collectionDisplay: undefined,
    });
  });

  it('opens a second collection view at the current path and retains Work', async () => {
    const item = fixture('table', '移动后.index.yaml');
    const display = ensureCollectionDisplay({ notebookId: 'notes', collectionId: item.collectionId!, viewId: 'selected-view' });
    const target: WorkColumnTarget = { kind: 'collection', ...display, collectionType: 'table', filePath: '/notes/旧.index.yaml', notebookPath: '/notes', name: '项目' };
    activate(target);
    await openWorkColumnTargetInBrowserColumn(target);
    expect(useBrowserColumnStore.getState().current!.target).toMatchObject({
      activeFilePath: '/notes/移动后.index.yaml', collectionType: 'table', collectionDisplay: display,
    });
    expect(useWorkColumnStore.getState().navigation.target).toEqual(target);
  });

  it.each([
    ['table', 'table', '旧.table.yaml'],
    ['media-library', 'media_library', '旧.lib.yml'],
  ] as const)('opens a second view for the legacy %s target', async (kind, type, filename) => {
    fixture(type, filename);
    activate({ kind, filePath: `/notes/${filename}`, notebookPath: '/notes', notebookId: 'notes' });
    await openWorkColumnTargetInBrowserColumn(useWorkColumnStore.getState().navigation.target);
    expect(useBrowserColumnStore.getState().current!.target).toMatchObject({ collectionType: type });
  });

  it('preserves the work column when collection resolution fails', async () => {
    const item = fixture('table', '项目.index.yaml');
    vi.mocked(collections.resolve).mockResolvedValue({ ...item, identityConflict: true });
    const target: WorkColumnTarget = { kind: 'table', filePath: '/notes/项目.index.yaml', notebookPath: '/notes', notebookId: 'notes' };
    activate(target);
    await expect(openWorkColumnTargetInBrowserColumn(target)).rejects.toThrow('集合身份冲突');
    expect(useBrowserColumnStore.getState().current).toBeNull();
    expect(useWorkColumnStore.getState().navigation.target).toEqual(target);
  });

  it.each(['table', 'media_library'] as const)('keeps an invalid %s selected when opening and switching files', async (type) => {
    fixture(type, 'broken.index.yaml');
    const document = type === 'table' ? createTableDocument() : createMediaLibrary('照片');
    const valid = type === 'table'
      ? serializeTableDocument(document as ReturnType<typeof createTableDocument>)
      : serializeMediaLibrary(document as ReturnType<typeof createMediaLibrary>);
    vi.mocked(externalDocuments.read).mockResolvedValue(valid.replace(/placement: \w+/, 'placement: standalone1'));
    const opened = await openBrowserColumnText('/notes/broken.index.yaml', '/notes');
    expect(opened).not.toBeNull();
    const tab = useBrowserColumnStore.getState().current!;
    expect(tab.target).toMatchObject({
      activeFilePath: '/notes/broken.index.yaml', collectionType: type, collectionUnavailableReason: '集合文件格式无效',
    });
    await selectBrowserColumnFile(tab.id, '/notes/plan.md');
    expect(useBrowserColumnStore.getState().current!.target).toMatchObject({ activeFilePath: '/notes/plan.md', collectionUnavailableReason: undefined });
    await selectBrowserColumnFile(useBrowserColumnStore.getState().current?.id!, '/notes/broken.index.yaml');
    expect(useBrowserColumnStore.getState().current!.target).toMatchObject({
      activeFilePath: '/notes/broken.index.yaml', collectionType: type, collectionUnavailableReason: '集合文件格式无效',
    });
  });
});
