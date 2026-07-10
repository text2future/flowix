import type { ChatMessage } from "@/types";
import type {
  AgentEvent,
  AgentTypeKey,
} from "@/types/agent";
import {
  appendFirstMessageContext,
  buildUserLlmContent,
} from "@features/agent/store/context-block";
import { applyRunStarted } from "@features/agent/store/run-lifecycle";
import type { ThreadState } from "@features/agent/store/chat-store";

export interface OutgoingUserPayload {
  llmContent: string;
  systemReminderDirectory?: string;
  systemReminderDocumentPath?: string;
}

export interface PreparedUserMessage {
  userPayload: OutgoingUserPayload;
  llmContent: string;
  userMessage: ChatMessage;
}

export interface PrepareUserMessageOptions {
  content: string;
  isFirstMessage: boolean;
  agentType: AgentTypeKey;
  currentNoteContent?: string;
  agentRoleMemoId?: string;
  agentRoleName?: string;
  agentRoleBody?: string | null;
}

/**
 * 把"用户键入文字 + 上下文元数据"装成一条 outgoing user message ── LLM
 * 实际看到的 `llmContent` 可能额外拼了首条消息上下文 (Role memo 内容 /
 * current note 摘要), 与 `userMessage.content` 同值。
 *
 * 注意 `llmContent` 与 `userPayload.llmContent` 同值, 但 dispatched 的 IPC
 * 需要 `userPayload` 携带 system-reminder 路径字段 (cwd 等等), 因此
 * 同时返回两个 ── caller 决定给后端发哪个版本。
 */
export function prepareUserMessage({
  content,
  isFirstMessage,
  agentType,
  currentNoteContent,
  agentRoleMemoId,
  agentRoleName,
  agentRoleBody,
}: PrepareUserMessageOptions): PreparedUserMessage {
  const userPayload = buildUserLlmContent(content);
  const llmContent = appendFirstMessageContext(
    userPayload.llmContent,
    isFirstMessage,
    currentNoteContent,
    agentType,
    agentRoleMemoId,
    agentRoleName,
    agentRoleBody ?? null,
  );
  return {
    userPayload,
    llmContent,
    userMessage: {
      id: `user-${Date.now()}`,
      role: "user",
      content: llmContent,
      llmContent,
      systemReminderDirectory: userPayload.systemReminderDirectory,
      systemReminderDocumentPath: userPayload.systemReminderDocumentPath,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * "乐观"地把 user message 推进 thread state ── 与后端 IPC 触发并行。
 * `applyRunStarted` 建 active run, 紧接在 messages 末尾 append user message。
 *
 * 这里不写 `isLoading` 由 stream_start chunk 收敛 ── 比直接 set=true 更
 * 准确, 避免后端未实际启动时 UI 已经显示"运行中"。
 */
export function applyOptimisticUserRun(
  st: ThreadState,
  event: AgentEvent,
  userMessage: ChatMessage,
): ThreadState {
  return {
    ...applyRunStarted(st, event),
    messages: [...st.messages, userMessage],
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}

/**
 * IPC 自身抛错 (后端 spawn 失败 / 命令未注册) 时构造一条 assistant
 * 错误卡片 ── 不同于流式 error chunk (那条是后端通过 stream 发回来的)。
 * 这里不进 chunk 路径, 直接 append 到 messages。
 */
export function createSendErrorMessage(
  err: unknown,
  fallback: string,
): ChatMessage {
  return {
    id: `error-${Date.now()}`,
    role: "assistant",
    content: typeof err === "string" && err ? err : fallback,
    timestamp: new Date().toISOString(),
  };
}
