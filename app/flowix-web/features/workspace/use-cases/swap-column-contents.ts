import { canSwapSessions } from '../model/column-swap';
import { useWorkspaceSessionStore } from '../store/workspace-session-store';

/** Exchanges session placement; session objects and their identities stay intact. */
export function canSwapColumnContents(): boolean {
  const { sessions } = useWorkspaceSessionStore.getState();
  return canSwapSessions(sessions);
}

export function swapColumnContents(): boolean {
  if (!canSwapColumnContents()) return false;
  const store = useWorkspaceSessionStore.getState();
  store.setBrowserLayout({ visible: true });
  store.swapColumnContents();
  return true;
}
