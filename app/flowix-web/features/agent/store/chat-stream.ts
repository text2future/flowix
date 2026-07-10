import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentPermissionMode,
  AgentTypeKey,
} from "@/types/agent";
import { buildAgentRuntimeConfig } from "@features/agent/runtime/agent-runtime-spec";
import { agentClient } from "@features/agent/store/agent-client";
import type { OutgoingUserPayload } from "@features/agent/store/user-message";

export interface DispatchChatStreamArgs {
  threadId: string;
  content: string;
  llmContent: string;
  runId: string;
  userPayload: OutgoingUserPayload;
  agentType: AgentTypeKey;
  permissionMode: AgentPermissionMode;
  codexModel: AgentCodexModel;
  codexReasoningEffort: AgentCodexReasoningEffort;
  agentRoleMemoId?: string;
  agentRoleName?: string;
}

/**
 * 触发后端 `chat_stream` IPC ── fire-and-forget, 立刻返回, 后端错误/完成
 * 信号全走 `agent-chunk` 事件流, 由 dispatchAgentChunk / run-lifecycle 收敛。
 *
 * 真正的"错误捕获"留给 caller ── 这层只把 err 抛给 await 处, 让
 * send-message.ts 上的 try / catch 看到 IPC spawn 失败这种罕见情形
 * (正常情况下 chat_stream 是 Ok(()) 立即返回, 不会 throw)。
 */
export async function dispatchChatStream({
  threadId,
  content,
  llmContent,
  runId,
  userPayload,
  agentType,
  permissionMode,
  codexModel,
  codexReasoningEffort,
  agentRoleMemoId,
  agentRoleName,
}: DispatchChatStreamArgs): Promise<void> {
  const runtimeConfig = buildAgentRuntimeConfig({
    typeKey: agentType,
    cwd: userPayload.systemReminderDirectory,
    permissionMode,
    codexModel,
    codexReasoningEffort,
  });
  await agentClient.chatStream(threadId, {
    content,
    llmContent,
    runId,
    systemReminderDirectory: userPayload.systemReminderDirectory,
    systemReminderDocumentPath: userPayload.systemReminderDocumentPath,
    agentType,
    runtimeConfig,
    agentRoleMemoId,
    agentRoleName,
  });
}
