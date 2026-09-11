import { restoreAgentConversationWorkspace as restore } from '@features/workspace/use-cases/agent-conversation-navigation';

/** Application bootstrap contract; keeps startup imports isolated from the use-case module graph. */
export async function restoreAgentConversationWorkspace(): Promise<void> {
  await restore();
}
