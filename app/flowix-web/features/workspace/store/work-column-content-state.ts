import type {
  ExternalDocumentSession,
  MemoDocumentSession,
} from '@features/document/public/workspace-api';
import { getWorkspaceDocumentState } from '@features/document/public/workspace-api';

import { useWorkColumnStore } from './work-column-store';
import type {
  WorkColumnNavigationFailure,
  WorkColumnNavigationState,
  WorkColumnTarget,
} from './work-column-target';

export type WorkColumnSession
  =
  | { kind: 'memo'; session: MemoDocumentSession }
  | { kind: 'external'; session: ExternalDocumentSession }
  | { kind: 'agent-conversation'; instanceId: string };

export type WorkColumnContentState
  =
  | { status: 'empty' }
  | { status: 'ready'; target: WorkColumnTarget; session: WorkColumnSession | null }
  | {
      status: 'transitioning';
      from: WorkColumnTarget;
      to: WorkColumnTarget;
      session: WorkColumnSession | null;
    }
  | {
      status: 'failed';
      target: WorkColumnTarget;
      attemptedTarget: WorkColumnTarget;
      session: WorkColumnSession | null;
      failure: WorkColumnNavigationFailure;
    };

interface WorkColumnDocumentSnapshot {
  activeMemoSession: MemoDocumentSession | null;
  activeExternalSession: ExternalDocumentSession | null;
  activeAgentConversationId: string | null;
}

function activeSession(document: WorkColumnDocumentSnapshot): WorkColumnSession | null {
  if (document.activeMemoSession) {
    return { kind: 'memo', session: document.activeMemoSession };
  }
  if (document.activeExternalSession) {
    return { kind: 'external', session: document.activeExternalSession };
  }
  if (document.activeAgentConversationId) {
    return { kind: 'agent-conversation', instanceId: document.activeAgentConversationId };
  }
  return null;
}

/**
 * Read model for workColumn content. Navigation owns target intent and
 * transaction status; DocumentStore owns loaded editable sessions.
 */
export function resolveWorkColumnContentState(
  navigation: WorkColumnNavigationState,
  document: WorkColumnDocumentSnapshot,
): WorkColumnContentState {
  const session = activeSession(document);

  if (navigation.phase === 'loading' && navigation.pendingTarget) {
    return {
      status: 'transitioning',
      from: navigation.target,
      to: navigation.pendingTarget,
      session,
    };
  }

  if (navigation.phase === 'failed' && navigation.pendingTarget && navigation.failure) {
    return {
      status: 'failed',
      target: navigation.target,
      attemptedTarget: navigation.pendingTarget,
      session,
      failure: navigation.failure,
    };
  }

  if (navigation.target.kind === 'empty' && !session) return { status: 'empty' };
  return { status: 'ready', target: navigation.target, session };
}

/** Imperative read entry for use-cases outside React rendering. */
export function getWorkColumnContentState(): WorkColumnContentState {
  return resolveWorkColumnContentState(
    useWorkColumnStore.getState().navigation,
    getWorkspaceDocumentState(),
  );
}
