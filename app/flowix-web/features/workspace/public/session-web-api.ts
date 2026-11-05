import { useContext, useMemo, useState } from 'react';
import { SessionViewRecoveryContext } from './session-view-state-api';
import { getSessionId, useWorkspaceSessionStore } from '../store/workspace-session-store';
import { createSessionWebRuntimeChannel } from '../store/session-web-runtime';
import type { WorkspaceWebRuntime } from '../model/surface-contract';

export { createSessionWebRuntimeChannel } from '../store/session-web-runtime';

/** Workspace state belongs to the bound entry; standalone web views stay local. */
export function useSessionWebRuntime(initial: WorkspaceWebRuntime) {
  const scope = useContext(SessionViewRecoveryContext);
  const reference = scope?.sessionId;
  const entryId = scope?.entryId;
  const sessionId = useMemo(() => reference !== undefined ? getSessionId(reference) : null, [reference]);
  const channel = useMemo(() => sessionId && entryId
    ? createSessionWebRuntimeChannel(sessionId, entryId) : null, [sessionId, entryId]);
  const runtime = useWorkspaceSessionStore((state) => {
    if (!sessionId || !entryId) return null;
    return state.sessions[sessionId].viewStates[entryId]?.webRuntime ?? null;
  });
  const [local, setLocal] = useState(initial);
  return { runtime: channel ? runtime ?? initial : local, setRuntime: channel ? channel.write : setLocal };
}
