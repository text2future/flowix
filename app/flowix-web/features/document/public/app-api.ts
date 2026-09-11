import { useDocumentStore } from '@features/document/store/document-store';

export function subscribeAppActiveAgentConversation(
  listener: (instanceId: string | null) => void,
): () => void {
  let previousId = useDocumentStore.getState().activeAgentConversationId;
  return useDocumentStore.subscribe((state) => {
    const nextId = state.activeAgentConversationId;
    if (nextId === previousId) return;
    previousId = nextId;
    listener(nextId);
  });
}
