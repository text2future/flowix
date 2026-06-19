import type { ChatMessage as ChatMessageType } from "../../../../types";
import { getAgentMessageVisibleContent } from "../../../../lib/message/agent-message";

interface MessageEndProps {
  message: ChatMessageType;
}

export function MessageEnd({ message }: MessageEndProps) {
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
