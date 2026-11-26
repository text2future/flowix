import { resolveAgentPreferenceRuntimeConfig } from "./agent-user-preferences";
import type {
  AgentTypeKey,
  RuntimeConfig,
} from "@/types/agent";
import { buildAgentRuntimeConfig } from "@features/agent/runtime/agent-runtime-spec";
import { agentClient } from "@features/agent/store/agent-client";
import { ensureAgentPreferencesReady, useAgentDataStore } from "@features/agent/store/agent-data-store";
import { ensureAgentWorkspaceReady, useAgentWorkspaceStore } from "@features/agent/store/agent-workspace-store";
import type { OutgoingUserPayload } from "@features/agent/store/user-message";
import {
  markConversationWorkspaceStarted,
  normalizeWorkspaceSnapshot,
} from "@features/agent/runtime/workspace-snapshot";
import { normalizeConversationWorkspaceState } from "@features/agent/runtime/conversation-workspace";

export interface DispatchChatStreamArgs {
  threadId: string;
  instanceId?: string;
  content: string;
  displayContent?: string;
  llmContent: string;
  runId: string;
  userPayload: OutgoingUserPayload;
  agentType: AgentTypeKey;
  /** Runtime config snapshot from the conversation instance. */
  runtimeConfig?: RuntimeConfig;
  imagePaths?: string[];
  /** Product-owned title persisted before the runtime process starts. */
  conversationTitle?: string;
  onResolvedProvider?: (providerId: string | undefined) => void;
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
  instanceId,
  content,
  displayContent,
  llmContent,
  runId,
  userPayload,
  agentType,
  runtimeConfig: instanceRuntimeConfig,
  imagePaths,
  conversationTitle,
  onResolvedProvider,
}: DispatchChatStreamArgs): Promise<void> {
  await ensureAgentPreferencesReady(agentType);
  // Thread Card 首次运行前会冻结 workspaceSnapshot，后续 turn 只使用快照。
  // 没有快照的调用读取 local.db notebook add-dirs。
  const workspaceSnapshot =
    normalizeConversationWorkspaceState(instanceRuntimeConfig)?.desired ??
    normalizeWorkspaceSnapshot(instanceRuntimeConfig?.workspaceSnapshot);
  const notebookId = instanceRuntimeConfig?.notebookId;
  if (!workspaceSnapshot && notebookId) await ensureAgentWorkspaceReady();
  const userDefaults = useAgentDataStore.getState().agents;
  const defaultFiles = !workspaceSnapshot && notebookId
    ? useAgentWorkspaceStore.getState().workspaceActions.getNotebookFiles(notebookId)
    : undefined;
  const preferences = resolveAgentPreferenceRuntimeConfig(agentType, instanceRuntimeConfig);
  const runtimeConfig = buildAgentRuntimeConfig({
    typeKey: agentType,
    notebookPath: userPayload.systemReminderDirectory,
    permissionMode: preferences.access?.sandbox ?? "danger-full-access",
    codexModel: preferences.model?.key ?? "inherit",
    codexReasoningEffort: preferences.reasoningEffort ?? "medium",
    codexServiceTier: preferences.serviceTier,
    instanceRuntimeConfig: preferences,
    defaultFiles,
    piCodeMode: (userDefaults.pi.user.mode ?? "code") === "code",
    workspaceSnapshot,
  });
  onResolvedProvider?.(preferences.model?.providerId);
  if (instanceId) markConversationWorkspaceStarted(instanceId);
  await agentClient.chatStream(threadId, {
    content,
    displayContent,
    llmContent,
    runId,
    systemReminderDirectory: userPayload.systemReminderDirectory,
    systemReminderDocumentPath: userPayload.systemReminderDocumentPath,
    agentType,
    runtimeConfig,
    imagePaths,
    conversationTitle,
  });
}
