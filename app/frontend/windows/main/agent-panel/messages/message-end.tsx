import type { ChatMessage as ChatMessageType } from "../../../../types";
import "../../../../css/agent-message.css";

interface MessageEndProps {
  message: ChatMessageType;
}

export function MessageEnd({ message }: MessageEndProps) {
  const time = message.timestamp
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(message.timestamp))
    : new Date().toLocaleTimeString();

  return (
    <div className="flex gap-3">
      <div className="flex flex-col gap-1 w-full">
        <div className="text-xs text-[var(--muted-foreground)] text-center">
          {message.content || time}
        </div>
      </div>
    </div>
  );
}