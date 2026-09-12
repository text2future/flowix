import type { AgentChunk } from "@/types/agent";
import { agent, listenToAgentStream } from "@platform/tauri/client";
import type { SubscribeOptions } from "@platform/tauri/event-bus";

export const agentClient = {
  chatStream: agent.chatStream,
  steerChat: agent.steerChat,
  executeDeepSeekHarnessCommand: agent.executeDeepSeekHarnessCommand,
  listDeepSeekHarnessSkills: agent.listDeepSeekHarnessSkills,
  stopChatStream: agent.stopChatStream,
  runningThreads: agent.runningThreads,
  backgroundTerminals: agent.backgroundTerminals,
  backgroundJobs: agent.backgroundJobs,
  externalEvents: agent.externalEvents,
  listThreads: agent.listThreads,
  listLocalAgentThreads: agent.listLocalAgentThreads,
  createThread: agent.createThread,
  getThread: agent.getThread,
  getThreadPage: agent.getThreadPage,
  listConversationInstances: agent.listConversationInstances,
  listConversationInstancesPage: agent.listConversationInstancesPage,
  listConversationTypeCountsByNotebook: agent.listConversationTypeCountsByNotebook,
  getConversationInstance: agent.getConversationInstance,
  findConversationByThread: agent.findConversationByThread,
  upsertConversationInstance: agent.upsertConversationInstance,
  deleteConversationInstance: agent.deleteConversationInstance,
  deleteConversationInstancesForThread: agent.deleteConversationInstancesForThread,
  listCodexThreads: agent.listCodexThreads,
  getCodexThread: agent.getCodexThread,
  getCodexThreadPage: agent.getCodexThreadPage,
  listClaudeThreads: agent.listClaudeThreads,
  getClaudeThread: agent.getClaudeThread,
  getClaudeThreadPage: agent.getClaudeThreadPage,
  listHermesThreads: agent.listHermesThreads,
  getHermesThread: agent.getHermesThread,
  getHermesThreadPage: agent.getHermesThreadPage,
  listDeepSeekHarnessThreads: agent.listDeepSeekHarnessThreads,
  getDeepSeekHarnessThread: agent.getDeepSeekHarnessThread,
  getDeepSeekHarnessThreadPage: agent.getDeepSeekHarnessThreadPage,
  listOpenCodeThreads: agent.listOpenCodeThreads,
  getOpenCodeThreadPage: agent.getOpenCodeThreadPage,
  deleteThread: agent.deleteThread,
  archiveAgentThread: agent.archiveAgentThread,
  deleteAgentThread: agent.deleteAgentThread,
  updateThreadTitle: agent.updateThreadTitle,
  executeCodexSlashCommand: agent.executeCodexSlashCommand,
};

/** Public dependency contract used by store slices and compile-checked test fakes. */
export type AgentClient = typeof agentClient;

export function listenToAgentChunks(
  callback: (chunk: AgentChunk) => void,
  options?: SubscribeOptions,
): ReturnType<typeof listenToAgentStream> {
  return listenToAgentStream(callback, options);
}
