import { useBrowserColumnStore } from '../store/browser-column-store';
import { useWorkColumnStore } from '../store/work-column-store';
import { useWorkspaceSessionStore } from '../store/workspace-session-store';

/** No save, target conversion, navigation, or runtime disposal happens on relocation. */
export function canSwapWorkspaceColumnContent(): boolean {
  const work = useWorkColumnStore.getState();
  const browser = useBrowserColumnStore.getState();
  return browser.visible && work.navigation.phase !== 'loading' && work.notebookSwitchesInFlight === 0;
}

export async function swapWorkspaceColumnContent(): Promise<boolean> {
  if (!canSwapWorkspaceColumnContent()) return false;
  const placement = useWorkspaceSessionStore.getState();
  return placement.swap(placement.revision);
}
