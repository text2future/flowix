import type { ChatMessage, ThreadListItem } from "@/types";
import type { AgentTypeKey } from "@/types/agent";
import { agentClient } from "@features/agent/store/agent-client";

export interface ThreadHistoryPage {
  messages: ChatMessage[];
  oldestSequence: number | null;
  hasMore: boolean;
}

export interface AgentHistoryAdapter {
  readonly typeKey: AgentTypeKey;
  readonly externalSessionBacked?: boolean;
  listThreads(): Promise<ThreadListItem[]>;
  getInitialHistory(threadId: string, limit: number): Promise<ThreadHistoryPage>;
  getFullHistory(threadId: string): Promise<ChatMessage[]>;
  getPage(
    threadId: string,
    beforeSequence: number | null,
    limit: number,
  ): Promise<ThreadHistoryPage>;
}

function emptyPage(messages: ChatMessage[]): ThreadHistoryPage {
  return {
    messages,
    oldestSequence: null,
    hasMore: false,
  };
}

function createFlowixHistoryAdapter(): AgentHistoryAdapter {
  return {
    typeKey: "flowix",
    listThreads: () => agentClient.listThreads(),
    async getFullHistory(threadId) {
      return (await agentClient.getThread(threadId)).messages;
    },
    getInitialHistory: (threadId, limit) =>
      agentClient.getThreadPage(threadId, null, limit),
    getPage: (threadId, beforeSequence, limit) =>
      agentClient.getThreadPage(threadId, beforeSequence, limit),
  };
}

function createCodexHistoryAdapter(): AgentHistoryAdapter {
  return {
    typeKey: "codex",
    externalSessionBacked: true,
    listThreads: () => agentClient.listCodexThreads(),
    async getFullHistory(threadId) {
      return (await agentClient.getCodexThread(threadId)).messages;
    },
    getInitialHistory: (threadId, limit) =>
      agentClient.getCodexThreadPage(threadId, null, limit),
    getPage: (threadId, beforeSequence, limit) =>
      agentClient.getCodexThreadPage(threadId, beforeSequence, limit),
  };
}

function createClaudeHistoryAdapter(): AgentHistoryAdapter {
  return {
    typeKey: "claude",
    externalSessionBacked: true,
    listThreads: () => agentClient.listClaudeThreads(),
    async getFullHistory(threadId) {
      return (await agentClient.getClaudeThread(threadId)).messages;
    },
    async getInitialHistory(threadId) {
      return emptyPage((await agentClient.getClaudeThread(threadId)).messages);
    },
    async getPage(threadId) {
      return emptyPage((await agentClient.getClaudeThread(threadId)).messages);
    },
  };
}

function createHermesHistoryAdapter(): AgentHistoryAdapter {
  return {
    typeKey: "hermes",
    externalSessionBacked: true,
    listThreads: () => agentClient.listHermesThreads(),
    async getFullHistory(threadId) {
      return (await agentClient.getHermesThread(threadId)).messages;
    },
    getInitialHistory: (threadId, limit) =>
      agentClient.getHermesThreadPage(threadId, null, limit),
    getPage: (threadId, beforeSequence, limit) =>
      agentClient.getHermesThreadPage(threadId, beforeSequence, limit),
  };
}

function createLocalAgentHistoryAdapter(typeKey: AgentTypeKey): AgentHistoryAdapter {
  return {
    typeKey,
    listThreads: () => agentClient.listLocalAgentThreads(typeKey),
    async getFullHistory(threadId) {
      return (await agentClient.getThread(threadId)).messages;
    },
    getInitialHistory: (threadId, limit) =>
      agentClient.getThreadPage(threadId, null, limit),
    getPage: (threadId, beforeSequence, limit) =>
      agentClient.getThreadPage(threadId, beforeSequence, limit),
  };
}

const historyAdapters: Partial<Record<AgentTypeKey, AgentHistoryAdapter>> = {
  flowix: createFlowixHistoryAdapter(),
  codex: createCodexHistoryAdapter(),
  claude: createClaudeHistoryAdapter(),
  hermes: createHermesHistoryAdapter(),
};

export function getAgentHistoryAdapter(typeKey: AgentTypeKey): AgentHistoryAdapter {
  return historyAdapters[typeKey] ?? createLocalAgentHistoryAdapter(typeKey);
}
