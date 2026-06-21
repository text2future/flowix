import { memo } from "react";
import type { ChatMessage as ChatMessageType } from "@/types";
import { getAgentMessageVisibleContent } from "@features/agent/message/agent-message";

interface MessageEndProps {
  message: ChatMessageType;
}

function MessageEndInner({ message }: MessageEndProps) {
  const visibleContent = getAgentMessageVisibleContent(message);

  return (
    <div className="flex gap-3">
      <div className="flex flex-col gap-1 w-full">
        <div className="text-xs text-[var(--muted-foreground)] text-center">
          {visibleContent}
        </div>
      </div>
    </div>
  );
}

// Layer 1: end 行只渲染纯文本, content 不变则跳过.
export const MessageEnd = memo(
  MessageEndInner,
  (prev, next) =>
    prev.message === next.message ||
    (prev.message.id === next.message.id &&
      prev.message.content === next.message.content)
);
