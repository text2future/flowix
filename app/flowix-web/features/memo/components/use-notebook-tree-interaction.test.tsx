import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureFileDisplayIdentity, rebaseFileDisplayPath } from '@/lib/file-display-registry';
import { useNotebookTreeInteraction } from './use-notebook-tree-interaction';
import { useNotebookTreeSelectionStore } from '../store/notebook-tree-selection-store';
import { TREE_ROW_HEIGHT, TREE_ROW_SIZE } from './notebook-tree-layout';

describe('file tree selection through a rename', () => {
  let root: Root;
  let interaction: ReturnType<typeof useNotebookTreeInteraction>;
  let sequence = 0;
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const tree = { expanded: new Set<string>(), toggle: vi.fn() };
  const onNoteSelect = vi.fn();
  const onFolderSelect = vi.fn();

  function Harness({ path, paths, visiblePaths = [], pinnedPaths = [] }: {
    path: string; paths: Set<string>; visiblePaths?: string[]; pinnedPaths?: string[];
  }) {
    interaction = useNotebookTreeInteraction({
      activeFilePath: path, treeItemPaths: paths,
      pinnedItemPaths: pinnedPaths,
      visibleTreeItems: visiblePaths.map(fullPath => ({ depth: 0, item: {
        id: fullPath, fullPath, name: fullPath.split('/').pop()!, type: 'document',
        parentId: null, children: null, sizeBytes: 0, modifiedMs: null, createdMs: null, memoCreatedMs: null,
      } })), tree,
      treeRootRef: { current: null }, treeScrollerRef: { current: null },
      renderRowIndexByPath: new Map(), treeContentOffset: 0, onNoteSelect, onFolderSelect,
      folderPaths: new Set(visiblePaths.filter(path => !path.endsWith('.md'))),
    });
    return null;
  }
  beforeEach(() => {
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.createElement('div'));
    onNoteSelect.mockClear();
    onFolderSelect.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('keeps keyboard callbacks stable when only tree feedback changes', async () => {
    const options = {
      activeFilePath: null,
      treeItemPaths: new Set<string>(),
      visibleTreeItems: [],
      pinnedItemPaths: [],
      treeRootRef: { current: null },
      treeScrollerRef: { current: null },
      renderRowIndexByPath: new Map<string, number>(),
      treeContentOffset: 0,
      onNoteSelect,
    };
    function StableHarness({ controller }: { controller: typeof tree & { error?: string } }) {
      interaction = useNotebookTreeInteraction({ ...options, tree: controller });
      return null;
    }
    await act(async () => root.render(createElement(StableHarness, { controller: tree })));
    const handler = interaction.handleTreeItemKeyDown;
    await act(async () => root.render(createElement(StableHarness, {
      controller: { ...tree, error: 'directory unavailable' },
    })));
    expect(interaction.handleTreeItemKeyDown).toBe(handler);
    await act(async () => root.render(createElement(StableHarness, {
      controller: { ...tree, expanded: new Set(['/notes/folder']) },
    })));
    expect(interaction.handleTreeItemKeyDown).not.toBe(handler);
  });

  it('shares selection, toggling and ranges between folders and files', async () => {
    const folder = '/mixed/folder';
    const file = '/mixed/file.md';
    const otherFolder = '/mixed/other';
    const visiblePaths = [folder, file, otherFolder];
    await act(async () => root.render(createElement(Harness, {
      path: file, paths: new Set(visiblePaths), visiblePaths,
    })));
    await act(async () => interaction.selectItem(folder));
    expect(interaction.selectedFilePaths).toEqual([folder]);
    expect(onFolderSelect).toHaveBeenCalledExactlyOnceWith(folder);
    expect(onNoteSelect).not.toHaveBeenCalled();
    await act(async () => interaction.selectItem(file, { metaKey: true }));
    expect(interaction.selectedFilePaths).toEqual([folder, file]);
    await act(async () => interaction.selectItem(otherFolder, { shiftKey: true }));
    expect(interaction.selectedFilePaths).toEqual([file, otherFolder]);
    await act(async () => interaction.selectItem(file, { ctrlKey: true }));
    expect(interaction.selectedFilePaths).toEqual([otherFolder]);
    expect(onNoteSelect).not.toHaveBeenCalled();
  });

  it('projects multi-selection count and clears it on navigation and unmount', async () => {
    const first = '/selection/first.md';
    const second = '/selection/second.md';
    const third = '/selection/third.md';
    const paths = new Set([first, second, third]);
    await act(async () => root.render(createElement(Harness, { path: first, paths })));
    await act(async () => interaction.selectItem(first));
    await act(async () => interaction.selectItem(second, { ctrlKey: true }));
    expect(useNotebookTreeSelectionStore.getState().count).toBe(2);
    expect(useNotebookTreeSelectionStore.getState().paths).toEqual([first, second]);
    expect(onNoteSelect).toHaveBeenCalledTimes(1);
    await act(async () => interaction.selectItem(second, { metaKey: true }));
    expect(useNotebookTreeSelectionStore.getState().count).toBe(1);
    await act(async () => interaction.updateSelection([first, second], first));
    await act(async () => root.render(createElement(Harness, { path: third, paths })));
    expect(useNotebookTreeSelectionStore.getState().count).toBe(0);
    expect(useNotebookTreeSelectionStore.getState().paths).toEqual([]);
    await act(async () => interaction.updateSelection([first, second], first));
    await act(async () => root.render(null));
    expect(useNotebookTreeSelectionStore.getState().count).toBe(0);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }])('opens the remaining document after removing the active one (%o)', async (modifiers) => {
    const first = '/singleton/first.md';
    const second = '/singleton/second.md';
    const paths = new Set([first, second]);
    await act(async () => root.render(createElement(Harness, { path: first, paths })));
    await act(async () => interaction.selectItem(first));
    onNoteSelect.mockClear();
    await act(async () => interaction.selectItem(second, modifiers));
    expect(onNoteSelect).not.toHaveBeenCalled();
    await act(async () => interaction.selectItem(first, modifiers));
    expect(interaction.selectedFilePaths).toEqual([second]);
    expect(onNoteSelect).toHaveBeenCalledExactlyOnceWith(second);
    await act(async () => root.render(createElement(Harness, { path: second, paths })));
    expect(interaction.selectedFilePaths).toEqual([second]);
  });

  it('retains newer modifier selections when a local open commits, but clears on external navigation', async () => {
    const previous = '/async/previous.md';
    const first = '/async/first.md';
    const second = '/async/second.md';
    const external = '/async/external.md';
    const paths = new Set([previous, first, second, external]);
    await act(async () => root.render(createElement(Harness, { path: previous, paths })));
    await act(async () => interaction.selectItem(first));
    await act(async () => interaction.selectItem(second, { ctrlKey: true }));
    await act(async () => root.render(createElement(Harness, { path: first, paths })));
    expect(interaction.selectedFilePaths).toEqual([first, second]);
    expect(useNotebookTreeSelectionStore.getState().paths).toEqual([first, second]);
    await act(async () => root.render(createElement(Harness, { path: external, paths })));
    expect(interaction.selectedFilePaths).toEqual([]);
  });

  it('resets the selection source and anchor when switching from pinned to tree', async () => {
    const pinned = '/source/pinned.md';
    const first = '/source/first.index.yaml';
    const middle = '/source/middle.md';
    const last = '/source/last.md';
    const paths = new Set([pinned, first, middle, last]);
    const props = { path: pinned, paths, pinnedPaths: [pinned], visiblePaths: [first, middle, last] };
    await act(async () => root.render(createElement(Harness, props)));
    await act(async () => interaction.selectItem(pinned, undefined, 'pinned'));
    await act(async () => interaction.selectItem(first));
    await act(async () => interaction.selectItem(last, { shiftKey: true }));
    expect(interaction.selectedFilePaths).toEqual([first, middle, last]);
    expect(interaction.getSelectionAnchorPath()).toBe(first);
    await act(async () => root.render(createElement(Harness, { ...props, path: first })));
    expect(interaction.selectedFilePaths).toEqual([first, middle, last]);
  });

  it('starts one smooth scroll to 40% without an intermediate nearest-row scroll', async () => {
    const oldPath = '/creation-reveal/old.md';
    const newPath = '/creation-reveal/new.md';
    const scroller = document.createElement('div');
    const writes: number[] = [];
    let scrollTop = 0;
    Object.defineProperties(scroller, {
      clientHeight: { value: 500 },
      scrollHeight: { value: 2000 },
      scrollTop: {
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; writes.push(value); },
      },
    });
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      scroller.scrollTop = options.top ?? 0;
    });
    Object.defineProperty(scroller, 'scrollTo', { value: scrollTo });
    let positionAtLayout = 0;
    function CreationHarness({ path, ratio, loaded }: {
      path: string; ratio?: number; loaded: boolean;
    }) {
      useNotebookTreeInteraction({
        activeFilePath: path, activeFileRevealRatio: ratio,
        treeItemPaths: new Set([oldPath, newPath]), visibleTreeItems: [], tree,
        treeRootRef: { current: null }, treeScrollerRef: { current: scroller },
        renderRowIndexByPath: new Map(loaded ? [[path, 30]] : []),
        treeContentOffset: 0, onNoteSelect,
      });
      useLayoutEffect(() => { positionAtLayout = scrollTop; });
      return null;
    }
    await act(async () => root.render(createElement(CreationHarness, {
      path: oldPath, loaded: false,
    })));
    expect(writes).toEqual([]);
    await act(async () => root.render(createElement(CreationHarness, {
      path: newPath, ratio: 0.4, loaded: false,
    })));
    expect(writes).toEqual([]);
    await act(async () => root.render(createElement(CreationHarness, {
      path: newPath, ratio: 0.4, loaded: true,
    })));
    const target = 30 * TREE_ROW_SIZE + TREE_ROW_HEIGHT / 2 - 500 * 0.4;
    expect(writes).toEqual([target]);
    expect(positionAtLayout).toBe(target);
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: target, behavior: 'smooth' });
    await act(async () => root.render(createElement(CreationHarness, {
      path: newPath, ratio: 0.4, loaded: true,
    })));
    expect(writes).toEqual([target]);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // A subsequent ordinary navigation carries no creation policy.
    await act(async () => root.render(createElement(CreationHarness, {
      path: oldPath, loaded: true,
    })));
    expect(writes).toEqual([target]);
  });

  it('preserves conversation selection when the open document is renamed', async () => {
    const identity = ensureFileDisplayIdentity(`/conversation-rename-${++sequence}/old.md`);
    const next = identity.path.replace('old.md', 'new.md');
    const paths = new Set([identity.path]);
    await act(async () => root.render(createElement(Harness, { path: identity.path, paths })));
    await act(async () => interaction.selectConversation('conversation-1'));
    rebaseFileDisplayPath(identity.path, next, identity.displayId);
    await act(async () => root.render(createElement(Harness, { path: next, paths: new Set([next]) })));
    expect(interaction.selectedConversationId).toBe('conversation-1');
    expect(interaction.selectedFilePaths).toEqual([]);
    expect(useNotebookTreeSelectionStore.getState().count).toBe(0);
  });

  it('retains selection, anchor and focus while the directory read still contains the old filename', async () => {
    const identity = ensureFileDisplayIdentity(`/tree-rename-${++sequence}/old.md`);
    const next = identity.path.replace('old.md', 'new.md');
    const stalePaths = new Set([identity.path]);
    await act(async () => root.render(createElement(Harness, { path: identity.path, paths: stalePaths })));
    await act(async () => {
      interaction.updateSelection([identity.path], identity.path);
      interaction.setFocusedTreePath(identity.path);
      interaction.setNavigationPolicy(identity.path, 'preserve');
    });
    rebaseFileDisplayPath(identity.path, next, identity.displayId);
    // The registry notification can precede the active-path store update.
    await act(async () => root.render(createElement(Harness, { path: identity.path, paths: stalePaths })));
    expect(interaction.selectedFilePaths).toEqual([identity.path]);
    await act(async () => root.render(createElement(Harness, { path: next, paths: stalePaths })));
    expect(interaction.selectedFilePaths).toEqual([next]);
    expect(interaction.getSelectionAnchorPath()).toBe(next);
    expect(interaction.focusedTreePath).toBe(next);
    expect(interaction.activeFileShouldReveal).toBe(false);

    await act(async () => root.render(createElement(Harness, { path: next, paths: new Set([next]) })));
    expect(interaction.selectedFilePaths).toEqual([next]);
    expect(onNoteSelect).not.toHaveBeenCalled();

    const other = ensureFileDisplayIdentity(`/tree-rename-${sequence}/other.md`);
    await act(async () => root.render(createElement(Harness, { path: other.path, paths: new Set([next, other.path]) })));
    expect(interaction.selectedFilePaths).toEqual([]);
    expect(interaction.getSelectionAnchorPath()).toBeNull();
  });
});
