import { appendAdjacentContentContext } from "@features/agent/store/adjacent-document-context";
import type { AdjacentContent } from "@features/workspace/public/adjacent-content-api";
import type { ChatMessage } from "@/types";
import type {
  AgentMessageAttachment,
  AgentTypeKey,
} from "@/types/agent";
import {
  appendFirstMessageContext,
  buildUserLlmContent,
} from "@features/agent/store/context-block";

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
  displayContent?: string;
  isFirstMessage: boolean;
  agentType: AgentTypeKey;
  currentNoteContent?: string;
  adjacentContent?: AdjacentContent;
  systemReminderDirectory?: string;
  attachments?: AgentMessageAttachment[];
}

type AgentMessageAttachmentSource = Pick<AgentMessageAttachment, "path" | "name" | "mimeType">;

function attachmentMimeType(path: string): string {
  const extension = path.split(/[\\/]/u).pop()?.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "png":
    default:
      return "image/png";
  }
}

/** Build image display metadata from cached paths or their existing metadata. */
export function createAgentMessageAttachments(
  attachments: readonly (string | AgentMessageAttachmentSource)[] | undefined,
): AgentMessageAttachment[] {
  return (attachments ?? []).map((attachment, index) => {
    const path = typeof attachment === "string" ? attachment : attachment.path;
    const name = typeof attachment === "string"
      ? path.split(/[\\/]/u).pop() || `image-${index + 1}`
      : attachment.name;
    return {
      type: "input_image",
      path,
      name,
      mimeType: typeof attachment === "string" ? attachmentMimeType(path) : attachment.mimeType,
      detail: "high",
    };
  });
}

/**
 * 把"用户键入文字 + 上下文元数据"装成一条 outgoing user message ── LLM
 * 实际看到的 `llmContent` 可能额外拼了首条消息的当前笔记摘要，
 * 但 `userMessage.content` 只保存消息列表的展示文本（可含附件位置标记），
 * 避免把内部 workspace/CLI 指令渲染到消息列表；推理始终使用独立的 llmContent。
 *
 * 注意 `llmContent` 与 `userPayload.llmContent` 同值, 但 dispatched 的 IPC
 * 需要 `userPayload` 携带 system-reminder 路径字段 (cwd 等等), 因此
 * 同时返回两个 ── caller 决定给后端发哪个版本。
 */
export function prepareUserMessage({
  content,
  displayContent,
  isFirstMessage,
  agentType,
  currentNoteContent,
  adjacentContent,
  systemReminderDirectory,
  attachments,
}: PrepareUserMessageOptions): PreparedUserMessage {
  const userPayload = buildUserLlmContent(content, systemReminderDirectory);
  const llmContent = appendAdjacentContentContext(appendFirstMessageContext(
    userPayload.llmContent,
    isFirstMessage,
    currentNoteContent,
    agentType,
  ), adjacentContent);
  return {
    userPayload,
    llmContent,
    userMessage: {
      id: `user-${Date.now()}`,
      role: "user",
      content: displayContent ?? content,
      attachments: attachments?.length ? attachments : undefined,
      llmContent,
      systemReminderDirectory: userPayload.systemReminderDirectory,
      systemReminderDocumentPath: userPayload.systemReminderDocumentPath,
      timestamp: new Date().toISOString(),
    },
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
