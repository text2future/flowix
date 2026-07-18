import { beforeEach, describe, expect, it } from 'vitest';
import type { WindowTab } from '@platform/tauri/client';
import { adjacentTabId, useTabWindowStore } from './tab-window-store';

function tab(id: string): WindowTab {
  return { id, title: id, icon: null, target: { kind: 'web', url: `https://example.com/${id}` } };
}

describe('tab window store', () => {
  beforeEach(() => useTabWindowStore.getState().reset());

  it('keeps requested and committed selection separate', () => {
    const store = useTabWindowStore.getState();
    store.hydrate([tab('a'), tab('b')]);
    store.request('b');
    expect(useTabWindowStore.getState().activeTabId).toBeNull();
    expect(useTabWindowStore.getState().requestedTabId).toBe('b');
    store.commit('b');
    expect(useTabWindowStore.getState().activeTabId).toBe('b');
  });

  it('does not overwrite a newer request when an older activation commits', () => {
    const store = useTabWindowStore.getState();
    store.hydrate([tab('a'), tab('b'), tab('c')]);
    store.commit('a');
    store.request('b');
    store.request('c');
    store.commit('b', true);

    expect(useTabWindowStore.getState()).toMatchObject({
      activeTabId: 'b',
      requestedTabId: 'c',
    });
  });

  it('adds idempotently for every target kind', () => {
    const store = useTabWindowStore.getState();
    store.add(tab('web:a'));
    store.add({ ...tab('web:a'), title: 'Updated' });
    expect(useTabWindowStore.getState().tabs).toHaveLength(1);
    expect(useTabWindowStore.getState().tabs[0].title).toBe('Updated');

    store.add({
      id: 'external:/tmp/outside.md',
      title: 'outside.md',
      icon: null,
      target: { kind: 'external_markdown', filePath: '/tmp/outside.md' },
    });
    expect(useTabWindowStore.getState().tabs[1].target.kind).toBe('external_markdown');
  });

  it('selects the left neighbour before the right neighbour', () => {
    const tabs = [tab('a'), tab('b'), tab('c')];
    expect(adjacentTabId(tabs, 'b')).toBe('a');
    expect(adjacentTabId(tabs, 'c')).toBe('b');
    expect(adjacentTabId(tabs, 'a')).toBe('b');
  });

  it('atomically selects the left neighbour when removing the active tab', () => {
    const store = useTabWindowStore.getState();
    store.hydrate([tab('a'), tab('b'), tab('c')]);
    store.commit('b');
    store.removeAndSelect('b', 'a');

    expect(useTabWindowStore.getState()).toMatchObject({
      tabs: [tab('a'), tab('c')],
      activeTabId: 'a',
      requestedTabId: 'a',
    });
  });

  it('atomically selects the right neighbour when removing the first tab', () => {
    const store = useTabWindowStore.getState();
    store.hydrate([tab('a'), tab('b')]);
    store.commit('a');
    store.removeAndSelect('a', 'b');

    expect(useTabWindowStore.getState()).toMatchObject({
      tabs: [tab('b')],
      activeTabId: 'b',
      requestedTabId: 'b',
    });
  });

  it('keeps the current selection when removing an inactive tab', () => {
    const store = useTabWindowStore.getState();
    store.hydrate([tab('a'), tab('b'), tab('c')]);
    store.commit('b');
    store.remove('c');

    expect(useTabWindowStore.getState()).toMatchObject({
      tabs: [tab('a'), tab('b')],
      activeTabId: 'b',
      requestedTabId: 'b',
    });
  });

  it('clears stale selection when removing without a replacement', () => {
    const store = useTabWindowStore.getState();
    store.hydrate([tab('a')]);
    store.commit('a');
    store.remove('a');

    expect(useTabWindowStore.getState()).toMatchObject({
      tabs: [],
      activeTabId: null,
      requestedTabId: null,
    });
  });

  it('reorders a tab before another tab or at the end', () => {
    const store = useTabWindowStore.getState();
    store.hydrate([tab('a'), tab('b'), tab('c')]);
    store.commit('b');

    store.reorder('c', 'a');
    expect(useTabWindowStore.getState().tabs.map((item) => item.id)).toEqual(['c', 'a', 'b']);
    store.reorder('c', null);

    expect(useTabWindowStore.getState()).toMatchObject({
      tabs: [tab('a'), tab('b'), tab('c')],
      activeTabId: 'b',
      requestedTabId: 'b',
    });
  });
});
