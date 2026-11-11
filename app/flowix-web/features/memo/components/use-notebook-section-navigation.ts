import type { KeyboardEvent, RefObject } from 'react';

import { samePath } from '@/lib/path';
import type { VisibleTreeNode } from './use-folder-tree';
import type { NotebookTreeSection } from './use-notebook-tree-sections';

interface NotebookSectionNavigationOptions {
  visibleSectionOrder: readonly NotebookTreeSection[];
  visibleTreeItems: readonly VisibleTreeNode[];
  treeRootRef: RefObject<HTMLDivElement | null>;
  selectItem: (path: string, modifiers?: undefined, list?: 'tree' | 'pinned') => void;
  focusTreeItem: (path: string) => void;
}

/** Local row handlers navigate within a section; plain arrows may cross its boundary.
 * Shift selection remains scoped to its original list, including at the boundary.
 */
export function useNotebookSectionNavigation({
  visibleSectionOrder, visibleTreeItems, treeRootRef, selectItem, focusTreeItem,
}: NotebookSectionNavigationOptions) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.shiftKey || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    const origin = event.target instanceof Element ? event.target : null;
    if (!origin || origin.closest('input, textarea, [contenteditable="true"]')) return;
    const current = origin.closest<HTMLElement>('[data-notebook-tree-path], [data-notebook-conversation-item]');
    if (!current || (origin.closest('button') && !origin.closest('[data-notebook-conversation-item]'))) return;
    const root = event.currentTarget;
    const entries: Array<{ element: HTMLElement | null; path?: string; select: () => void; focus: () => void }> = [];
    for (const section of visibleSectionOrder) {
      if (section === 'agents') {
        for (const button of root.querySelectorAll<HTMLButtonElement>('[data-notebook-conversation-item]')) {
          entries.push({ element: button, select: () => button.click(), focus: () => {
            button.focus({ preventScroll: true });
            button.scrollIntoView({ block: 'nearest' });
          } });
        }
      } else if (section === 'pinned') {
        for (const row of root.querySelectorAll<HTMLElement>('[data-notebook-pinned-section] [data-notebook-tree-path]')) {
          const path = row.dataset.notebookTreePath!;
          entries.push({ element: row, select: () => selectItem(path, undefined, 'pinned'), focus: () => {
            row.focus({ preventScroll: true });
            row.scrollIntoView({ block: 'nearest' });
          } });
        }
      } else if (section === 'files' && treeRootRef.current) {
        for (const { item } of visibleTreeItems) {
          entries.push({ element: null, path: item.fullPath,
            select: () => selectItem(item.fullPath), focus: () => focusTreeItem(item.fullPath) });
        }
      }
    }
    const currentIndex = entries.findIndex(entry => entry.element === current
      || (entry.path && current.closest('[data-notebook-tree-root]')
        && samePath(entry.path, current.dataset.notebookTreePath ?? '')));
    if (currentIndex < 0) return;
    const target = entries[currentIndex + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!target) return;
    event.preventDefault();
    target.select();
    target.focus();
  };
}
