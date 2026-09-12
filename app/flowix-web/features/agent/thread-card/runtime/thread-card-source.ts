import { useDocumentStore } from "@features/document";
import { useMemoStore } from "@features/memo";
import type { AgentConversationSource } from "@features/agent/store/agent-conversation-types";

export function getCurrentThreadCardSource(): AgentConversationSource {
  const documentState = useDocumentStore.getState();
  if (documentState.currentDocumentSource === "memo") {
    const session = documentState.activeMemoSession;
    // A newly created note can mount its editor before its memo session is
    // fully populated. Its card still belongs to the currently selected
    // notebook, never to the global/unassigned conversation bucket.
    const notebookId = session?.notebookId ?? useMemoStore.getState().selectedNotebook?.id ?? null;
    return {
      kind: "thread-card",
      documentPath: session?.path ?? documentState.currentDocumentPath ?? null,
      memoId: session?.memoId ?? null,
      notebookId,
    };
  }
  if (documentState.currentDocumentSource === "external") {
    return {
      kind: "thread-card",
      documentPath: documentState.currentDocumentPath ?? null,
      memoId: null,
      notebookId: null,
    };
  }
  return { kind: "thread-card" };
}
