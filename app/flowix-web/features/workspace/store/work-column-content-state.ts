import type { ExternalDocumentSession } from '@features/document/public/workspace-api';
import { getWorkspaceDocumentState } from '@features/document/public/workspace-api';

import { columnNavigation } from './column-navigation';
import { EMPTY_WORK_COLUMN_TARGET, type WorkColumnTarget } from './work-column-target';
import type { SessionNavigationState } from '../model/session-navigation';
import type { WorkColumnNavigationFailure } from './work-column-target';

export type WorkColumnSession
  =
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
  activeExternalSession: ExternalDocumentSession | null;
  activeAgentConversationId: string | null;
}

function activeSession(document: WorkColumnDocumentSnapshot): WorkColumnSession | null {
  if (document.activeExternalSession) {
    return { kind: 'external', session: document.activeExternalSession };
  }
  if (document.activeAgentConversationId) {
    return { kind: 'agent-conversation', instanceId: document.activeAgentConversationId };
  }
  return null;
}

/**
 * Read model for a column's content. The session owns target intent and
 * transaction status; DocumentStore owns loaded editable sessions.
 */
export function resolveWorkColumnContentState(
  navigation: SessionNavigationState,
  document: WorkColumnDocumentSnapshot,
): WorkColumnContentState {
  const session = activeSession(document);
  const target = navigation.current?.target ?? EMPTY_WORK_COLUMN_TARGET;
  const { transaction } = navigation;

  if (transaction.phase === 'loading' && transaction.pendingTarget) {
    return {
      status: 'transitioning',
      from: target,
      to: transaction.pendingTarget,
      session,
    };
  }

  if (transaction.phase === 'failed' && transaction.pendingTarget && transaction.failure) {
    return {
      status: 'failed',
      target,
      attemptedTarget: transaction.pendingTarget,
      session,
      failure: transaction.failure,
    };
  }

  if (target.kind === 'empty' && !session) return { status: 'empty' };
  return { status: 'ready', target, session };
}

/** Imperative read entry for use-cases outside React rendering. */
export function getWorkColumnContentState(): WorkColumnContentState {
  return resolveWorkColumnContentState(columnNavigation('column-1'), getWorkspaceDocumentState());
}
