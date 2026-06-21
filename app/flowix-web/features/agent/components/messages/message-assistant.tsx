import { memo } from "react";
import type { ChatMessage as ChatMessageType } from "@/types";
import {
  getAgentMessageVisibleContent,
  shouldRenderAgentMessage,
} from "@features/agent/message/agent-message";
import { MarkdownRenderer } from "@features/agent/components/messages/markdown-renderer";

interface MessageAssistantProps {
  message: ChatMessageType;
}

function MessageAssistantInner({ message }: MessageAssistantProps) {
  if (!shouldRenderAgentMessage(message)) {
    return null;
  }
  const visibleContent = getAgentMessageVisibleContent(message);

  return (
    <div className="flex gap-3">
      <div className="flex flex-col gap-1 w-full">
        <div className="text-sm text-[var(--agent-foreground)] mt-1">
          <MarkdownRenderer content={visibleContent} />
        </div>
      </div>
    </div>
  );
}

// Layer 1: memo 保险层. 外层 ChatMessage 已 memo, 但 MessageAssistant 也可能
// 被其它地方直接复用 (chat-message.tsx 字典分发外). content 不变则跳过 ──
// 与 MarkdownRenderer 自身的 memo 形成两层保护.
export const MessageAssistant = memo(
  MessageAssistantInner,
  (prev, next) =>
    prev.message === next.message ||
    (prev.message.id === next.message.id &&
      prev.message.content === next.message.content &&
      prev.message.role === next.message.role)
);
