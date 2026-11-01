export { useNewConversationAgentSelection } from '@features/agent/hooks/use-new-conversation-agent-selection';
export { AgentConversationTitlebar } from '@features/agent/components/agent-conversation-titlebar';
export { AgentConversationIdentity } from '@features/agent/components/agent-conversation-identity';
export { AgentConversationMoreMenu } from '@features/agent/components/agent-conversation-more-menu';
export { AgentConversationList } from '@features/agent/components/agent-conversation-list';
export { AgentConversationStatusBar } from '@features/agent/components/agent-conversation-status-bar';
export { AgentIcon } from '@features/agent/components/agent-icon';
export { AgentTasksSection } from '@features/agent/components/agent-tasks-section';

import { useAgentSessionStore } from '@features/agent/store/agent-session-store';

export { isAgentRuntimeInstalledState, normalizeAgentRuntimeStatus } from '@features/agent/runtime/agent-runtime-status';
export {
  createAndOpenAgentConversation,
  createAndOpenAgentConversationWithPrompt,
  createAndOpenPiConversation,
  createBrowserColumnAgentConversation,
  discardUnopenedBrowserColumnAgentConversation,
  listSelectableAgentTypes,
  requestNewConversationAgentSelection,
} from '@features/agent/use-cases/new-conversation';

export function useBrowserColumnAgentHeaderModel() {
  const conversationInstances = useAgentSessionStore((state) => state.conversationRegistry.instances);
  return { conversationInstances };
}
