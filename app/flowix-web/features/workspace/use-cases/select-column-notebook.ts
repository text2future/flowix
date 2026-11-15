import { createNotebookNavigationScope } from './notebook-navigation-scope';
import { type Notebook } from '@features/memo/public/workspace-api';
import { useWorkspaceSessionStore } from '../store/workspace-session-store';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { enqueueBrowserColumnNavigation } from './browser-column-coordinator';
import { NavigationCancelledError } from '@/lib/navigation-cancelled-error';

/** Notebook selection affects index zero even when the second instance occupies it. */
export async function selectNotebookInSecondColumn(notebook: Notebook): Promise<void> {
  const columnId = 'column-2';
  const store = useWorkspaceSessionStore.getState();
  store.updateSession(columnId, (column) => ({ ...column, notebookSwitchesInFlight: column.notebookSwitchesInFlight + 1 }));
  try {
    const result = await enqueueBrowserColumnNavigation(async () => {
      const scope = createNotebookNavigationScope(() => true, 'column-2');
      try {
        await scope.switchTo(notebook.id, 0, notebook);
        useBrowserColumnStore.getState().clearContent();
        return true;
      } catch (error) {
        await scope.rollback(0);
        throw error;
      }
    });
    if (!result) throw new NavigationCancelledError('Notebook switching was cancelled');
  } finally {
    store.updateSession(columnId, (column) => ({ ...column, notebookSwitchesInFlight: Math.max(0, column.notebookSwitchesInFlight - 1) }));
  }
}
