import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';

/** Resolve the notebook bound to this conversation, independent of global selection. */
export function getConversationNotebookId(
  instance: Pick<AgentConversationInstance, 'runtimeConfig' | 'source'> | null | undefined,
): string | null {
  const runtime = instance?.runtimeConfig;
  return runtime?.notebookId
    ?? runtime?.workspaceState?.desired.notebookId
    ?? runtime?.workspaceSnapshot?.notebookId
    ?? instance?.source.notebookId
    ?? null;
}
