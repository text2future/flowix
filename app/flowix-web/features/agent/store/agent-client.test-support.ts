import { vi } from "vitest";
import type { AgentClient } from "./agent-client";

/**
 * Complete, safe-default Agent client fake.
 *
 * The explicit object intentionally satisfies the production contract: adding
 * a method to AgentClient makes this helper fail type-checking until the new
 * behavior receives a deliberate test default.
 */
export function createAgentClientMock(
  overrides: Partial<AgentClient> = {},
): AgentClient {
  const defaults = {
    chatStream: vi.fn<AgentClient["chatStream"]>().mockResolvedValue({ response: "" }),
    steerChat: vi.fn<AgentClient["steerChat"]>().mockResolvedValue(undefined),
    executeDeepSeekHarnessCommand: vi.fn<AgentClient["executeDeepSeekHarnessCommand"]>().mockResolvedValue({}),
    listDeepSeekHarnessSkills: vi.fn<AgentClient["listDeepSeekHarnessSkills"]>().mockResolvedValue({ skills: [] }),
    stopChatStream: vi.fn<AgentClient["stopChatStream"]>().mockResolvedValue(true),
    runningThreads: vi.fn<AgentClient["runningThreads"]>().mockResolvedValue({}),
    backgroundTerminals: vi.fn<AgentClient["backgroundTerminals"]>().mockResolvedValue([]),
    backgroundJobs: vi.fn<AgentClient["backgroundJobs"]>().mockResolvedValue([]),
    externalEvents: vi.fn<AgentClient["externalEvents"]>().mockResolvedValue([]),
    listThreads: vi.fn<AgentClient["listThreads"]>().mockResolvedValue([]),
    listLocalAgentThreads: vi.fn<AgentClient["listLocalAgentThreads"]>().mockResolvedValue([]),
    createThread: vi.fn<AgentClient["createThread"]>().mockImplementation(async (title) => ({
      threadId: "thread-created",
      title,
      createdAt: 0,
      updatedAt: 0,
    })),
    getThread: vi.fn<AgentClient["getThread"]>().mockResolvedValue({ messages: [] }),
    getThreadPage: vi.fn<AgentClient["getThreadPage"]>().mockResolvedValue({
      messages: [], oldestSequence: null, hasMore: false,
    }),
    listConversationInstances: vi.fn<AgentClient["listConversationInstances"]>().mockResolvedValue([]),
    listConversationInstancesPage: vi.fn<AgentClient["listConversationInstancesPage"]>().mockResolvedValue({
      items: [], hasMore: false, nextCursor: null,
    }),
    listConversationTypeCountsByNotebook: vi.fn<AgentClient["listConversationTypeCountsByNotebook"]>().mockResolvedValue([]),
    getConversationInstance: vi.fn<AgentClient["getConversationInstance"]>().mockResolvedValue(null),
    findConversationByThread: vi.fn<AgentClient["findConversationByThread"]>().mockResolvedValue(null),
    upsertConversationInstance: vi.fn<AgentClient["upsertConversationInstance"]>().mockImplementation(
      async (instance) => ({ ...instance, threadTitle: instance.initialTitle }),
    ),
    deleteConversationInstance: vi.fn<AgentClient["deleteConversationInstance"]>().mockResolvedValue(true),
    deleteConversationInstancesForThread: vi.fn<AgentClient["deleteConversationInstancesForThread"]>().mockResolvedValue(0),
    listCodexThreads: vi.fn<AgentClient["listCodexThreads"]>().mockResolvedValue([]),
    getCodexThread: vi.fn<AgentClient["getCodexThread"]>().mockResolvedValue({ messages: [] }),
    getCodexThreadPage: vi.fn<AgentClient["getCodexThreadPage"]>().mockResolvedValue({
      messages: [], oldestSequence: null, hasMore: false,
    }),
    listClaudeThreads: vi.fn<AgentClient["listClaudeThreads"]>().mockResolvedValue([]),
    getClaudeThread: vi.fn<AgentClient["getClaudeThread"]>().mockResolvedValue({ messages: [] }),
    getClaudeThreadPage: vi.fn<AgentClient["getClaudeThreadPage"]>().mockResolvedValue({
      messages: [], oldestSequence: null, hasMore: false,
    }),
    listHermesThreads: vi.fn<AgentClient["listHermesThreads"]>().mockResolvedValue([]),
    getHermesThread: vi.fn<AgentClient["getHermesThread"]>().mockResolvedValue({ messages: [] }),
    getHermesThreadPage: vi.fn<AgentClient["getHermesThreadPage"]>().mockResolvedValue({
      messages: [], oldestSequence: null, hasMore: false,
    }),
    listDeepSeekHarnessThreads: vi.fn<AgentClient["listDeepSeekHarnessThreads"]>().mockResolvedValue([]),
    getDeepSeekHarnessThread: vi.fn<AgentClient["getDeepSeekHarnessThread"]>().mockResolvedValue({ messages: [] }),
    getDeepSeekHarnessThreadPage: vi.fn<AgentClient["getDeepSeekHarnessThreadPage"]>().mockResolvedValue({
      messages: [], oldestSequence: null, hasMore: false,
    }),
    listOpenCodeThreads: vi.fn<AgentClient["listOpenCodeThreads"]>().mockResolvedValue([]),
    getOpenCodeThreadPage: vi.fn<AgentClient["getOpenCodeThreadPage"]>().mockResolvedValue({
      messages: [], oldestSequence: null, hasMore: false,
    }),
    deleteThread: vi.fn<AgentClient["deleteThread"]>().mockResolvedValue(undefined),
    archiveAgentThread: vi.fn<AgentClient["archiveAgentThread"]>().mockResolvedValue({ provider: true }),
    deleteAgentThread: vi.fn<AgentClient["deleteAgentThread"]>().mockResolvedValue({ provider: true }),
    updateThreadTitle: vi.fn<AgentClient["updateThreadTitle"]>().mockResolvedValue(null),
    executeCodexSlashCommand: vi.fn<AgentClient["executeCodexSlashCommand"]>().mockResolvedValue({}),
  } satisfies AgentClient;
  return { ...defaults, ...overrides };
}
