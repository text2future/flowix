import type { WorkspaceSessionId } from '../model/workspace-session';
import type { WorkspaceWebRuntime } from '../model/surface-contract';
import { useWorkspaceSessionStore } from './workspace-session-store';

/** A renderer owns one retained entry, irrespective of its current column. */
export function createSessionWebRuntimeChannel(sessionId: WorkspaceSessionId, entryId: string) {
  return {
    read: () => useWorkspaceSessionStore.getState().sessions[sessionId].viewStates[entryId]?.webRuntime ?? null,
    write: (runtime: WorkspaceWebRuntime) => {
      useWorkspaceSessionStore.getState().updateSession(sessionId, (session) => {
        const navigation = session.navigation;
        if (![navigation.current, ...navigation.backStack, ...navigation.forwardStack]
          .some((entry) => entry?.id === entryId && entry.target.kind === 'web')) return session;
        if (session.viewStates[entryId]?.webRuntime === runtime) return session;
        const current = navigation.current;
        const updateLocation = current?.id === entryId && current.target.kind === 'web'
          && current.target.url !== runtime.currentUrl;
        return { ...session,
          navigation: updateLocation ? { ...navigation,
            current: { ...current, target: { kind: 'web', url: runtime.currentUrl } } } : navigation,
          viewStates: Object.fromEntries([...Object.entries(session.viewStates).filter(([id]) => id !== entryId),
            [entryId, { ...session.viewStates[entryId], webRuntime: runtime }]]),
        };
      });
    },
  };
}
