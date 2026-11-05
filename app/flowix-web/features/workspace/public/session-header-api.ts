import { getSessionId } from '../store/workspace-session-store';
import { sessionFor } from '../model/workspace-session';
import type { WorkspaceSessionReference } from '../model/workspace-session';
import { useWorkspaceSessionStore } from '../store/workspace-session-store';

/** Header view state follows a session; platform geometry is supplied by the host. */
export function useSessionAddressBar(reference: WorkspaceSessionReference, surfaceId: string | null) {
  const sessionId = useWorkspaceSessionStore((state) => sessionFor(state, reference).id);
  const visible = useWorkspaceSessionStore((state) => surfaceId !== null
    && Boolean(sessionFor(state, sessionId).headerState[surfaceId]?.addressBarVisible));
  const toggle = surfaceId === null ? undefined : () => {
    useWorkspaceSessionStore.getState().setAddressBarVisible(getSessionId(sessionId), surfaceId, !visible);
  };
  return { visible, toggle };
}
