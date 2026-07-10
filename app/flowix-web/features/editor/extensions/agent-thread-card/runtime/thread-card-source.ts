import { useDocumentStore } from "@features/document";
import type { AgentConversationSource } from "@features/agent/store/agent-conversation-store";

export function getCurrentThreadCardSource(): AgentConversationSource {
  const documentState = useDocumentStore.getState();
  if (documentState.currentDocumentSource === "memo") {
    const session = documentState.activeMemoSession;
    return {
      kind: "thread-card",
      documentPath: session?.path ?? documentState.currentDocumentPath ?? null,
      memoId: session?.memoId ?? null,
    };
  }
  if (documentState.currentDocumentSource === "external") {
    return {
      kind: "thread-card",
      documentPath: documentState.currentDocumentPath ?? null,
      memoId: null,
    };
  }
  return { kind: "thread-card" };
}
