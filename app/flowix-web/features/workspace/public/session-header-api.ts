import type { WorkspaceSessionId } from '../model/workspace-session';
import { useWorkspaceSessionStore } from '../store/workspace-session-store';

/** Header view state follows a session; platform geometry is supplied by the host. */
export function useSessionAddressBar(sessionId: WorkspaceSessionId, surfaceId: string | null) {
  const visible = useWorkspaceSessionStore((state) => surfaceId !== null
    && Boolean(state.sessions[sessionId].headerState[surfaceId]?.addressBarVisible));
  const toggle = surfaceId === null ? undefined : () => {
    useWorkspaceSessionStore.getState().setAddressBarVisible(sessionId, surfaceId, !visible);
  };
  return { visible, toggle };
}
