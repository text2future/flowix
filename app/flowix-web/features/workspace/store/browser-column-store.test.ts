import { beforeEach, describe, expect, it } from 'vitest';
import {
  BROWSER_COLUMN_DEFAULT_SPLIT_RATIO,
  BROWSER_COLUMN_MIN_WIDTH,
  useBrowserColumnStore,
} from './browser-column-store';
import { useWorkspaceFocusStore } from './workspace-focus-store';

function tab(id: string, memoId = id) {
  return {
    id,
    title: `${id}.md`,
    icon: null,
    target: {
      kind: 'memo' as const,
      memoId,
      notebookId: 'notebook-1',
      notebookPath: '/notes',
      filePath: `/notes/${memoId}.md`,
    },
  };
}

describe('browser column store', () => {
  beforeEach(() => {
    localStorage.removeItem('flowix-browser-column-storage');
    localStorage.removeItem('flowix-fourth-column-storage');
    useBrowserColumnStore.getState().reset();
  });

  it('focuses an existing target instead of duplicating it by default', () => {
    const store = useBrowserColumnStore.getState();
    store.openTab(tab('memo:a', 'a'));
    store.openTab(tab('memo:a:second', 'a'));

    expect(useBrowserColumnStore.getState()).toMatchObject({
      tabs: [{ ...tab('memo:a', 'a'), title: 'memo:a:second.md' }],
      activeTabId: 'memo:a',
      visible: true,
    });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('browser-column');
  });

  it('deduplicates external views by canonical document path', () => {
    const store = useBrowserColumnStore.getState();
    store.openTab({
      id: 'file',
      title: 'A',
      icon: null,
      target: { kind: 'file-browser', folderPath: null, notebookId: null, fileTreeVisible: true, fileTreeWidth: 220, activeFilePath: '/notes/a.md', scopePath: null },
    });
    store.openTab({
      id: 'file-with-scope',
      title: 'A',
      icon: null,
      target: {
        kind: 'file-browser', folderPath: null, notebookId: null, fileTreeVisible: true, fileTreeWidth: 220, activeFilePath: '/notes\\a.md',
        scopePath: '/notes',
      },
    });

    expect(useBrowserColumnStore.getState().tabs).toHaveLength(1);
    expect(useBrowserColumnStore.getState().activeTabId).toBe('file');
  });

  it('reuses an existing target when replace-active would otherwise duplicate it', () => {
    const store = useBrowserColumnStore.getState();
    store.openTab(tab('memo:a', 'a'));
    store.openTab(tab('memo:b', 'b'));

    store.openTab(tab('memo:a:replacement', 'a'), 'replace-active');

    expect(useBrowserColumnStore.getState().tabs.map((item) => item.id)).toEqual(['memo:a']);
    expect(useBrowserColumnStore.getState().activeTabId).toBe('memo:a');
  });

  it('returns focus to the main space when the last tab closes', () => {
    const store = useBrowserColumnStore.getState();
    store.openTab(tab('a'));
    store.closeTab('a');

    expect(useBrowserColumnStore.getState()).toMatchObject({
      tabs: [],
      activeTabId: null,
      visible: false,
    });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('main-third');
  });

  it('closes other tabs and keeps the context-menu tab active', () => {
    const store = useBrowserColumnStore.getState();
    store.openTab(tab('a'));
    store.openTab(tab('b'));
    store.openTab(tab('c'));
    store.commitTab('a');

    store.closeOtherTabs('c');

    expect(useBrowserColumnStore.getState()).toMatchObject({
      tabs: [tab('c')],
      activeTabId: 'c',
      visible: true,
    });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('browser-column');
  });

  it('closes tabs to the right and activates the context-menu tab when needed', () => {
    const store = useBrowserColumnStore.getState();
    store.openTab(tab('a'));
    store.openTab(tab('b'));
    store.openTab(tab('c'));
    store.commitTab('c');

    store.closeTabsToRight('b');

    expect(useBrowserColumnStore.getState()).toMatchObject({
      tabs: [tab('a'), tab('b')],
      activeTabId: 'b',
      visible: true,
    });
  });

  it('closes all tabs and hides the browser column', () => {
    const store = useBrowserColumnStore.getState();
    store.openTab(tab('a'));
    store.openTab(tab('b'));

    store.closeAllTabs();

    expect(useBrowserColumnStore.getState()).toMatchObject({
      tabs: [],
      activeTabId: null,
      visible: false,
      webRuntimes: {},
    });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('main-third');
  });

  it('clamps the split ratio to a safe range', () => {
    const store = useBrowserColumnStore.getState();
    expect(useBrowserColumnStore.getState().splitRatio).toBe(BROWSER_COLUMN_DEFAULT_SPLIT_RATIO);
    store.setSplitRatio(-1);
    expect(useBrowserColumnStore.getState().splitRatio).toBe(0.05);
    store.setSplitRatio(9999);
    expect(useBrowserColumnStore.getState().splitRatio).toBe(0.95);
    expect(BROWSER_COLUMN_MIN_WIDTH).toBe(360);
  });

  it('persists and rehydrates the visible tabs and active tab', async () => {
    const store = useBrowserColumnStore.getState();
    store.openTab(tab('memo:a', 'a'));
    store.openTab(tab('memo:b', 'b'));
    store.commitTab('memo:a');
    store.reorderTab('memo:b', 'memo:a');
    store.setSplitRatio(0.7);

    const persisted = localStorage.getItem('flowix-browser-column-storage');
    expect(persisted).not.toBeNull();

    store.reset();
    localStorage.setItem('flowix-browser-column-storage', persisted!);
    await useBrowserColumnStore.persist.rehydrate();

    expect(useBrowserColumnStore.getState()).toMatchObject({
      visible: true,
      splitRatio: 0.7,
      tabs: [tab('memo:b', 'b'), tab('memo:a', 'a')],
      activeTabId: 'memo:a',
    });
  });

  it('keeps web navigation runtime separate from the durable tab target', () => {
    const store = useBrowserColumnStore.getState();
    store.openTab({
      id: 'web:flowix',
      title: 'Flowix',
      icon: null,
      target: { kind: 'web', url: 'https://flowix.dev/' },
    });

    store.navigateWebTab('web:flowix', 'https://flowix.dev/docs');
    store.navigateWebTab('web:flowix', 'https://flowix.dev/about');

    expect(useBrowserColumnStore.getState().webRuntimes['web:flowix']).toMatchObject({
      currentUrl: 'https://flowix.dev/about',
      history: ['https://flowix.dev/', 'https://flowix.dev/docs', 'https://flowix.dev/about'],
      historyIndex: 2,
      isLoading: true,
    });
    expect(useBrowserColumnStore.getState().tabs[0].target).toEqual({
      kind: 'web',
      url: 'https://flowix.dev/about',
    });

    store.goBackWebTab('web:flowix');
    expect(useBrowserColumnStore.getState().webRuntimes['web:flowix']).toMatchObject({
      currentUrl: 'https://flowix.dev/docs',
      historyIndex: 1,
    });
    store.goForwardWebTab('web:flowix');
    store.reloadWebTab('web:flowix');
    expect(useBrowserColumnStore.getState().webRuntimes['web:flowix'].reloadToken).toBe(5);
  });

  it('updates memo tab paths after a backend rename', () => {
    const store = useBrowserColumnStore.getState();
    store.openTab(tab('memo:a', 'a'));

    store.replaceMemoPath('a', '/notes/Renamed.md');

    expect(useBrowserColumnStore.getState().tabs[0]).toMatchObject({
      title: 'Renamed',
      target: { kind: 'memo', memoId: 'a', filePath: '/notes/Renamed.md' },
    });
  });

  it('removes memo and artifact tabs together when a pointer memo is deleted', () => {
    const store = useBrowserColumnStore.getState();
    store.openTab(tab('memo:a', 'a'));
    store.openTab({
      id: 'artifact:a',
      title: 'Artifact',
      icon: null,
      target: { kind: 'artifact', pointerMemoId: 'a', renderer: 'markmap' },
    });
    store.openTab(tab('memo:b', 'b'));

    expect(store.removeTabsByMemoId('a')).toEqual(['memo:a', 'artifact:a']);
    expect(useBrowserColumnStore.getState().tabs.map((item) => item.id)).toEqual(['memo:b']);
    expect(useBrowserColumnStore.getState().activeTabId).toBe('memo:b');
  });

  it('migrates legacy external targets from the fourth-column storage key', async () => {
    const legacyState = {
      visible: true,
      splitRatio: 0.6,
      tabs: [
        {
          id: 'legacy-markdown',
          title: 'README',
          icon: null,
          target: { kind: 'external_markdown', filePath: '/notes/README.md' },
        },
        {
          id: 'legacy-web',
          title: 'Example',
          icon: null,
          target: { kind: 'external_webpage', url: 'https://example.com/docs' },
        },
      ],
      activeTabId: 'legacy-web',
    };
    localStorage.removeItem('flowix-browser-column-storage');
    localStorage.setItem(
      'flowix-fourth-column-storage',
      JSON.stringify({ state: legacyState, version: 0 }),
    );

    await useBrowserColumnStore.persist.rehydrate();

    expect(useBrowserColumnStore.getState()).toMatchObject({
      visible: true,
      splitRatio: 0.6,
      activeTabId: 'legacy-web',
      tabs: [
        {
          id: 'legacy-markdown',
          target: { kind: 'file-browser', folderPath: null, notebookId: null, fileTreeVisible: true, fileTreeWidth: 220, activeFilePath: '/notes/README.md', scopePath: null },
        },
        {
          id: 'legacy-web',
          target: { kind: 'web', url: 'https://example.com/docs' },
        },
      ],
    });
    expect(useBrowserColumnStore.getState().webRuntimes).toEqual({});
  });
});

it('migrates v2 file and directory duplicates while retaining the active directory context', async () => {
  useBrowserColumnStore.getState().reset();
  localStorage.setItem('flowix-browser-column-storage', JSON.stringify({ version: 2, state: {
    visible: true, activeTabId: 'directory', tabs: [
      { id: 'file', title: 'A', icon: null, target: { kind: 'file', filePath: '/workspace/a.md', scopePath: null } },
      { id: 'directory', title: 'workspace', icon: null, target: {
        kind: 'file-browser', folderPath: '/workspace', activeFilePath: '/workspace/a.md',
        fileTreeVisible: false, fileTreeWidth: 300,
      } },
    ],
  } }));
  await useBrowserColumnStore.persist.rehydrate();
  const state = useBrowserColumnStore.getState();
  expect(state.activeTabId).toBe('directory');
  expect(state.tabs).toHaveLength(1);
  expect(state.tabs[0].target).toMatchObject({
    kind: 'file-browser', activeFilePath: '/workspace/a.md', folderPath: '/workspace',
    scopePath: '/workspace', restoreNotebookContext: true, fileTreeVisible: false, fileTreeWidth: 300,
  });
});
