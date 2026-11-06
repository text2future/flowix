import { beforeEach, expect, it } from 'vitest';
import { restoreBrowserColumnSession } from './browser-column-persistence';
import { BROWSER_COLUMN_DEFAULT_SPLIT_RATIO } from '../model/browser-column-layout';
import type { BrowserColumnSessionState, BrowserColumnEntry } from '../model/browser-column-session';

const current: BrowserColumnSessionState = { visible: false, splitRatio: BROWSER_COLUMN_DEFAULT_SPLIT_RATIO, current: null, backStack: [], forwardStack: [] };
const tab = (id: string, url: string): BrowserColumnEntry => ({ id, title: id, icon: null, target: { kind: 'web', url } });
beforeEach(() => localStorage.removeItem('flowix.workspace.fourth-column.split-ratio'));

it('keeps the default ratio when there is no legacy value, and migrates a valid legacy value', () => {
  expect(restoreBrowserColumnSession(undefined, current).splitRatio).toBe(BROWSER_COLUMN_DEFAULT_SPLIT_RATIO);
  expect(restoreBrowserColumnSession({}, current).splitRatio).toBe(BROWSER_COLUMN_DEFAULT_SPLIT_RATIO);
  localStorage.setItem('flowix.workspace.fourth-column.split-ratio', '');
  expect(restoreBrowserColumnSession({}, current).splitRatio).toBe(BROWSER_COLUMN_DEFAULT_SPLIT_RATIO);
  localStorage.setItem('flowix.workspace.fourth-column.split-ratio', '0.6');
  expect(restoreBrowserColumnSession({}, current).splitRatio).toBe(0.6);
});

it('deduplicates target and tab identities even after replacing a duplicate with the active entry', () => {
  const restored = restoreBrowserColumnSession({ visible: true, activeTabId: 'active', tabs: [
    tab('first', 'https://one.example/'),
    tab('active', 'https://one.example/'),
    tab('active', 'https://two.example/'),
    tab('last', 'https://last.example/'),
  ] }, current);
  expect(restored.current?.id).toBe('active');
  expect(restored.current?.id).toBe('active');
});

it('drops malformed targets and recovers selection without changing the surviving order', () => {
  const restored = restoreBrowserColumnSession({ visible: true, activeTabId: 'invalid', tabs: [
    tab('second', 'https://two.example/'),
    { ...tab('invalid', 'https://invalid.example/'), target: { kind: 'unknown' } },
    tab('first', 'https://one.example/'),
  ] }, current);
  expect(restored.current?.id).toBe('second');
  expect(restored.current?.id).toBe('second');
});

it('ignores an incomplete collection identity while retaining the recoverable file address', () => {
  const restored = restoreBrowserColumnSession({ activeTabId: 'table', tabs: [{
    id: 'table', title: 'Table', icon: null,
    target: { kind: 'file-browser', activeFilePath: '/book/example.table.yaml', notebookId: 'book',
      collectionDisplay: { notebookId: 'book', collectionId: '', displayId: 'display' } },
  }] }, current);
  expect(restored.current!.target).toMatchObject({ kind: 'file-browser', activeFilePath: '/book/example.table.yaml' });
  expect('collectionDisplay' in restored.current!.target).toBe(false);
});

it('retains the hybrid collection type when restoring a collection file', () => {
  const restored = restoreBrowserColumnSession({ current: {
    id: 'hybrid', title: 'Hybrid', icon: null,
    target: { kind: 'file-browser', activeFilePath: '/book/hybrid.index.yaml', notebookId: 'book',
      scopePath: '/book', collectionType: 'hybrid', collectionDisplay: {
        notebookId: 'book', collectionId: 'hybrid', displayId: 'hybrid-display', viewId: null,
      } },
  } }, current);
  expect(restored.current!.target).toMatchObject({ collectionType: 'hybrid',
    collectionDisplay: { collectionId: 'hybrid' } });
});

it('restores independent visit stacks without deduplicating revisits or retaining malformed entries', () => {
  const restored = restoreBrowserColumnSession({ activeTabId: 'current', tabs: [tab('current', 'https://current.example/')],
    backStack: [tab('a', 'https://a.example/'), null, tab('b', 'https://a.example/')],
    forwardStack: [tab('next', 'https://next.example/')],
  }, current);
  expect(restored.backStack.map((item) => item.id)).toEqual(['a', 'b']);
  expect(restored.forwardStack.map((item) => item.id)).toEqual(['next']);
  expect(restored.current).not.toBeNull();
});

it('restores the new single-content format and never resurrects legacy tabs after explicit clearing', () => {
  const entry = tab('current', 'https://current.example/');
  expect(restoreBrowserColumnSession({ current: entry, backStack: [entry], forwardStack: [], visible: true }, current)).toMatchObject({ current: entry, backStack: [entry], visible: true });
  expect(restoreBrowserColumnSession({ current: null, tabs: [entry], activeTabId: entry.id }, current)).toMatchObject({ current: null, visible: false });
});
