import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { NotebookChange } from '@platform/tauri/notebook-change-events';
import { useNotebookTreeSections, type NotebookTreeHiddenSection, type NotebookTreeSection } from './use-notebook-tree-sections';

const system = vi.hoisted(() => ({
  getNotebookFileTreePreferences: vi.fn(),
  setNotebookPinnedFolders: vi.fn().mockResolvedValue(undefined),
  setNotebookFileTreeSectionOrder: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@platform/tauri/client', () => ({ system }));
const changes = vi.hoisted(() => new Set<(change: NotebookChange) => void>());
vi.mock('@platform/tauri/notebook-change-events', () => ({
  subscribeNotebookChanges: (handler: (change: NotebookChange) => void) => {
    changes.add(handler);
    return () => { changes.delete(handler); };
  },
}));

it('syncs preferences for the same notebook and ignores stale reads after an edit', async () => {
  // 顺序数组必须与 DEFAULT_TREE_SECTION_ORDER 等长，否则归一化会补位，
  // 导致 update 后的期望值与实际值长度不一致。
  const order: NotebookTreeSection[] = ['agents', 'pinned', 'files', 'repositories', 'more'];
  let resolveRead!: (preferences: { sectionOrder: NotebookTreeSection[]; hiddenSections: NotebookTreeHiddenSection[] }) => void;
  const staleRead = new Promise<{ sectionOrder: NotebookTreeSection[]; hiddenSections: NotebookTreeHiddenSection[] }>((resolve) => { resolveRead = resolve; });
  system.getNotebookFileTreePreferences.mockImplementation((id: string) => id === 'first'
    ? staleRead
    : Promise.resolve({ sectionOrder: order, hiddenSections: [] }));
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  let update!: (order: NotebookTreeSection[], hidden: NotebookTreeHiddenSection[]) => void;
  function Observer({ id, name }: { id: string; name: string }) {
    const preferences = useNotebookTreeSections(id, true);
    if (name === 'guide') update = preferences.updateSections;
    return <output data-observer={name}>{JSON.stringify([preferences.sectionOrder, preferences.hiddenSections])}</output>;
  }
  try {
    await act(async () => root.render(<>
      <Observer id="first" name="guide" />
      <Observer id="first" name="tree" />
      <Observer id="other" name="other" />
    </>));
    const nextOrder = [...order].reverse();
    await act(async () => update(nextOrder, ['files']));
    await act(async () => resolveRead({ sectionOrder: order, hiddenSections: [] }));
    const expected = JSON.stringify([nextOrder, ['files']]);
    expect(host.querySelector('[data-observer="guide"]')?.textContent).toBe(expected);
    expect(host.querySelector('[data-observer="tree"]')?.textContent).toBe(expected);
    expect(host.querySelector('[data-observer="other"]')?.textContent).toBe(JSON.stringify([order, []]));
    expect(system.setNotebookFileTreeSectionOrder).toHaveBeenCalledWith('first', nextOrder, ['files']);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  }
});


it.each(['loaded', 'failed', 'switched'] as const)(
  'handles queued folder pins and moves when preferences are %s',
  async (outcome) => {
    system.setNotebookPinnedFolders.mockClear();
    let resolveRead!: (value: { pinnedFolders: string[] }) => void;
    let rejectRead!: (error: Error) => void;
    const pending = new Promise<{ pinnedFolders: string[] }>((resolve, reject) => {
      resolveRead = resolve;
      rejectRead = reject;
    });
    system.getNotebookFileTreePreferences.mockImplementation((id: string) => (
      id === 'first' ? pending : Promise.resolve({ pinnedFolders: ['other'] })
    ));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    let update!: ReturnType<typeof useNotebookTreeSections>['updatePinnedFolders'];
    function Observer({ id }: { id: string }) {
      const preferences = useNotebookTreeSections(id, true);
      update = preferences.updatePinnedFolders;
      return <output>{JSON.stringify(preferences.pinnedFolders)}</output>;
    }
    try {
      await act(async () => root.render(<Observer id="first" />));
      let pin!: Promise<void>;
      await act(async () => {
        pin = update((paths) => ['new', ...paths]);
        // Attach before rejecting the deferred read in the failure case.
        void pin.catch(() => undefined);
        for (const notify of changes) notify({
          kind: 'path-moved', notebookId: 'first', directory: true,
          previousRelativePath: 'saved', relativePath: 'renamed',
        });
      });
      expect(system.setNotebookPinnedFolders).not.toHaveBeenCalled();
      if (outcome === 'switched') {
        await act(async () => root.render(<Observer id="other" />));
      }
      await act(async () => {
        if (outcome === 'failed') rejectRead(new Error('read failed'));
        else resolveRead({ pinnedFolders: ['saved', 'saved/child'] });
        await pin.catch(() => undefined);
      });
      if (outcome === 'loaded') {
        expect(system.setNotebookPinnedFolders.mock.calls).toEqual([
          ['first', ['new', 'saved', 'saved/child']],
          ['first', ['new', 'renamed', 'renamed/child']],
        ]);
        expect(host.textContent).toBe(JSON.stringify(['new', 'renamed', 'renamed/child']));
      } else {
        expect(system.setNotebookPinnedFolders).not.toHaveBeenCalled();
        expect(host.textContent).toBe(JSON.stringify(outcome === 'switched' ? ['other'] : []));
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
      environment.IS_REACT_ACT_ENVIRONMENT = false;
    }
  },
);
