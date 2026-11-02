import { useWorkspaceSessionStore } from './session-api';
/** Workspace surface state consumed by the agent task panel. */
import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import type { WorkspaceSurfaceHost } from '../model/surface-contract';
import { pickFocusedHostValue } from '../model/focused-host-value';

/**
 * The agent conversation currently on screen, or null when neither visible
 * surface is showing one. The conversation can live in the work column or in
 * the Browser column (the lists default conversations to Browser), so the
 * focused host decides when both show a different conversation.
 */
export function resolveActiveAgentConversationInstanceId(input: {
  focusedHostId: WorkspaceSurfaceHost;
  workInstanceId: string | null;
  browserInstanceId: string | null;
}): string | null {
  return pickFocusedHostValue({
    focusedHostId: input.focusedHostId,
    work: input.workInstanceId,
    browser: input.browserInstanceId,
  });
}

/**
 * Used to highlight the row the user is already reading without exposing the
 * whole navigation model.
 */
export function useActiveAgentConversationInstanceId(): string | null {
  const primaryAtWork = useWorkspaceSessionStore((state) => state.hosts['main-third'] === 'primary-session');
  const visible = useBrowserColumnStore((state) => state.visible);
  const workInstanceId = useWorkColumnStore((state) => (
    state.navigation.target.kind === 'agent-conversation'
      ? state.navigation.target.instanceId
      : null
  ));
  // A hidden Browser column keeps its last entry; it is not on screen then.
  const browserInstanceId = useBrowserColumnStore((state) => (
    state.current?.target.kind === 'agent_conversation'
      ? state.current.target.instanceId
      : null
  ));
  const focusedHostId = useWorkspaceFocusStore((state) => state.focusedHostId);
  return resolveActiveAgentConversationInstanceId({ focusedHostId, workInstanceId: primaryAtWork || visible ? workInstanceId : null, browserInstanceId: !primaryAtWork || visible ? browserInstanceId : null });
}
