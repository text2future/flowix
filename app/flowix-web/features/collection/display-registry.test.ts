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
  it('assigns different display IDs to different views and restores the same ID after registry release', () => {
    const target = { notebookId: 'book', collectionId: 'col_test', viewId: 'view_one' };
    const first = ensureCollectionDisplay(target);
    const second = ensureCollectionDisplay({ ...target, viewId: 'view_two' });
    expect(first.displayId).not.toBe(second.displayId);
    reconcileCollectionDisplays([]);
    expect(ensureCollectionDisplay(target, first.displayId).displayId).toBe(first.displayId);
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
