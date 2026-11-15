/** A surface reference inserted into a newly opened conversation composer. */
export type AgentConversationReference =
  | {
      kind: 'note';
      notebookId: string;
      relativePath: string;
      filename: string;
      title: string;
    }
  | {
      kind: 'file';
      path: string;
      displayName: string;
    }
  | {
      kind: 'collection';
      notebookId: string;
      collectionId: string | null;
      collectionPath: string;
      indexPath: string | null;
      displayName: string;
      supportsNotes?: boolean;
    };

export type PendingAgentConversationInitialContent =
  | { kind: 'prompt'; prompt: string; autoSend: boolean }
  | { kind: 'reference'; reference: AgentConversationReference };
