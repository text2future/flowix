import { agent } from '@platform/tauri/client';

export { AgentIcon } from '@features/agent/components/agent-icon';

export function getLocalAgentRuntimeStatus() {
  return agent.runtimeStatus();
}

