import type { ChatMessage as ChatMessageType } from "../../../../types";
import { isEmptyAssistantMessage } from "../../../../lib/message/empty";
import { MarkdownRenderer } from "./markdown-renderer";
import "../../../../css/agent-message.css";

interface MessageAssistantProps {
  message: ChatMessageType;
}

export function MessageAssistant({ message }: MessageAssistantProps) {
  if (isEmptyAssistantMessage(message)) {
    return null;
  }

  return (
    <div className="flex gap-3">
      <div className="flex flex-col gap-1 w-full">
        <div className="text-sm text-[var(--agent-text-primary)] mt-1 agent-message">
          <MarkdownRenderer content={message.content} />
        </div>
      </div>
    </div>
  );
}