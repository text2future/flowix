import { seedBrowserColumn } from '@features/workspace/test-support/workspace-fixtures';
import { afterEach, expect, it } from 'vitest';
import { ensureCollectionDisplay, reconcileCollectionDisplays } from '@/lib/collection-display-registry';
import { useDocumentHistoryStore } from '@features/document/store/document-history-store';
import { useWorkColumnStore } from '../store/work-column-store';
import { useWorkspaceRestoreStore } from '../store/workspace-restore-store';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { setCollectionActiveView } from './collection-view-state';

const identity = { notebookId: 'book', collectionId: 'table' };
afterEach(() => {
  useDocumentHistoryStore.getState().clear();
  useBrowserColumnStore.getState().reset();
  const store = useWorkColumnStore.getState();
  store.commitNavigation(store.beginNavigation({ kind: 'empty' }, null), { kind: 'empty' });
  reconcileCollectionDisplays([]);
});

it('changes views without a navigation transaction and retains the latest view for history and restore', () => {
  const display = ensureCollectionDisplay({ ...identity, viewId: 'a' });
  const target = { kind: 'collection' as const, ...display, filePath: '/book/table.yaml', notebookPath: '/book', collectionType: 'table' as const, name: 'Table' };
  const store = useWorkColumnStore.getState();
  const requestId = store.beginNavigation(target, null);
  store.commitNavigation(requestId, target);
  const forward = { kind: 'web' as const, url: 'https://example.com', openedAt: 1 };
  useDocumentHistoryStore.getState().pushForward(forward);
  for (const viewId of ['b', 'c', 'c', 'a', 'c']) expect(setCollectionActiveView({ host: 'column-1' }, identity, viewId)).toBe(true);
  expect(useWorkColumnStore.getState().navigation).toMatchObject({ requestId, phase: 'committed', pendingTarget: null, target: { displayId: display.displayId, viewId: 'c' } });
  expect(useWorkspaceRestoreStore.getState().desiredTarget).toMatchObject({ displayId: display.displayId, viewId: 'c' });
  expect(useDocumentHistoryStore.getState().backStack).toEqual([]);
  expect(useDocumentHistoryStore.getState().forwardStack).toEqual([forward]);
  const current = useWorkColumnStore.getState().navigation.target;
  expect(current.kind).toBe('collection');
  if (current.kind !== 'collection') throw new Error('Expected collection');
  useDocumentHistoryStore.getState().recordNavigation({ ...current, openedAt: 1 }, forward);
  expect(useDocumentHistoryStore.getState().peekBack()).toMatchObject({ displayId: display.displayId, viewId: 'c' });
  expect(setCollectionActiveView({ host: 'column-1' }, { ...identity, collectionId: 'other' }, 'b')).toBe(false);
});

it('updates the browser view in place without replacing its tab or display', () => {
  const display = ensureCollectionDisplay({ ...identity, viewId: 'a' });
  seedBrowserColumn({ current: { id: 'tab', title: 'Table', icon: 'table', target: { kind: 'file-browser', activeFilePath: '/book/table.yaml', folderPath: null, scopePath: '/book', notebookId: 'book', fileTreeVisible: false, fileTreeWidth: 220, collectionDisplay: display, collectionType: 'table' } }, });
  expect(setCollectionActiveView({ host: 'column-2', surfaceId: 'tab' }, identity, 'b')).toBe(true);
  expect(useBrowserColumnStore.getState().current).not.toBeNull();
  expect(useBrowserColumnStore.getState().current).toMatchObject({ id: 'tab', target: { activeFilePath: '/book/table.yaml', collectionDisplay: { ...display, viewId: 'b' } } });
  expect(useDocumentHistoryStore.getState().backStack).toEqual([]);
});

it('preserves collection-level failures when another view is requested', () => {
  const display = ensureCollectionDisplay({ ...identity, viewId: 'a' });
  const target = { kind: 'collection' as const, ...display, filePath: '/book/table.yaml', notebookPath: '/book', collectionType: 'table' as const, name: 'Table', unavailableReason: '集合身份冲突或格式暂不可用' };
  const store = useWorkColumnStore.getState();
  store.commitNavigation(store.beginNavigation(target, null), target);
  expect(setCollectionActiveView({ host: 'column-1' }, identity, 'b')).toBe(false);
  expect(useWorkColumnStore.getState().navigation.target).toEqual(target);
  const browserTarget = { kind: 'file-browser' as const, activeFilePath: '/book/table.yaml', folderPath: null, scopePath: '/book', notebookId: 'book', fileTreeVisible: false, fileTreeWidth: 220, collectionDisplay: display, collectionUnavailableReason: target.unavailableReason };
  seedBrowserColumn({ current: { id: 'tab', title: 'Table', icon: null, target: browserTarget } });
  expect(setCollectionActiveView({ host: 'column-2', surfaceId: 'tab' }, identity, 'b')).toBe(false);
  expect(useBrowserColumnStore.getState().current!.target).toEqual(browserTarget);
});
