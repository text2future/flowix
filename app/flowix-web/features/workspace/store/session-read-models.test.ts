import { beforeEach, expect, it } from 'vitest';
import { useWorkColumnStore } from './work-column-store';
import { useBrowserColumnStore } from './browser-column-store';
import { useWorkspaceSessionStore } from './workspace-session-store';
import { useDocumentHistoryStore } from '@features/document/store/document-history-store';
import { createSessionViewChannel } from '../public/session-view-state-api';

beforeEach(() => useWorkspaceSessionStore.getState().reset());
it('exposes read models and commands without a legacy state setter or persistence engine', () => {
  for (const view of [useWorkColumnStore, useBrowserColumnStore, useDocumentHistoryStore]) {
    expect('setState' in view).toBe(false);
    expect('persist' in view).toBe(false);
  }
});
it('keeps canonical external identity and recovery through right-column metadata and tree updates', () => {
  const store = useWorkspaceSessionStore.getState();
  store.commitTarget('column-2', { kind: 'external', path: '/book/a.md', scopePath: '/book', transitionId: 17 });
  const entry = useWorkspaceSessionStore.getState().sessions['column-2'].navigation.current!;
  const capture = createSessionViewChannel('column-2', entry.id, 'scroll');
  capture.write({ kind: 'scroll', scrollTop: 42, scrollLeft: 0 });
  store.swapColumnContents();
  const browser = useBrowserColumnStore.getState();
  browser.updateContentMetadata(entry.id, { title: 'A' });
  browser.setFileBrowserTreeVisible(entry.id, false);
  browser.replaceExternalPath('/book/a.md', '/book/b.md');
  const after = useWorkspaceSessionStore.getState().sessions['column-2'];
  expect(after.navigation.current).toMatchObject({ id: entry.id, target: {
    kind: 'external', path: '/book/b.md', transitionId: 17, fileBrowser: { fileTreeVisible: false },
  } });
  expect(capture.read()).toEqual({ kind: 'scroll', scrollTop: 42, scrollLeft: 0 });
});
it('updates history paths without rebuilding entry IDs or navigation transactions', () => {
  const store = useWorkspaceSessionStore.getState();
  store.commitTarget('column-1', { kind: 'external', path: '/book/a.md', scopePath: '/book', transitionId: 1 }, { history: 'push' });
  store.commitTarget('column-1', { kind: 'web', url: 'https://example.com/' }, { history: 'push' });
  const before = useWorkspaceSessionStore.getState().sessions['column-1'].navigation;
  useDocumentHistoryStore.getState().replaceFilePath('/book/a.md', '/book/b.md');
  const after = useWorkspaceSessionStore.getState().sessions['column-1'].navigation;
  expect(after.backStack[0]).toMatchObject({ id: before.backStack[0].id, openedAt: before.backStack[0].openedAt,
    target: { kind: 'external', path: '/book/b.md', transitionId: 1 } });
  expect(after.transaction).toBe(before.transaction);
});
it('keeps the browser snapshot stable during independent left-column navigation', () => {
  const browser = useBrowserColumnStore.getState();
  browser.openContent({ id: 'web', title: 'Web', icon: null, target: { kind: 'web', url: 'https://example.com/' } });
  const before = useBrowserColumnStore.getState();
  useWorkspaceSessionStore.getState().commitTarget('column-1', { kind: 'web', url: 'https://other.example/' });
  expect(useBrowserColumnStore.getState()).toBe(before);
});
