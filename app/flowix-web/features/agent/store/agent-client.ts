import type { AgentChunk } from "@/types/agent";
import { agent, listenToAgentStream } from "@platform/tauri/client";
import type { SubscribeOptions } from "@platform/tauri/event-bus";

export const agentClient = {
  chatStream: agent.chatStream,
  stopChatStream: agent.stopChatStream,
  runningThreads: agent.runningThreads,
  externalEvents: agent.externalEvents,
  listThreads: agent.listThreads,
  listLocalAgentThreads: agent.listLocalAgentThreads,
  createThread: agent.createThread,
  getThread: agent.getThread,
  getThreadPage: agent.getThreadPage,
  listConversationInstances: agent.listConversationInstances,
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
  listHermesThreads: agent.listHermesThreads,
  getHermesThread: agent.getHermesThread,
  getHermesThreadPage: agent.getHermesThreadPage,
  deleteThread: agent.deleteThread,
  updateThreadTitle: agent.updateThreadTitle,
};

export function listenToAgentChunks(
  callback: (chunk: AgentChunk) => void,
  options?: SubscribeOptions,
): ReturnType<typeof listenToAgentStream> {
  return listenToAgentStream(callback, options);
}
