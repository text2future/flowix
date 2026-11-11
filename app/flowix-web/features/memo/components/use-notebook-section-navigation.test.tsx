import { act, type KeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import type { VisibleTreeNode } from './use-folder-tree';
import type { NotebookTreeSection } from './use-notebook-tree-sections';
import { useNotebookSectionNavigation } from './use-notebook-section-navigation';

it('preserves selection at Shift boundaries and crosses only visible sections with plain arrows', async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const selectItem = vi.fn();
  const focusTreeItem = vi.fn();
  function Harness({ order }: { order: NotebookTreeSection[] }) {
    const onKeyDown = useNotebookSectionNavigation({
      visibleSectionOrder: order,
      visibleTreeItems: [{ item: { fullPath: '/notes/file.md' }, depth: 0 }] as VisibleTreeNode[],
      treeRootRef: { current: host },
      selectItem,
      focusTreeItem,
    });
    return <div onKeyDown={onKeyDown}>
      <section data-notebook-pinned-section="true">
        <div tabIndex={0} data-notebook-tree-path="/notes/pinned.md"
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === 'ArrowUp') event.preventDefault();
          }} />
      </section>
    </div>;
  }
  try {
    await act(async () => root.render(<Harness order={['pinned', 'files']} />));
    const pinned = host.querySelector<HTMLElement>('[data-notebook-tree-path]')!;
    pinned.focus();
    const press = async (key: string, shiftKey = false) => act(async () => {
      pinned.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
    });
    await press('ArrowDown', true);
    expect(selectItem).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(pinned);
    await press('ArrowUp');
    expect(selectItem).not.toHaveBeenCalled();
    await press('ArrowDown');
    expect(selectItem).toHaveBeenCalledWith('/notes/file.md');
    expect(focusTreeItem).toHaveBeenCalledWith('/notes/file.md');
    selectItem.mockClear();
    focusTreeItem.mockClear();
    await act(async () => root.render(<Harness order={['pinned']} />));
    await press('ArrowDown');
    expect(selectItem).not.toHaveBeenCalled();
    expect(focusTreeItem).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
