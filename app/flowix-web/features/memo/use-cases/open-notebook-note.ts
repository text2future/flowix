import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import type { WorkspaceNavigationSource } from '@features/workspace/public/open-surface-api';
import type { WorkspaceContentLocation } from '@features/workspace/public/note-navigation-api';
import type { Notebook } from '@features/memo/store/note-store';

/** Open notebook Markdown through the shared path document surface. */
export async function openNotebookNote(
  path: string,
  notebook: Notebook,
  options: { source?: WorkspaceNavigationSource; destination?: 0 | 1; history?: 'push' | 'skip'; initialFocus?: 'title' | 'body'; mayBePlugin?: boolean; treeReveal?: 'created-note' } = {},
): Promise<WorkspaceContentLocation | null> {
  const result = await openWorkspaceSurface({
    index: options.destination ?? 0,
    ...(options.source ? { source: options.source } : {}),
    target: { kind: 'external', path, scopePath: notebook.path, transitionId: null, ...(options.treeReveal ? { treeReveal: options.treeReveal } : {}) },
    options: { history: options.history, initialFocus: options.initialFocus },
  });
  return result.status === 'cancelled' ? null : result.location;
}
