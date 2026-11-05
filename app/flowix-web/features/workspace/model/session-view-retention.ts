import { SESSION_VIEW_STATE_LIMIT } from './session-limits';
import type { WorkspaceSession } from './workspace-session';

/** Keep only reachable views, favoring the current entry and recent writes. */
export function retainSessionViewStates(session: WorkspaceSession): WorkspaceSession {
  const navigation = session.navigation;
  const live = new Set([navigation.current, ...navigation.backStack, ...navigation.forwardStack]
    .flatMap((entry) => entry ? [entry.id] : []));
  const currentId = navigation.current?.id;
  const entries = Object.entries(session.viewStates).filter(([id]) => live.has(id) && id !== currentId);
  if (currentId && session.viewStates[currentId]) entries.push([currentId, session.viewStates[currentId]]);
  const retained = entries.slice(-SESSION_VIEW_STATE_LIMIT);
  if (retained.length === Object.keys(session.viewStates).length) return session;
  return { ...session, viewStates: Object.fromEntries(retained) };
}
