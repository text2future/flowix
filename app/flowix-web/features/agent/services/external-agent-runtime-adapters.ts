import { agent } from '@platform/tauri/client';
import type { AgentTypeKey } from '@/types/agent';

export type ExternalAgentTypeKey = Extract<AgentTypeKey, 'codex' | 'claude' | 'hermes'>;

export interface ExternalAgentRuntimeAdapter {
  readonly typeKey: ExternalAgentTypeKey;
  createPendingThreadId(sequence: number, now?: number): string;
  isLocalThreadId(threadId: string): boolean;
  resolveSessionId(threadId: string): Promise<string | null>;
}

function createPrefixRuntimeAdapter(
  typeKey: ExternalAgentTypeKey,
  resolveSessionId: (threadId: string) => Promise<string | null>
): ExternalAgentRuntimeAdapter {
  return {
    typeKey,
    createPendingThreadId(sequence, now = Date.now()) {
      return `${typeKey}-pending-${now}-${sequence}`;
    },
    isLocalThreadId(threadId) {
      return threadId.startsWith(`${typeKey}-local-`) ||
        threadId.startsWith(`${typeKey}-pending-`);
    },
    resolveSessionId,
  };
}

const externalAgentRuntimeAdapters: Record<ExternalAgentTypeKey, ExternalAgentRuntimeAdapter> = {
  codex: createPrefixRuntimeAdapter('codex', (threadId) => agent.getCodexSessionId(threadId)),
  claude: createPrefixRuntimeAdapter('claude', (threadId) => agent.getClaudeSessionId(threadId)),
  hermes: createPrefixRuntimeAdapter('hermes', (threadId) => agent.getHermesSessionId(threadId)),
};

export function getExternalAgentRuntimeAdapter(
  typeKey: AgentTypeKey
): ExternalAgentRuntimeAdapter | null {
  if (typeKey === 'codex' || typeKey === 'claude' || typeKey === 'hermes') {
    return externalAgentRuntimeAdapters[typeKey];
  }
  return null;
}
