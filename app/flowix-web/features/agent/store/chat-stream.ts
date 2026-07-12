import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentPermissionMode,
  AgentTypeKey,
  RuntimeConfig,
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
  /**
   * Per-thread 配置快照（in-memory 的 lazy patch）── Phase 3 懒写载体。
   * 由 caller 从 `chat-store.threadRuntimeConfig[tid]` 取出, 序列化为 JSON
   * 字符串随 IPC 一并发送, 后端 chat_stream 入口 upsert 到
   * `threads.runtime_config` 列。未传 / undefined = 不携带（视为未改动）。
   */
  threadRuntimeConfig?: RuntimeConfig;
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
  threadRuntimeConfig,
}: DispatchChatStreamArgs): Promise<void> {
  const runtimeConfig = buildAgentRuntimeConfig({
    typeKey: agentType,
    cwd: userPayload.systemReminderDirectory,
    permissionMode,
    codexModel,
    codexReasoningEffort,
  });
  // 仅当有非空配置才序列化携带 ── 控件未改动时不要塞空对象, 后端 upsert
  // 会把已有持久态覆盖成 `{}`, 等于"清空 thread 配置", 与用户意图不符。
  const threadRuntimeConfigJson =
    threadRuntimeConfig && Object.keys(threadRuntimeConfig).length > 0
      ? JSON.stringify(threadRuntimeConfig)
      : undefined;
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
    threadRuntimeConfig: threadRuntimeConfigJson,
  });
}
