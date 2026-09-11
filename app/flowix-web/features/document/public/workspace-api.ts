import { useDocumentStore } from '@features/document/store/document-store';
import type {
  ExternalDocumentSession,
  MemoDocumentSession,
} from '@features/document/store/document-store';
import {
  useDocumentHistoryStore,
  type ArtifactHistoryEntry,
  type DocumentHistoryEntry,
} from '@features/document/store/document-history-store';
import { flushDocumentPath } from '@features/document/store/document-session-service';

type DocumentState = ReturnType<typeof useDocumentStore.getState>;

/**
 * Document capabilities used by workspace navigation.
 *
 * Keep this contract narrower than DocumentStore: workspace owns placement and
 * navigation transactions, while document owns session lifecycle and flushing.
 */
export type WorkspaceDocumentState = Pick<
  DocumentState,
  | 'activeMemoSession'
  | 'activeExternalSession'
  | 'activeAgentConversationId'
  | 'openMemoDocument'
  | 'openExternalDocument'
  | 'openAgentConversation'
  | 'closeAgentConversation'
  | 'clearDocument'
  | 'discardMemoDocument'
  | 'replaceActiveMemoPath'
>;

export function getWorkspaceDocumentState(): WorkspaceDocumentState {
  return useDocumentStore.getState();
}

export function pushWorkspaceDocumentHistory(entry: DocumentHistoryEntry): void {
  useDocumentHistoryStore.getState().pushBack(entry);
}

export async function flushWorkspaceDocumentPath(
  identity: { kind: 'memo'; id: string } | { kind: 'external'; path: string },
  path: string,
  scopePath?: string | null,
): Promise<boolean> {
  return flushDocumentPath(identity, path, scopePath);
}

export type {
  ArtifactHistoryEntry,
  DocumentHistoryEntry,
  ExternalDocumentSession,
  MemoDocumentSession,
};
