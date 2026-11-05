import { migrateLegacySessionData } from '@features/workspace/store/session-legacy-migration';
import { useWorkspaceSessionStore } from '@features/workspace/public/session-api';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureCollectionDisplay, bindCollectionDisplayPath, findCollectionDisplayPath, reconcileCollectionDisplays, pinCollectionDisplay } from '@/lib/collection-display-registry';
import { useDocumentHistoryStore, documentHistoryEntryKey } from '@features/document/store/document-history-store';

afterEach(() => { reconcileCollectionDisplays([]); useDocumentHistoryStore.getState().clear(); });
describe('collection displays and navigation history', () => {
  it('keeps the same display ID through rename, history retention and a delayed old event', () => {
    const target = { notebookId: 'book', collectionId: 'col_test', viewId: null };
    const display = ensureCollectionDisplay(target);
    bindCollectionDisplayPath(display.displayId, '/book/Old.table.yml', 1);
    useDocumentHistoryStore.getState().pushBack({ kind: 'collection', ...display, relativePathHint: 'Old.table.yml', openedAt: 1 });
    reconcileCollectionDisplays(useDocumentHistoryStore.getState().backStack.filter((entry) => entry.kind === 'collection'));
    bindCollectionDisplayPath(display.displayId, '/book/New.table.yml', 3);
    expect(bindCollectionDisplayPath(display.displayId, '/book/Old.table.yml', 2)).toBe(false);
    expect(findCollectionDisplayPath(display.displayId)).toBe('/book/New.table.yml');
    expect(ensureCollectionDisplay(target).displayId).toBe(display.displayId);
    expect(documentHistoryEntryKey(useDocumentHistoryStore.getState().peekBack())).toBe(display.displayId);
    expect(useDocumentHistoryStore.getState().forwardStack).toHaveLength(0);
  });
  it('shares one display ID across views and restores the same ID after registry release', () => {
    const target = { notebookId: 'book', collectionId: 'col_test', viewId: 'view_one' };
    const first = ensureCollectionDisplay(target);
    const second = ensureCollectionDisplay({ ...target, viewId: 'view_two' });
    expect(first.displayId).toBe(second.displayId);
    reconcileCollectionDisplays([]);
    expect(ensureCollectionDisplay(target, first.displayId).displayId).toBe(first.displayId);
  });
  it('normalizes old per-view display IDs and keeps their location aliases readable', () => {
    const target = { notebookId: 'book', collectionId: 'col_test', viewId: 'a' };
    const first = ensureCollectionDisplay(target, 'legacy-a');
    bindCollectionDisplayPath(first.displayId, '/book/Table.yaml', 1);
    const second = ensureCollectionDisplay({ ...target, viewId: 'b' }, 'legacy-b');
    expect(second.displayId).toBe(first.displayId);
    expect(findCollectionDisplayPath('legacy-b')).toBe('/book/Table.yaml');
    useDocumentHistoryStore.getState().recordNavigation({ kind: 'collection', ...first, openedAt: 1 }, { kind: 'collection', ...target, viewId: 'b', displayId: 'legacy-b', openedAt: 2 });
    expect(useDocumentHistoryStore.getState().backStack).toEqual([]);
    reconcileCollectionDisplays([{ ...target, viewId: 'b', displayId: 'legacy-b' }]);
    expect(ensureCollectionDisplay(target).displayId).toBe(first.displayId);
  });
  it('collapses consecutive legacy view history when persisted state is restored', async () => {
    const entry = { kind: 'collection', notebookId: 'book', collectionId: 'col_test', openedAt: 1 };
    localStorage.setItem('flowix.document-history.v1', JSON.stringify({ state: { backStack: [
      { ...entry, displayId: 'old-view-a', viewId: 'a' },
      { ...entry, displayId: 'old-view-b', viewId: 'b' },
    ], forwardStack: [] }, version: 0 }));
    const migrated = migrateLegacySessionData();
    useWorkspaceSessionStore.getState().updateSession('column-1', () => migrated.sessions['column-1']);
    expect(useDocumentHistoryStore.getState().backStack).toHaveLength(1);
    expect(useDocumentHistoryStore.getState().peekBack()).toMatchObject({ viewId: 'b', displayId: 'old-view-a' });
    expect(documentHistoryEntryKey(useDocumentHistoryStore.getState().peekBack())).toBe('old-view-a');
  });
  it('retains an in-flight operation even after its surface leaves the workspace', () => {
    const display = ensureCollectionDisplay({ notebookId: 'book', collectionId: 'col_test', viewId: null });
    bindCollectionDisplayPath(display.displayId, '/book/A.lib.yaml');
    const release = pinCollectionDisplay(display.displayId)!;
    reconcileCollectionDisplays([]);
    expect(findCollectionDisplayPath(display.displayId)).toBe('/book/A.lib.yaml');
    release();
    reconcileCollectionDisplays([]);
    expect(findCollectionDisplayPath(display.displayId)).toBeNull();
  });
});
