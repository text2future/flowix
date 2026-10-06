import type { ChatMessage, ThreadListItem } from "@/types";
import type { AgentTypeKey } from "@/types/agent";
import { agentClient } from "@features/agent/store/agent-client";
import { pagePiHistory, parsePiHistoryMessages } from "@features/agent/runtime/pi-history";

export interface ThreadHistoryPage {
  messages: ChatMessage[];
  oldestSequence: number | null;
  hasMore: boolean;
  /** Pins subsequent pages to the same provider/journal snapshot when supported. */
  snapshotSequence?: number | null;
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
    snapshotSequence?: number | null,
  ): Promise<ThreadHistoryPage>;
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
    getPage: (threadId, beforeSequence, limit, snapshotSequence) =>
      agentClient.getCodexThreadPage(
        threadId,
        beforeSequence,
        limit,
        snapshotSequence,
      ),
  };
}

function createClaudeHistoryAdapter(): AgentHistoryAdapter {
  return {
    typeKey: "claude",
    externalSessionBacked: true,
    listThreads: () => agentClient.listClaudeThreads(),
    async getFullHistory(threadId) {
      return (await agentClient.getClaudeThreadPage(threadId, null, 50)).messages;
    },
    getInitialHistory: (threadId, limit) =>
      agentClient.getClaudeThreadPage(threadId, null, limit),
    getPage: (threadId, beforeSequence, limit, snapshotSequence) =>
      agentClient.getClaudeThreadPage(
        threadId,
        beforeSequence,
        limit,
        snapshotSequence,
      ),
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
    getPage: (threadId, beforeSequence, limit, snapshotSequence) =>
      agentClient.getHermesThreadPage(
        threadId,
        beforeSequence,
        limit,
        snapshotSequence,
      ),
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

function createOpenCodeHistoryAdapter(): AgentHistoryAdapter {
  return {
    typeKey: "opencode",
    externalSessionBacked: true,
    listThreads: () => agentClient.listOpenCodeThreads(),
    async getFullHistory(threadId) {
      return (await agentClient.getOpenCodeThreadPage(threadId, null, 50)).messages;
    },
    getInitialHistory: (threadId, limit) =>
      agentClient.getOpenCodeThreadPage(threadId, null, limit),
    getPage: (threadId, beforeSequence, limit, snapshotSequence) =>
      agentClient.getOpenCodeThreadPage(
        threadId,
        beforeSequence,
        limit,
        snapshotSequence,
      ),
  };
}

function createPiHistoryAdapter(): AgentHistoryAdapter {
  const readMessages = async (threadId: string) =>
    parsePiHistoryMessages(threadId, await agentClient.getPiSessionMessages(threadId));
  return {
    typeKey: "pi",
    externalSessionBacked: true,
    listThreads: () => agentClient.listPiThreads(),
    getFullHistory: readMessages,
    async getInitialHistory(threadId, limit) {
      return pagePiHistory(await readMessages(threadId), null, limit);
    },
    async getPage(threadId, beforeSequence, limit, snapshotSequence) {
      return pagePiHistory(
        await readMessages(threadId),
        beforeSequence,
        limit,
        snapshotSequence,
      );
    },
  };
}

function createDeepSeekHarnessHistoryAdapter(): AgentHistoryAdapter {
  return {
    typeKey: "deepseek-harness",
    externalSessionBacked: true,
    listThreads: () => agentClient.listDeepSeekHarnessThreads(),
    async getFullHistory(threadId) {
      return (await agentClient.getDeepSeekHarnessThread(threadId)).messages;
    },
    getInitialHistory: (threadId, limit) =>
      agentClient.getDeepSeekHarnessThreadPage(threadId, null, limit),
    getPage: (threadId, beforeSequence, limit, snapshotSequence) =>
      agentClient.getDeepSeekHarnessThreadPage(
        threadId,
        beforeSequence,
        limit,
        snapshotSequence,
      ),
  };
}

const historyAdapters: Partial<Record<AgentTypeKey, AgentHistoryAdapter>> = {
  // Codex history is projected by the backend from Codex App Server threads.
  codex: createCodexHistoryAdapter(),
  pi: createPiHistoryAdapter(),
  claude: createClaudeHistoryAdapter(),
  hermes: createHermesHistoryAdapter(),
  // OpenCode 的唯一历史源是紧凑的 agent_external_events。后端以完整用户
  // 回合分页并将 snapshot events 物化为消息，前端不重放流式 delta。
  opencode: createOpenCodeHistoryAdapter(),
  "deepseek-harness": createDeepSeekHarnessHistoryAdapter(),
};

export function getAgentHistoryAdapter(typeKey: AgentTypeKey): AgentHistoryAdapter {
  return historyAdapters[typeKey] ?? createLocalAgentHistoryAdapter(typeKey);
}
