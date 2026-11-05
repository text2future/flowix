import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createWorkDocumentsCollection, serializeWorkDocumentsCollection } from '../work-documents/model';
import type { DocumentListView } from './document-list-view';
import { WorkDocumentsCollectionView } from './work-documents-collection-view';

const state = vi.hoisted(() => ({ source: '', currentPath: '/book/Views/list.index.yaml',
  props: null as ComponentProps<typeof DocumentListView> | null, importFile: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({
  dialogs: { selectFiles: async () => ['/external/report.pdf'] }, files: { importFile: state.importFile },
}));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: () => () => {} }));
vi.mock('@features/memo/store/note-store', () => ({
  useNoteStore: (select: (value: { notebooks: unknown[] }) => unknown) => select({ notebooks: [] }),
}));
vi.mock('@features/collection/public/collection-session-api', () => ({
  useCollectionDocumentSession: (options: { codec: { parse: (source: string) => unknown } }) => ({
    document: options.codec.parse(state.source), loading: false, error: null, saving: false,
    saveInFlightRef: { current: false }, currentFilePath: state.currentPath,
    sourceContentRef: { current: state.source }, refreshContent: vi.fn(), flush: vi.fn(),
  }),
}));
vi.mock('./document-list-view', () => ({
  DocumentListView: (props: ComponentProps<typeof DocumentListView>) => { state.props = props; return null; },
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  state.currentPath = '/book/Views/list.index.yaml';
  state.props = null;
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => root.unmount()); });
async function render() {
  await act(async () => root.render(<WorkDocumentsCollectionView filePath={state.currentPath} notebookPath="/book" notebookId="book" />));
}

it('queries and displays the moved folder rather than the stored path', async () => {
  const document = createWorkDocumentsCollection('List');
  document.collection.placement = 'folder';
  document.dataset.source = { scope: 'containing_folder' };
  document.dataset.filter = { path: 'Old', match: 'all', conditions: [] };
  state.source = serializeWorkDocumentsCollection(document);
  state.currentPath = '/book/New/.index.yaml';
  await render();
  expect(state.props?.workDocumentsFolderPath).toBe('New');
  expect(state.props?.listContext.workDocumentsFilter?.path_contains).toBe('New');
  expect(state.props?.workDocumentsFilter?.path_contains).toBe('New');
});

it('imports into the selected standalone directory despite a stale source', async () => {
  const document = createWorkDocumentsCollection('List');
  document.dataset.source = { scope: 'folder', path: 'Old' };
  document.dataset.filter = { path: 'New', match: 'all', conditions: [] };
  state.source = serializeWorkDocumentsCollection(document);
  await render();
  expect(state.props?.listContext.workDocumentsFilter?.path_contains).toBe('New');
  expect(await state.props?.onImportFiles?.()).toBe(true);
  expect(state.importFile).toHaveBeenCalledWith('/external/report.pdf', '/book/New', '/book');
});

it('represents the notebook root as all folders after moving an index to the root', async () => {
  const document = createWorkDocumentsCollection('List');
  document.collection.placement = 'folder';
  document.dataset.source = { scope: 'containing_folder' };
  document.dataset.filter = { path: 'Old', match: 'all', conditions: [] };
  state.source = serializeWorkDocumentsCollection(document);
  state.currentPath = '/book/.index.yaml';
  await render();
  expect(state.props?.workDocumentsFolderPath).toBe('');
  expect(state.props?.listContext.workDocumentsFilter?.path_scope).toBe('all');
});

it.each([null, { all: [], any: [] }])('keeps a folder list scoped without a path filter: %j', async (filter) => {
  const document = createWorkDocumentsCollection('List');
  document.collection.placement = 'folder';
  document.dataset.source = { scope: 'containing_folder' };
  document.dataset.filter = filter;
  state.source = serializeWorkDocumentsCollection(document);
  state.currentPath = '/book/Project/.index.yaml';
  await render();
  expect(state.props?.workDocumentsFolderPath).toBe('Project');
  expect(state.props?.listContext.workDocumentsFilter?.path_contains).toBe('Project');
  expect(await state.props?.onImportFiles?.()).toBe(true);
  expect(state.importFile).toHaveBeenCalledWith('/external/report.pdf', '/book/Project', '/book');
});

it('uses the migrated location for legacy grouped filters in both queries and imports', async () => {
  const document = createWorkDocumentsCollection('List');
  document.dataset.source = { scope: 'folder', path: 'Project' };
  document.dataset.filter = { all: [], any: [
    { field: 'file_name', op: 'contains', value: 'report' },
    { field: 'file_name', op: 'contains', value: 'summary' },
  ] };
  state.source = serializeWorkDocumentsCollection(document);
  const source = state.source;
  await render();
  expect(state.props?.listContext.workDocumentsFilter?.path_contains).toBe('Project');
  expect(state.props?.workDocumentsFilter?.path_contains).toBe('Project');
  expect(await state.props?.onImportFiles?.()).toBe(true);
  expect(state.importFile).toHaveBeenCalledWith('/external/report.pdf', '/book/Project', '/book');
  expect(state.source).toBe(source);
});
