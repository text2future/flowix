import { getSessionId } from '../store/workspace-session-store';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { clearWorkspaceDocument as clearFirstColumn } from '../use-cases/workspace-navigation';
import { closeBrowserColumnContent } from '../use-cases/browser-column-closing';
import { NavigationCancelledError } from '@/lib/navigation-cancelled-error';
import type { WorkspaceColumnIndex } from '../model/workspace-session';

/** Global/sidebar commands resolve their position before crossing a save barrier. */
export async function clearColumnAtIndex(index: WorkspaceColumnIndex = 0): Promise<void> {
  if (getSessionId(index) === 'column-1') return clearFirstColumn();
  const entry = useBrowserColumnStore.getState().current;
  if (entry && !await closeBrowserColumnContent(entry.id)) {
    throw new NavigationCancelledError('Column closing was cancelled');
  }
}
